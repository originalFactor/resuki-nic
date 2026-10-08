import { NextResponse } from "next/server";

import { completeChallenge, getPendingChallenge } from "@/lib/auth";
import { fetchVerifierPublicKey, parseEnvelope, verifyEnvelope } from "@/lib/ghssh";
import { RATE_LIMITS } from "@/lib/config";
import { jsonError, readJsonBody } from "@/lib/http";
import { kvBackend, rateLimit } from "@/lib/kv";
import { sha256Hex } from "@/lib/session";
import type { VerifiedLogin } from "@/lib/types";

/**
 * Callback target for the verifier (https://verify.resukisu.org).
 *
 * The verifier runs this request server-to-server after the user signs the
 * challenge with their SSH key, so there is no browser session here: trust
 * comes purely from the Ed25519 signature over the signed payload and the
 * single-use challenge code this app issued.
 *
 * GET is a human-readable summary of the endpoint and its configuration.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = await readJsonBody<unknown>(request);
  if (!parsed.ok) {
    return parsed.response;
  }

  const envelope = parseEnvelope(parsed.body);
  if (!envelope) {
    return jsonError(400, "malformed_envelope", "Body is not a verifier envelope.");
  }

  const limited = await rateLimit(
    `auth-callback:${envelope.challengeCode}`,
    RATE_LIMITS.authCallback,
    RATE_LIMITS.authCallbackWindow,
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many attempts for this challenge.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": "300" } },
    );
  }

  const pending = await getPendingChallenge(envelope.challengeCode);
  if (!pending) {
    return jsonError(
      409,
      "challenge_unknown",
      "This challenge is unknown or has expired. Start the login again.",
    );
  }

  const result = await verifyEnvelope(envelope, pending.challengeCode);
  if (!result.ok) {
    return jsonError(400, `verification_${result.reason}`, describeFailure(result.reason), result.detail);
  }

  const verified: VerifiedLogin = {
    challengeCode: pending.challengeCode,
    login: envelope.verifier.username,
    keyId: envelope.verifier.keyId,
    keyType: envelope.verifier.keyType,
    totalKeys: envelope.verifier.totalKeys,
    verifiedAt: new Date().toISOString(),
    payloadHash: sha256Hex(envelope.signed.payload),
  };

  const stored = await completeChallenge(pending, verified);
  if (!stored) {
    return jsonError(
      409,
      "callback_replay",
      "This challenge was already completed. Start the login again to get a new code.",
    );
  }

  return NextResponse.json({
    success: true,
    message: "Signature verified. Finish signing in from the browser tab you started in.",
    login: verified.login,
  });
}

export async function GET(): Promise<NextResponse> {
  let keyReachable = true;
  try {
    await fetchVerifierPublicKey();
  } catch {
    keyReachable = false;
  }

  return NextResponse.json({
    endpoint: "ghssh callback",
    method: "POST",
    store: kvBackend(),
    verifierKeyReachable: keyReachable,
    note: "The verifier POSTs a signed envelope here; browsers never call it directly.",
  });
}

function describeFailure(reason: string | undefined): string {
  switch (reason) {
    case "unverified":
      return "The verifier reported the signature as invalid.";
    case "unsupported_algorithm":
      return "The envelope did not use Ed25519.";
    case "payload_mismatch":
      return "The signed payload does not match the challenge that was issued.";
    case "issued_at_invalid":
      return "The signed payload timestamp is outside the accepted window.";
    case "signature_invalid":
      return "The verifier's signature could not be validated.";
    case "public_key_unavailable":
      return "The verifier's published public key could not be fetched.";
    default:
      return "The envelope could not be verified.";
  }
}
