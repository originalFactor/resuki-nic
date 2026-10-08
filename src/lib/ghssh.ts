import "server-only";

import crypto from "node:crypto";

import { GHSSH_ORIGIN } from "./config";
import { kvGetJson, kvSetJson } from "./kv";

/**
 * Client for the external verifier at https://verify.resukisu.org (ghssh).
 *
 * The verifier POSTs an Ed25519-signed envelope to our callback:
 *
 *   {
 *     challengeCode: string,
 *     verified: true,
 *     verifier: { username, keyId, keyType, totalKeys },
 *     signed: { algorithm: "ed25519", payload, signature, publicKeyPem }
 *   }
 *
 * `payload` is base64url(JSON) and `signature` is the detached Ed25519
 * signature over the *encoded payload string itself* (not the decoded bytes),
 * matching the reference implementation in ghssh's external-sim callback.
 */

export interface VerifierEnvelope {
  challengeCode: string;
  verified: boolean;
  verifier: {
    username: string;
    keyId: number | null;
    keyType: string | null;
    totalKeys: number | null;
  };
  signed: {
    algorithm: string;
    payload: string;
    signature: string;
    publicKeyPem: string;
  };
}

export interface VerifierPublicKey {
  algorithm: string;
  publicKeyPem: string;
}

export type EnvelopeFailure =
  | "malformed"
  | "unsupported_algorithm"
  | "unverified"
  | "payload_mismatch"
  | "issued_at_invalid"
  | "signature_invalid"
  | "public_key_unavailable";

export interface EnvelopeResult {
  ok: boolean;
  reason?: EnvelopeFailure;
  detail?: string;
  claims?: { challengeCode: string; username: string; issuedAt: string };
}

const PUBLIC_KEY_CACHE_KEY = "ghssh:public-key";
const PUBLIC_KEY_CACHE_SECONDS = 300;
const ISSUED_AT_SKEW_SECONDS = 300;

export async function fetchVerifierPublicKey(): Promise<VerifierPublicKey> {
  const cached = await kvGetJson<VerifierPublicKey>(PUBLIC_KEY_CACHE_KEY);
  if (cached?.publicKeyPem && cached.algorithm === "ed25519") {
    return cached;
  }

  const response = await fetch(`${GHSSH_ORIGIN}/api/public-key`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`verifier public key request failed: ${response.status}`);
  }

  const body = (await response.json()) as VerifierPublicKey;
  if (!body?.publicKeyPem || body.algorithm !== "ed25519") {
    throw new Error("verifier returned an unexpected public key payload");
  }

  await kvSetJson(PUBLIC_KEY_CACHE_KEY, body, PUBLIC_KEY_CACHE_SECONDS);
  return body;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseEnvelope(body: unknown): VerifierEnvelope | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const record = body as Record<string, unknown>;
  const verifier = record.verifier as Record<string, unknown> | undefined;
  const signed = record.signed as Record<string, unknown> | undefined;
  if (!verifier || !signed) {
    return null;
  }

  const challengeCode = asString(record.challengeCode);
  const username = asString(verifier.username);
  const payload = asString(signed.payload);
  const signature = asString(signed.signature);
  if (!challengeCode || !username || !payload || !signature) {
    return null;
  }

  const keyId = typeof verifier.keyId === "number" ? verifier.keyId : null;
  const totalKeys = typeof verifier.totalKeys === "number" ? verifier.totalKeys : null;

  return {
    challengeCode,
    verified: record.verified === true,
    verifier: {
      username,
      keyId,
      keyType: asString(verifier.keyType) || null,
      totalKeys,
    },
    signed: {
      algorithm: asString(signed.algorithm),
      payload,
      signature,
      publicKeyPem: asString(signed.publicKeyPem),
    },
  };
}

/**
 * Verifies the envelope's Ed25519 signature and its claims. `expectedChallenge`
 * is the challenge code this app issued; it must match both the envelope and
 * the signed payload.
 */
export async function verifyEnvelope(
  envelope: VerifierEnvelope,
  expectedChallenge: string,
): Promise<EnvelopeResult> {
  if (!envelope.verified) {
    return { ok: false, reason: "unverified" };
  }
  if (envelope.signed.algorithm !== "ed25519") {
    return { ok: false, reason: "unsupported_algorithm", detail: envelope.signed.algorithm };
  }
  if (envelope.challengeCode !== expectedChallenge) {
    return {
      ok: false,
      reason: "payload_mismatch",
      detail: "envelope challengeCode does not match the issued challenge",
    };
  }

  let publicKeyPem: string;
  try {
    const published = await fetchVerifierPublicKey();
    publicKeyPem = published.publicKeyPem;
  } catch (error) {
    return {
      ok: false,
      reason: "public_key_unavailable",
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }

  // The key travels in the envelope, but trust comes from the published key.
  // Accepting an attacker-supplied key would make the signature meaningless.
  if (envelope.signed.publicKeyPem && envelope.signed.publicKeyPem.trim() !== publicKeyPem.trim()) {
    return {
      ok: false,
      reason: "signature_invalid",
      detail: "signed.publicKeyPem does not match the verifier's published key",
    };
  }

  let claims: { challengeCode?: unknown; username?: unknown; issuedAt?: unknown };
  try {
    claims = JSON.parse(Buffer.from(envelope.signed.payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed", detail: "signed.payload is not base64url(JSON)" };
  }

  const claimChallenge = asString(claims.challengeCode);
  const claimUsername = asString(claims.username);
  const claimIssuedAt = asString(claims.issuedAt);

  if (claimChallenge !== expectedChallenge || claimUsername !== envelope.verifier.username) {
    return {
      ok: false,
      reason: "payload_mismatch",
      detail: "signed payload does not agree with the envelope",
    };
  }

  const issuedAtMs = Date.parse(claimIssuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return { ok: false, reason: "issued_at_invalid", detail: claimIssuedAt };
  }
  const ageSeconds = Math.abs(Date.now() - issuedAtMs) / 1000;
  if (ageSeconds > ISSUED_AT_SKEW_SECONDS) {
    return {
      ok: false,
      reason: "issued_at_invalid",
      detail: `signed payload is ${Math.round(ageSeconds)}s away from now`,
    };
  }

  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(envelope.signed.payload),
      publicKeyPem,
      Buffer.from(envelope.signed.signature, "base64url"),
    );
  } catch (error) {
    return {
      ok: false,
      reason: "signature_invalid",
      detail: error instanceof Error ? error.message : "verification threw",
    };
  }

  if (!signatureValid) {
    return { ok: false, reason: "signature_invalid" };
  }

  return {
    ok: true,
    claims: { challengeCode: claimChallenge, username: claimUsername, issuedAt: claimIssuedAt },
  };
}

/** Builds the verifier URL the browser is sent to in order to sign in. */
export function buildAuthorizeUrl(options: {
  challengeCode: string;
  callbackUrl: string;
  redirectUrl: string;
}): string {
  const url = new URL("/", GHSSH_ORIGIN);
  url.searchParams.set("challengecode", options.challengeCode);
  url.searchParams.set("callback", options.callbackUrl);
  url.searchParams.set("redirect", options.redirectUrl);
  return url.toString();
}
