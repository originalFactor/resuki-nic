import "server-only";

import crypto from "node:crypto";

import { SESSION_TTL_SECONDS, sessionSecret } from "./config";
import type { SessionUser } from "./types";

export const SESSION_COOKIE = "rn_session";
export const FLOW_COOKIE = "rn_flow";

interface SessionPayload extends SessionUser {
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Issued at, seconds since epoch. */
  iat: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function encodeSession(user: SessionUser, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload: SessionPayload = {
    ...user,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function decodeSession(
  token: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (!token) {
    return null;
  }

  const separator = token.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }

  const encoded = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(sign(encoded), "base64url");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload?.login !== "string" || typeof payload?.exp !== "number") {
    return null;
  }
  if (payload.exp <= nowSeconds) {
    return null;
  }

  return payload;
}

export function sessionCookieOptions(maxAge = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export function randomChallengeCode(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
