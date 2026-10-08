import { NextResponse, type NextRequest } from "next/server";

import {
  buildSessionCookie,
  consumeVerifiedLogin,
  flowCookieMatches,
  toSessionUser,
} from "@/lib/auth";
import { resolveOrigin } from "@/lib/config";
import { FLOW_COOKIE, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

/**
 * Browser landing point after the verifier finishes.
 *
 * The verifier redirects here with `?challengecode=...`. The verified result
 * is only released to a browser that also presents the flow cookie set when
 * the login started, so a leaked challenge code alone cannot mint a session.
 *
 * Redirect targets are built with resolveOrigin rather than nextUrl.origin:
 * the latter is derived from the server's own address, which behind a proxy or
 * on a custom domain is not the host the browser is using.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const challengeCode = request.nextUrl.searchParams.get("challengecode")?.trim() ?? "";
  const origin = resolveOrigin(request);

  if (!challengeCode) {
    return redirectBack(origin, "missing_code");
  }

  const flowCookie = request.cookies.get(FLOW_COOKIE)?.value;
  if (!flowCookieMatches(flowCookie, challengeCode)) {
    return redirectBack(origin, "flow_mismatch");
  }

  const verified = await consumeVerifiedLogin(challengeCode);
  if (!verified) {
    return redirectBack(origin, "not_verified");
  }

  const user = await toSessionUser(verified);
  const target = new URL("/dashboard", origin);
  target.searchParams.set("welcome", user.login);

  const response = NextResponse.redirect(target);
  const session = buildSessionCookie(user);
  response.cookies.set(session.name, session.value, {
    httpOnly: session.httpOnly,
    sameSite: session.sameSite,
    secure: session.secure,
    path: session.path,
    maxAge: session.maxAge,
  });
  response.cookies.set(FLOW_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });

  return response;
}

/**
 * Bounces back to the sign-in page and clears both cookies. Clearing the
 * session cookie matters because /login redirects authenticated users to the
 * dashboard: without it, a failed login would loop.
 */
function redirectBack(origin: string, reason: string): NextResponse {
  const target = new URL("/login", origin);
  target.searchParams.set("error", reason);
  const response = NextResponse.redirect(target);
  response.cookies.set(FLOW_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  return response;
}
