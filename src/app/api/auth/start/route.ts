import { NextResponse } from "next/server";

import {
  buildFlowCookie,
  createPendingChallenge,
  requestIp,
} from "@/lib/auth";
import { RATE_LIMITS, resolveOrigin } from "@/lib/config";
import { buildAuthorizeUrl } from "@/lib/ghssh";
import { enforceRateLimit, jsonError } from "@/lib/http";
import { assertPersistentStore } from "@/lib/kv";

/**
 * Starts a login: mints a challenge code, binds it to this browser with the
 * flow cookie, and returns the verifier URL the client should navigate to.
 *
 * The callback and redirect URLs handed to the verifier come from
 * resolveOrigin, so they name the host the browser is actually on even when
 * the app sits behind a proxy or on a custom domain.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertPersistentStore();
  } catch (error) {
    return jsonError(
      503,
      "store_unavailable",
      error instanceof Error ? error.message : "Login storage is unavailable.",
    );
  }

  const limited = await enforceRateLimit(
    `login-start:${requestIp(request)}`,
    RATE_LIMITS.loginStart,
    RATE_LIMITS.loginStartWindow,
  );
  if (limited) {
    return limited;
  }

  const origin = resolveOrigin(request);
  const callbackUrl = `${origin}/api/auth/callback`;
  const redirectUrl = `${origin}/api/auth/finalize`;

  const pending = await createPendingChallenge({ callbackUrl, redirectUrl });

  const response = NextResponse.json({
    authorizeUrl: buildAuthorizeUrl({
      challengeCode: pending.challengeCode,
      callbackUrl,
      redirectUrl,
    }),
    challengeCode: pending.challengeCode,
    expiresIn: 240,
  });

  const cookie = buildFlowCookie(pending.challengeCode);
  response.cookies.set(cookie.name, cookie.value, {
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    path: cookie.path,
    maxAge: cookie.maxAge,
  });

  return response;
}
