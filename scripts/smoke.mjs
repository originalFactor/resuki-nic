/**
 * End-to-end smoke test of the login + registration flow.
 *
 * It drives a running instance of the app on BASE and expects the upstreams to
 * point at scripts/stub-services.mjs (which serves the ghssh public key, the
 * Cloudflare API subset, and a /sign helper that produces a valid verifier
 * envelope with a real Ed25519 signature).
 *
 * Usage:
 *   node scripts/stub-services.mjs 3200 &
 *   next dev -p 3100 &
 *   node scripts/smoke.mjs
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const STUB = process.env.STUB ?? "http://127.0.0.1:3200";

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) {
    failures += 1;
  }
};

/** Minimal cookie jar: the app sets httpOnly cookies we must replay by hand. */
function jarFrom(response) {
  return (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";")[0]);
}

function jarHeader(jar) {
  return jar.length > 0 ? { cookie: jar.join("; ") } : {};
}

const json = (response) => response.json();

/**
 * Runs the complete login flow for a given GitHub login: start, sign via the
 * stub verifier, callback, finalize. Returns the session cookies.
 */
async function loginAs(username) {
  const startRes = await fetch(`${BASE}/api/auth/start`, { method: "POST" });
  const start = await json(startRes);
  const flowJar = jarFrom(startRes);

  const published = await (await fetch(`${BASE}/api/auth/callback`)).json();
  if (published.verifierKeyReachable !== true) {
    throw new Error("the stub verifier public key is not reachable");
  }

  const envelope = await json(
    await fetch(`${STUB}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeCode: start.challengeCode, username }),
    }),
  );
  const callback = await fetch(`${BASE}/api/auth/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (callback.status !== 200) {
    throw new Error(`callback failed for ${username}: ${callback.status} ${await callback.text()}`);
  }

  const finalize = await fetch(
    `${BASE}/api/auth/finalize?challengecode=${encodeURIComponent(start.challengeCode)}`,
    { headers: jarHeader(flowJar), redirect: "manual" },
  );
  const session = jarFrom(finalize).filter((entry) => entry.startsWith("rn_session="));
  if (session.length === 0) {
    throw new Error(`finalize did not issue a session for ${username}`);
  }
  return { session, start, flowJar, finalize };
}

async function main() {
  // Start from an empty upstream record set so the suite is re-runnable.
  await fetch(`${STUB}/__records`, { method: "DELETE" });

  // ---------- 1. health ----------
  const health = await json(await fetch(`${BASE}/api/health`));
  check("health ok", health.ok === true, JSON.stringify(health.problems));
  check("health reports the stub verifier", health.verifier === STUB, health.verifier);

  // ---------- 2. start the login ----------
  const startRes = await fetch(`${BASE}/api/auth/start`, { method: "POST" });
  const start = await json(startRes);
  const jar = jarFrom(startRes);
  check("start returns 200", startRes.status === 200, String(startRes.status));
  check("start sets the flow cookie", jar.some((entry) => entry.startsWith("rn_flow=")), jar.join(" | "));

  const authorize = new URL(start.authorizeUrl);
  check("authorize URL points at the verifier", authorize.origin === STUB, authorize.origin);
  check(
    "authorize URL carries the challenge code",
    authorize.searchParams.get("challengecode") === start.challengeCode,
  );
  check(
    "authorize URL callback targets our API",
    authorize.searchParams.get("callback") === `${BASE}/api/auth/callback`,
    authorize.searchParams.get("callback"),
  );
  check(
    "authorize URL redirect targets finalize",
    authorize.searchParams.get("redirect") === `${BASE}/api/auth/finalize`,
    authorize.searchParams.get("redirect"),
  );

  /**
   * Every URL and redirect the flow hands out must name the same origin, or
   * the cookie written by one step is invisible to the next. This is the
   * regression guard for the finalize/logout origin bug: Next's nextUrl.origin
   * is the server's own address (localhost), not the request host.
   */
  const finalizeOrigin = new URL(
    (await fetch(`${BASE}/api/auth/finalize`, { redirect: "manual" })).headers.get("location"),
  ).origin;
  check("finalize redirect uses the configured origin", finalizeOrigin === BASE, finalizeOrigin);

  const logoutBody = await json(await fetch(`${BASE}/api/auth/logout`, { method: "POST" }));
  check("logout reports the configured origin", logoutBody.origin === BASE, logoutBody.origin);

  const challengeCode = start.challengeCode;

  // ---------- 3. forged callbacks are refused ----------
  const forged = await fetch(`${BASE}/api/auth/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeCode,
      verified: true,
      verifier: { username: "originalFactor", keyId: 1, keyType: "Ed25519", totalKeys: 1 },
      signed: {
        algorithm: "ed25519",
        payload: Buffer.from(
          JSON.stringify({ challengeCode, username: "originalFactor", issuedAt: new Date().toISOString() }),
        ).toString("base64url"),
        signature: "AAAA",
        publicKeyPem: "",
      },
    }),
  });
  const forgedBody = await json(forged);
  check(
    "forged signature is rejected",
    forged.status === 400 && forgedBody.code === "verification_signature_invalid",
    `${forged.status} ${forgedBody.code}`,
  );

  const unissuedCode = `never-issued-${Date.now().toString(36)}`;
  const unissued = await fetch(`${BASE}/api/auth/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeCode: unissuedCode,
      verified: true,
      verifier: { username: "originalFactor", keyId: 1, keyType: "Ed25519", totalKeys: 1 },
      signed: {
        algorithm: "ed25519",
        payload: Buffer.from(
          JSON.stringify({ challengeCode: unissuedCode, username: "originalFactor", issuedAt: new Date().toISOString() }),
        ).toString("base64url"),
        signature: "AAAA",
        publicKeyPem: "",
      },
    }),
  });
  check("envelope without a pending challenge is refused", unissued.status === 409, String(unissued.status));

  // A well-formed envelope for a *different* name must not authenticate us as
  // the user the browser is waiting for; it just verifies whoever signed it.
  const signedRes = await fetch(`${STUB}/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeCode, username: "originalFactor" }),
  });
  const envelope = await json(signedRes);
  const callbackRes = await fetch(`${BASE}/api/auth/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const callbackBody = await json(callbackRes);
  check("signed envelope is accepted", callbackRes.status === 200 && callbackBody.success === true, JSON.stringify(callbackBody));

  // Replaying the same callback must not succeed twice.
  const replay = await fetch(`${BASE}/api/auth/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  check("replayed callback is refused", replay.status === 409, String(replay.status));

  // ---------- 4. finalize requires the flow cookie ----------
  const bareFinalize = await fetch(`${BASE}/api/auth/finalize?challengecode=${encodeURIComponent(challengeCode)}`, {
    redirect: "manual",
  });
  const bareLocation = bareFinalize.headers.get("location") ?? "";
  check(
    "finalize without the flow cookie redirects to /login",
    bareLocation.includes("/login") && bareLocation.includes("error=flow_mismatch"),
    bareLocation,
  );

  const finalize = await fetch(`${BASE}/api/auth/finalize?challengecode=${encodeURIComponent(challengeCode)}`, {
    headers: jarHeader(jar),
    redirect: "manual",
  });
  const sessionCookies = jarFrom(finalize);
  const location = finalize.headers.get("location") ?? "";
  check("finalize with the flow cookie redirects to the dashboard", location.includes("/dashboard"), location);
  check(
    "finalize sets a session cookie",
    sessionCookies.some((entry) => /^rn_session=[^;]+$/.test(entry)),
    sessionCookies.join(" | "),
  );

  const authedJar = sessionCookies.filter((entry) => entry.startsWith("rn_session="));

  // The verified login artifact must be single-use.
  const secondFinalize = await fetch(`${BASE}/api/auth/finalize?challengecode=${encodeURIComponent(challengeCode)}`, {
    headers: jarHeader(jar),
    redirect: "manual",
  });
  check(
    "a second finalize is refused",
    (secondFinalize.headers.get("location") ?? "").includes("error=not_verified"),
    secondFinalize.headers.get("location"),
  );

  // ---------- 5. session + guards ----------
  const session = await json(await fetch(`${BASE}/api/auth/session`, { headers: jarHeader(authedJar) }));
  check("session is authenticated", session.authenticated === true, JSON.stringify(session.user));
  check("session exposes the verified login", session.user?.login === "originalFactor", session.user?.login);
  check("session key type surfaced", session.user?.keyType === "Ed25519", session.user?.keyType);

  const contribSession = session.user?.canRegisterContrib;
  check("contributor status is a boolean", typeof contribSession === "boolean", String(contribSession));

  const anonDomains = await fetch(`${BASE}/api/domains`);
  check("GET /api/domains requires auth", anonDomains.status === 401, String(anonDomains.status));

  const anonCreate = await fetch(`${BASE}/api/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "smoke", suffix: "verified", nameservers: [{ host: "ns1.example.com" }] }),
  });
  check("POST /api/domains requires auth", anonCreate.status === 401, String(anonCreate.status));

  // ---------- 6. validation + registration ----------
  const invalid = await json(await fetch(`${BASE}/api/domains/check?label=-Bad_Name-&suffix=verified`));
  check("invalid label is rejected by the check endpoint", invalid.issues?.length > 0, JSON.stringify(invalid.issues));

  // Names delegated in public DNS must not be claimable, even though our
  // Cloudflare zones know nothing about them.
  const externallyDelegated = await json(
    await fetch(`${BASE}/api/domains/check?label=taken&suffix=verified`, { headers: jarHeader(authedJar) }),
  );
  check("externally delegated name is not available", externallyDelegated.available === false, JSON.stringify(externallyDelegated));
  check(
    "externally delegated name reports its nameservers",
    externallyDelegated.existingNameservers?.includes("ns1.someother.net"),
    JSON.stringify(externallyDelegated.existingNameservers),
  );

  const blockedCreate = await fetch(`${BASE}/api/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jarHeader(authedJar) },
    body: JSON.stringify({
      label: "taken",
      suffix: "verified",
      nameservers: [{ host: "ns1.example.net" }],
    }),
  });
  const blockedBody = await json(blockedCreate);
  check(
    "registering an externally delegated name is refused",
    blockedCreate.status === 409 && blockedBody.code === "already_delegated",
    `${blockedCreate.status} ${blockedBody.code}`,
  );

  const uniqueLabel = `smoke-${Date.now().toString(36)}`;
  const available = await json(
    await fetch(`${BASE}/api/domains/check?label=${uniqueLabel}&suffix=verified`, { headers: jarHeader(authedJar) }),
  );
  check("unused label reports available", available.available === true, JSON.stringify(available));

  const badGlue = await fetch(`${BASE}/api/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jarHeader(authedJar) },
    body: JSON.stringify({
      label: uniqueLabel,
      suffix: "verified",
      nameservers: [{ host: `ns1.${uniqueLabel}.verified.resukisu.org`, addresses: [] }],
    }),
  });
  const badGlueBody = await json(badGlue);
  check(
    "in-zone nameserver without glue addresses is rejected",
    badGlue.status === 422,
    `${badGlue.status} ${JSON.stringify(badGlueBody.details)}`,
  );

  const created = await fetch(`${BASE}/api/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jarHeader(authedJar) },
    body: JSON.stringify({
      label: uniqueLabel,
      suffix: "verified",
      nameservers: [
        { host: "ns1.example.net", addresses: [] },
        { host: "ns2.example.net", addresses: [] },
        { host: `ns3.${uniqueLabel}.verified.resukisu.org`, addresses: ["203.0.113.10", "2001:db8::10"] },
      ],
    }),
  });
  const createdBody = await json(created);
  check("registration succeeds", created.status === 201, `${created.status} ${JSON.stringify(createdBody)}`);
  check(
    "registration returns the full name",
    createdBody.domain?.fqdn === `${uniqueLabel}.verified.resukisu.org`,
    createdBody.domain?.fqdn,
  );
  check(
    "registration created 3 NS records plus 2 glue records",
    createdBody.domain?.recordIds?.length === 5,
    String(createdBody.domain?.recordIds?.length),
  );
  check("glue records were recorded", createdBody.domain?.glue?.[0]?.addresses?.length === 2, JSON.stringify(createdBody.domain?.glue));

  const listed = await json(await fetch(`${BASE}/api/domains`, { headers: jarHeader(authedJar) }));
  check("the new domain is listed for its owner", listed.domains?.some((entry) => entry.fqdn === createdBody.domain.fqdn));

  const duplicate = await fetch(`${BASE}/api/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jarHeader(authedJar) },
    body: JSON.stringify({
      label: uniqueLabel,
      suffix: "verified",
      nameservers: [{ host: "ns1.example.net" }],
    }),
  });
  const duplicateBody = await json(duplicate);
  check(
    "registering the same label twice is refused",
    duplicate.status === 409 && duplicateBody.code === "registration_rejected",
    `${duplicate.status} ${duplicateBody.code} ${duplicateBody.error}`,
  );

  const otherLabel = await fetch(`${BASE}/api/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jarHeader(authedJar) },
    body: JSON.stringify({
      label: `${uniqueLabel}-2`,
      suffix: "verified",
      nameservers: [{ host: "ns1.example.net" }],
    }),
  });
  const otherBody = await json(otherLabel);
  check(
    "a second verified domain for the same account is refused",
    otherLabel.status === 409 && otherBody.error?.includes("already registered"),
    `${otherLabel.status} ${otherBody.error}`,
  );

  // ---------- 7. contributor gating ----------
  // originalFactor is a stub contributor, so the contrib zone is reachable...
  const contribLabel = `${uniqueLabel}-c`;
  const contribCreated = await fetch(`${BASE}/api/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jarHeader(authedJar) },
    body: JSON.stringify({
      label: contribLabel,
      suffix: "contrib",
      nameservers: [{ host: "ns1.example.net" }],
    }),
  });
  const contribBody = await json(contribCreated);
  check(
    "stub contributor may register a contrib domain",
    contribCreated.status === 201 && contribBody.domain?.fqdn === `${contribLabel}.contrib.resukisu.org`,
    `${contribCreated.status} ${JSON.stringify(contribBody)}`,
  );

  // ...and a non-contributor must be refused outright.
  const outsider = await loginAs("definitely-not-a-contributor");
  const outsiderVerifiedLabel = `${uniqueLabel}-o`;
  check(
    "non-contributor session has no contrib access",
    (await json(await fetch(`${BASE}/api/auth/session`, { headers: jarHeader(outsider.session) }))).user
      ?.canRegisterContrib === false,
  );

  const outsiderAttempt = await fetch(`${BASE}/api/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jarHeader(outsider.session) },
    body: JSON.stringify({
      label: outsiderVerifiedLabel,
      suffix: "contrib",
      nameservers: [{ host: "ns1.example.net" }],
    }),
  });
  const outsiderBody = await json(outsiderAttempt);
  check(
    "non-contributor is refused the contrib zone",
    outsiderAttempt.status === 403 && outsiderBody.code === "not_a_contributor",
    `${outsiderAttempt.status} ${outsiderBody.code}`,
  );

  const outsiderVerified = await fetch(`${BASE}/api/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jarHeader(outsider.session) },
    body: JSON.stringify({
      label: outsiderVerifiedLabel,
      suffix: "verified",
      nameservers: [{ host: "ns1.example.net" }],
    }),
  });
  const outsiderVerifiedBody = await json(outsiderVerified);
  check(
    "non-contributor may still use the verified zone",
    outsiderVerified.status === 201,
    `${outsiderVerified.status} ${JSON.stringify(outsiderVerifiedBody)}`,
  );

  // The outsider must not be able to delete someone else's domain.
  const crossOwner = await fetch(`${BASE}/api/domains/delete?fqdn=${contribBody.domain.fqdn}`, {
    method: "DELETE",
    headers: jarHeader(outsider.session),
  });
  check("a different account cannot delete the domain", crossOwner.status === 403, String(crossOwner.status));

  // ---------- 8. deletion ----------
  const notOwner = await fetch(`${BASE}/api/domains/delete?fqdn=${createdBody.domain.fqdn}`, {
    method: "DELETE",
  });
  check("delete requires auth", notOwner.status === 401, String(notOwner.status));

  const missing = await fetch(`${BASE}/api/domains/delete?fqdn=nope.verified.resukisu.org`, {
    method: "DELETE",
    headers: jarHeader(authedJar),
  });
  check("deleting an unknown domain 404s", missing.status === 404, String(missing.status));

  const deleted = await fetch(`${BASE}/api/domains/delete?fqdn=${encodeURIComponent(createdBody.domain.fqdn)}`, {
    method: "DELETE",
    headers: jarHeader(authedJar),
  });
  check("owner can delete", deleted.status === 200, `${deleted.status} ${JSON.stringify(await json(deleted))}`);

  const afterDelete = await json(await fetch(`${BASE}/api/domains`, { headers: jarHeader(authedJar) }));
  check(
    "deleted domain is gone from the listing",
    !afterDelete.domains?.some((entry) => entry.fqdn === createdBody.domain.fqdn),
  );

  // Clean up the domains this run created so the suite is re-runnable.
  for (const [jar, fqdn] of [
    [authedJar, contribBody.domain?.fqdn],
    [outsider.session, `${outsiderVerifiedLabel}.verified.resukisu.org`],
  ]) {
    if (!fqdn) {
      continue;
    }
    const cleanup = await fetch(`${BASE}/api/domains/delete?fqdn=${encodeURIComponent(fqdn)}`, {
      method: "DELETE",
      headers: jarHeader(jar),
    });
    check(`cleanup removed ${fqdn}`, cleanup.status === 200, String(cleanup.status));
  }

  const upstreamRecords = await json(await fetch(`${STUB}/__records`));
  check(
    "upstream records were cleaned up",
    upstreamRecords.records.every((record) => record.comment === null || !record.comment.includes("resuki-nic")),
    JSON.stringify(upstreamRecords.records.map((record) => record.name)),
  );

  // ---------- 9. logout ----------
  const logout = await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: jarHeader(authedJar) });
  check("logout clears the session cookie", logout.status === 200, String(logout.status));

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
