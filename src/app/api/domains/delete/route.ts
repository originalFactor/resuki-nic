import { NextResponse } from "next/server";

import { deleteDomain, getDomainByFqdn } from "@/lib/domains";
import { forgetNameservers } from "@/lib/dns";
import { requireSession } from "@/lib/guards";
import { jsonError } from "@/lib/http";
import { CloudflareError } from "@/lib/cloudflare";

/** Deletes a delegation owned by the signed-in user. */
export async function DELETE(request: Request): Promise<NextResponse> {
  const guard = await requireSession(request);
  if (!guard.ok) {
    return guard.response;
  }

  const url = new URL(request.url);
  const fqdn = url.searchParams.get("fqdn")?.trim().toLowerCase() ?? "";
  if (!fqdn || !fqdn.includes(".")) {
    return jsonError(400, "invalid_fqdn", "Pass the full domain name, e.g. ?fqdn=example.verified.resukisu.org");
  }

  const existing = await getDomainByFqdn(fqdn);
  if (!existing) {
    return jsonError(404, "not_found", `${fqdn} is not registered.`);
  }
  if (existing.owner.toLowerCase() !== guard.user.login.toLowerCase()) {
    return jsonError(403, "not_owner", "You do not own this domain.");
  }

  try {
    const outcome = await deleteDomain(guard.user.login, fqdn);
    if (!outcome.ok) {
      return jsonError(502, "delete_failed", outcome.error ?? "Deletion failed.");
    }
    await forgetNameservers(fqdn);
    return NextResponse.json({ success: true, deleted: outcome.deleted });
  } catch (error) {
    if (error instanceof CloudflareError) {
      return jsonError(502, "cloudflare_error", error.message, error.codes);
    }
    return jsonError(
      500,
      "delete_failed",
      error instanceof Error ? error.message : "Deletion failed.",
    );
  }
}
