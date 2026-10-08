import { NextResponse } from "next/server";

import { readSessionFromRequest, requestIp } from "@/lib/auth";
import { RATE_LIMITS, type DomainSuffix, zoneNameFor } from "@/lib/config";
import {
  getDomainByFqdn,
  getOwnedDomain,
  isDomainSuffix,
  validateLabel,
} from "@/lib/domains";
import { lookupNameservers } from "@/lib/dns";
import { jsonError, type ApiErrorBody } from "@/lib/http";
import { rateLimit } from "@/lib/kv";
import type { ValidationIssue } from "@/lib/domains";

interface CheckResponse {
  label: string;
  suffix: DomainSuffix;
  fqdn: string;
  available: boolean;
  issues: ValidationIssue[];
  takenBy: string | null;
  existingNameservers: string[];
  youOwn: string | null;
}

/**
 * Availability + validation preview. Writes nothing; this powers the live
 * feedback in the registration form.
 */
export async function GET(
  request: Request,
): Promise<NextResponse<CheckResponse | ApiErrorBody>> {
  const url = new URL(request.url);
  const rawLabel = url.searchParams.get("label") ?? "";
  const rawSuffix = url.searchParams.get("suffix") ?? "verified";

  const limited = await rateLimit(
    `domain-check:${requestIp(request)}`,
    RATE_LIMITS.domainCheck,
    RATE_LIMITS.domainCheckWindow,
  );
  if (!limited.allowed) {
    return jsonError(429, "rate_limited", "Too many availability checks. Slow down a little.");
  }

  if (!isDomainSuffix(rawSuffix)) {
    return jsonError(400, "suffix_unknown", `Unknown domain suffix "${rawSuffix}".`);
  }
  const suffix: DomainSuffix = rawSuffix;
  const zoneName = zoneNameFor(suffix);

  const { label, issues } = validateLabel(rawLabel, suffix, zoneName);
  const fqdn = `${label}.${zoneName}`;

  if (issues.length > 0) {
    return NextResponse.json({
      label,
      suffix,
      fqdn,
      available: false,
      issues,
      takenBy: null,
      existingNameservers: [],
      youOwn: null,
    });
  }

  const user = await readSessionFromRequest(request);
  const [registered, owned] = await Promise.all([
    getDomainByFqdn(fqdn),
    user ? getOwnedDomain(user.login, suffix) : Promise.resolve(null),
  ]);

  const existingNameservers = registered ? registered.nameservers : await lookupNameservers(fqdn);

  return NextResponse.json({
    label,
    suffix,
    fqdn,
    available: !registered && existingNameservers.length === 0,
    issues: [],
    takenBy: registered?.owner ?? (existingNameservers.length > 0 ? "an external DNS provider" : null),
    existingNameservers,
    youOwn: owned?.fqdn ?? null,
  });
}
