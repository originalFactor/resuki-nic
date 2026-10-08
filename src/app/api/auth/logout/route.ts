import { NextRequest, NextResponse } from "next/server";

import { resolveOrigin } from "@/lib/config";
import { FLOW_COOKIE, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

/**
 * Clears the session (and any half-finished login).
 *
 * Targets are built with resolveOrigin so they match the host the browser is
 * actually using, which is also the host the cookies were set for.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ success: true, origin: resolveOrigin(request) });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  response.cookies.set(FLOW_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.redirect(new URL("/", resolveOrigin(request)));
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  response.cookies.set(FLOW_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  return response;
}
