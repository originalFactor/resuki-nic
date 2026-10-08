/**
 * Local stand-in for the services this app talks to, so the full flow can be
 * exercised without credentials:
 *
 *   /api/public-key   – Ed25519 verifier public key (ghssh contract)
 *   /cf/*             – Cloudflare API v4 subset (zones + dns_records)
 *   /gh/*             – GitHub API subset (users, contributors)
 *   /sign             – helper that produces a valid verifier envelope
 *
 * Run: node scripts/stub-services.mjs [port]
 */
import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.argv[2] ?? 3200);

/**
 * Deterministic fixture key: a fixed Ed25519 seed, so restarting the stub
 * keeps the same identity and does not invalidate the app's cached verifier
 * key mid-suite. The seed is public and obviously not a real credential.
 */
const FIXTURE_SEED = Buffer.from(
  Array.from({ length: 32 }, (_, index) => (index * 7 + 11) % 256),
);

const privateKey = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), FIXTURE_SEED]),
  format: "der",
  type: "pkcs8",
});
const publicKey = crypto
  .createPublicKey(privateKey)
  .export({ type: "spki", format: "pem" });

/**
 * One zone holds every delegation — matching the real setup, where
 * `verified.resukisu.org` and `contrib.resukisu.org` are not separate zones
 * (that would need Cloudflare's Enterprise-only subdomain setup).
 */
const ZONES = {
  "resukisu.org": { id: "zone-resukisu", name: "resukisu.org", status: "active" },
};

const records = new Map();
let recordSeq = 0;

