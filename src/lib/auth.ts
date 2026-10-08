import "server-only";

import { cookies } from "next/headers";

import { CHALLENGE_TTL_SECONDS } from "./config";
import { fetchProfile, isContributor } from "./github";
import { kvDel, kvGetJson, kvSetIfAbsent, kvSetJson, kvTakeJson } from "./kv";
import {
  FLOW_COOKIE,
  SESSION_COOKIE,
  decodeSession,
  encodeSession,
  randomChallengeCode,
  sessionCookieOptions,
  sha256Hex,
} from "./session";
import type { PendingChallenge, SessionUser, VerifiedLogin } from "./types";

/**
 * Login flow state.
 *
 * 1. /api/auth/start mints a challenge code, remembers it and sets a flow
 *    cookie in the browser that initiated the login.
 * 2. The verifier POSTs to /api/auth/callback once the user has signed the
 *    code with their SSH key; the signature is validated against the
 *    verifier's published Ed25519 key.
 * 3. /api/auth/finalize turns the verified challenge into a session, but only
 *    for the browser that still holds the matching flow cookie.
 */

const PENDING_PREFIX = "auth:pending:";
const VERIFIED_PREFIX = "auth:verified:";

function pendingKey(challengeCode: string): string {
  return PENDING_PREFIX + challengeCode;
}

function verifiedKey(challengeCode: string): string {
  return VERIFIED_PREFIX + challengeCode;
}

export async function createPendingChallenge(options: {
  callbackUrl: string;
  redirectUrl: string;
}): Promise<PendingChallenge> {
  const challengeCode = randomChallengeCode();
  const pending: PendingChallenge = {
    challengeCode,
    createdAt: new Date().toISOString(),
    callbackUrl: options.callbackUrl,
    redirectUrl: options.redirectUrl,
  };
  await kvSetJson(pendingKey(challengeCode), pending, CHALLENGE_TTL_SECONDS);
  return pending;
}

export async function getPendingChallenge(
  challengeCode: string,
): Promise<PendingChallenge | null> {
  return kvGetJson<PendingChallenge>(pendingKey(challengeCode));
}

/**
 * Stores the verified login against its challenge and clears the pending
 * record. Returns false when another request already stored a result for this
 * challenge, which makes the callback replay-safe.
 */
export async function completeChallenge(
  pending: PendingChallenge,
  verified: VerifiedLogin,
): Promise<boolean> {
  const stored = await kvSetIfAbsent(
    verifiedKey(pending.challengeCode),
    JSON.stringify(verified),
    CHALLENGE_TTL_SECONDS,
  );
  if (stored) {
    await kvDel(pendingKey(pending.challengeCode));
  }
  return stored;
}

/** Reads and deletes the verified login for a challenge code. */
export async function consumeVerifiedLogin(
  challengeCode: string,
): Promise<VerifiedLogin | null> {
  return kvTakeJson<VerifiedLogin>(verifiedKey(challengeCode));
}

export async function toSessionUser(verified: VerifiedLogin): Promise<SessionUser> {
  const contributor = await isContributor(verified.login);
  const profile = await fetchProfile(verified.login);
  return {
    login: verified.login,
    verifiedAt: verified.verifiedAt,
    keyId: verified.keyId,
    keyType: verified.keyType,
    avatarUrl: profile?.avatarUrl ?? null,
    canRegisterContrib: contributor.isContributor,
  };
}

export function sessionUserFromPayload(payload: SessionUser & { exp: number; iat: number }): SessionUser {
  return {
    login: payload.login,
    verifiedAt: payload.verifiedAt,
    keyId: payload.keyId,
    keyType: payload.keyType,
    avatarUrl: payload.avatarUrl ?? null,
    canRegisterContrib: payload.canRegisterContrib === true,
  };
}

export async function readSessionCookie(): Promise<SessionUser | null> {
  const store = await cookies();
  const payload = decodeSession(store.get(SESSION_COOKIE)?.value);
  return payload ? sessionUserFromPayload(payload) : null;
}

export async function readSessionFromRequest(request: Request): Promise<SessionUser | null> {
  const payload = decodeSession(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
  return payload ? sessionUserFromPayload(payload) : null;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

/** The flow cookie binds a completed login to the browser that started it. */
export function flowCookieValue(challengeCode: string): string {
  return `${challengeCode}.${sha256Hex(challengeCode)}`;
}

export function flowCookieMatches(cookieValue: string | undefined, challengeCode: string): boolean {
  if (!cookieValue) {
    return false;
  }
  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) {
    return false;
  }
  if (cookieValue.slice(0, separator) !== challengeCode) {
    return false;
  }
  return cookieValue.slice(separator + 1) === sha256Hex(challengeCode);
}

export function buildFlowCookie(challengeCode: string) {
  return {
    name: FLOW_COOKIE,
    value: flowCookieValue(challengeCode),
    ...sessionCookieOptions(CHALLENGE_TTL_SECONDS),
  };
}

export function buildSessionCookie(user: SessionUser) {
  return {
    name: SESSION_COOKIE,
    value: encodeSession(user),
    ...sessionCookieOptions(),
  };
}

export function requestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}
