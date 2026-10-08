import "server-only";

import type { DomainSuffix } from "./config";
import { readSessionFromRequest } from "./auth";
import { jsonError, type ApiErrorBody } from "./http";
import type { SessionUser } from "./types";
import type { NextResponse } from "next/server";

export type SessionGuard =
  | { ok: true; user: SessionUser }
  | { ok: false; response: NextResponse<ApiErrorBody> };

export async function requireSession(request: Request): Promise<SessionGuard> {
  const user = await readSessionFromRequest(request);
  if (!user) {
    return {
      ok: false,
      response: jsonError(401, "unauthenticated", "Sign in first."),
    };
  }
  return { ok: true, user };
}

export type SuffixGuard = { ok: true } | { ok: false; response: NextResponse<ApiErrorBody> };

export function requireSuffixAccess(user: SessionUser, suffix: DomainSuffix): SuffixGuard {
  if (suffix === "verified" || user.canRegisterContrib) {
    return { ok: true };
  }
  return {
    ok: false,
    response: jsonError(
      403,
      "not_a_contributor",
      "Only contributors of the upstream repository may register *.contrib.resukisu.org.",
    ),
  };
}