const CONTRIBUTORS = {
  "Baka-SU/BakaSU": ["originalFactor", "OukaroMF"],
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function signEnvelope({ challengeCode, username }) {
  const issuedAt = new Date().toISOString();
  const payload = Buffer.from(JSON.stringify({ challengeCode, username, issuedAt })).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString("base64url");
  return {
    challengeCode,
    verified: true,
    verifier: { username, keyId: 4242, keyType: "Ed25519", totalKeys: 1 },
    signed: { algorithm: "ed25519", payload, signature, publicKeyPem: publicKey },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (path === "/api/public-key") {
    return json(res, 200, {
      algorithm: "ed25519",
      publicKeyPem: publicKey,
      verifyPayloadEncoding: "base64url(JSON)",
      verifySignatureEncoding: "base64url",
      payloadSchema: { challengeCode: "string", username: "string", issuedAt: "ISO-8601 string" },
    });
  }

  /**
   * The verifier's browser-facing page. It signs the challenge (in reality the
   * user runs ssh-keygen), POSTs the envelope to the caller's callback, then
   * redirects the browser to the redirect target — exactly the sequence
   * https://verify.resukisu.org performs.
   *
   * `username` query param stands in for the SSH key the user would use.
   */
  if (path === "/" && req.method === "GET") {
    const challengeCode = url.searchParams.get("challengecode") ?? "";
    const callbackUrl = url.searchParams.get("callback") ?? "";
    const redirectUrl = url.searchParams.get("redirect") ?? "";
    const username = url.searchParams.get("username") ?? "originalFactor";

    if (!challengeCode || !callbackUrl || !redirectUrl) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<h1>stub verifier: challengecode, callback and redirect are required</h1>");
    }

    const envelope = signEnvelope({ challengeCode, username });
    const callbackResponse = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const callbackBody = await callbackResponse.text();

    if (!callbackResponse.ok) {
      res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<h1>stub verifier: callback failed (${callbackResponse.status})</h1><pre>${callbackBody}</pre>`);
    }

    const target = new URL(redirectUrl);
    target.searchParams.set("challengecode", challengeCode);
    res.writeHead(302, { Location: target.toString() });
    return res.end();
  }

  if (path === "/sign" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!body.challengeCode || !body.username) {
      return json(res, 400, { error: "challengeCode and username are required" });
    }
    return json(res, 200, signEnvelope(body));
  }

  // ---- Cloudflare subset ----
  if (path.startsWith("/cf/")) {
    const suffix = path.slice(4);

    if (suffix === "user/tokens/verify") {
      return json(res, 200, { success: true, errors: [], messages: [], result: { id: "stub", status: "active" } });
    }

    if (suffix.startsWith("zones/") && suffix.endsWith("/dns_records")) {
      const zoneId = suffix.slice("zones/".length, -"/dns_records".length);
      const zone = Object.values(ZONES).find((entry) => entry.id === zoneId);
      if (!zone) {
        return json(res, 404, { success: false, errors: [{ code: 1049, message: "zone not found" }], messages: [], result: null });
      }

      if (req.method === "GET") {
        const type = url.searchParams.get("type");
        const name = url.searchParams.get("name");
        const all = [...records.values()].filter((record) => record.zone_id === zoneId);
        const filtered = all.filter(
          (record) => (!type || record.type === type) && (!name || record.name === name),
        );
        return json(res, 200, {
          success: true,
          errors: [],
          messages: [],
          result: filtered,
          result_info: { page: 1, per_page: 100, total_pages: 1, count: filtered.length },
        });
      }

      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        // Cloudflare rejects NS records that would duplicate an existing set.
        const clash = [...records.values()].find(
          (record) => record.zone_id === zoneId && record.name === body.name && record.type === body.type && record.content === body.content,
        );
        if (clash) {
          return json(res, 400, {
            success: false,
            errors: [{ code: 81057, message: "The record already exists." }],
            messages: [],
            result: null,
          });
        }
        for (const record of records.values()) {
          if (record.zone_id === zoneId && record.type === body.type && record.name === body.name && body.type !== "NS") {
            return json(res, 400, {
              success: false,
              errors: [{ code: 81058, message: `A ${body.type} record for ${body.name} already exists.` }],
              messages: [],
              result: null,
            });
          }
        }
        recordSeq += 1;
        const id = `rec-${recordSeq}`;
        const created = {
          id,
          zone_id: zoneId,
          zone_name: zone.name,
          type: body.type,
          name: body.name,
          content: body.content,
          ttl: body.ttl ?? 300,
          comment: body.comment ?? null,
        };
        records.set(id, created);
        return json(res, 200, { success: true, errors: [], messages: [], result: created });
      }
    }

    if (suffix.startsWith("zones/") && suffix.includes("/dns_records/") && req.method === "DELETE") {
      const id = suffix.split("/dns_records/")[1];
      if (!records.has(id)) {
        return json(res, 404, { success: false, errors: [{ code: 81044, message: "record not found" }], messages: [], result: null });
      }
      const deleted = records.get(id);
      records.delete(id);
      return json(res, 200, { success: true, errors: [], messages: [], result: { id: deleted.id } });
    }

    if (suffix === "zones" && req.method === "GET") {
      const name = url.searchParams.get("name");
      const match = name ? Object.values(ZONES).filter((zone) => zone.name === name) : [];
      return json(res, 200, { success: true, errors: [], messages: [], result: match });
    }

    return json(res, 404, { success: false, errors: [{ code: 7000, message: `unhandled cf path ${suffix}` }], messages: [], result: null });
  }

  // ---- GitHub subset ----
  if (path.startsWith("/gh/")) {
    const suffix = path.slice(4);

    const contributorsMatch = suffix.match(/^repos\/([^/]+\/[^/]+)\/contributors$/);
    if (contributorsMatch) {
      const repo = contributorsMatch[1];
      const logins = CONTRIBUTORS[repo] ?? [];
      const body = logins.map((login, index) => ({ login, id: index + 1, type: "User", contributions: 100 - index }));
      return json(res, 200, body);
    }

    const userMatch = suffix.match(/^users\/([^/]+)$/);
    if (userMatch) {
      const login = decodeURIComponent(userMatch[1]);
      const known = Object.values(CONTRIBUTORS).some((list) => list.includes(login));
      if (!known) {
        return json(res, 404, { message: "Not Found" });
      }
      return json(res, 200, { login, name: login, avatar_url: `https://example.com/${login}.png` });
    }

    return json(res, 404, { message: `unhandled gh path ${suffix}` });
  }

  if (path === "/__records" && req.method === "GET") {
    return json(res, 200, { records: [...records.values()] });
  }

  if (path === "/__records" && req.method === "DELETE") {
    const count = records.size;
    records.clear();
    return json(res, 200, { deleted: count });
  }

  return json(res, 404, { error: `no stub route for ${path}` });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`stub services listening on http://127.0.0.1:${port}`);
  console.log(`public key:\n${publicKey}`);
});
