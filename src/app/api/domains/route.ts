import { NextResponse } from "next/server";

import { requireSession, requireSuffixAccess } from "@/lib/guards";
import {
  type RegistrationOutcome,
  isDomainSuffix,
  listDomainsForUser,
  registerDomain,
  resolveZone,
  validateRegistration,
} from "@/lib/domains";
import { isContributor } from "@/lib/github";
import { jsonError, readJsonBody } from "@/lib/http";
import { forgetNameservers, lookupNameservers } from "@/lib/dns";
import { assertPersistentStore, rateLimit } from "@/lib/kv";
import { CloudflareError } from "@/lib/cloudflare";
import { RATE_LIMITS, zoneNameFor } from "@/lib/config";
import type { NameserverInput } from "@/lib/types";

interface RegisterBody {
  label?: unknown;
  suffix?: unknown;
  nameservers?: unknown;
}

function asNameservers(value: unknown): NameserverInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (typeof entry === "string") {
      return { host: entry, addresses: [] };
    }
    const record = (entry ?? {}) as Record<string, unknown>;
    const addresses = Array.isArray(record.addresses)
      ? record.addresses.filter((address): address is string => typeof address === "string")
      : typeof record.addresses === "string"
        ? record.addresses.split(/[\s,]+/).filter(Boolean)
        : [];
    return { host: typeof record.host === "string" ? record.host : "", addresses };
  });
}

/**
 * Registers `label.<zone>` for the signed-in user by delegating it to their
 * nameservers with NS records (plus glue A/AAAA where the nameserver lives in
 * the delegated zone).
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertPersistentStore();
  } catch (error) {
    return jsonError(
      503,
      "store_unavailable",
      error instanceof Error ? error.message : "Registration storage is unavailable.",
    );
  }

  const guard = await requireSession(request);
  if (!guard.ok) {
    return guard.response;
  }

  const limited = await rateLimit(
    `domain-create:${guard.user.login}`,
    RATE_LIMITS.domainCreate,
    RATE_LIMITS.domainCreateWindow,
  );
  if (!limited.allowed) {
    return jsonError(429, "rate_limited", "Too many registrations in the last hour.");
  }

  const parsed = await readJsonBody<RegisterBody>(request);
  if (!parsed.ok) {
    return parsed.response;
  }

  const rawLabel = typeof parsed.body.label === "string" ? parsed.body.label : "";
  const rawSuffix = typeof parsed.body.suffix === "string" ? parsed.body.suffix : "verified";

  if (!isDomainSuffix(rawSuffix)) {
    return jsonError(400, "suffix_unknown", `Unknown domain suffix "${rawSuffix}".`);
  }

  const suffixAccess = requireSuffixAccess(guard.user, rawSuffix);
  if (!suffixAccess.ok) {
    return suffixAccess.response;
  }

  const zoneName = zoneNameFor(rawSuffix);
  const nameservers = asNameservers(parsed.body.nameservers);
  const validation = validateRegistration(rawLabel, rawSuffix, nameservers, zoneName);

  if (validation.issues.length > 0) {
    return jsonError(422, "invalid_request", "The registration request is invalid.", validation.issues);
  }

  // Re-check contributor status at write time: the cached session flag could be
  // hours old and access can be revoked upstream.
  if (rawSuffix === "contrib") {
    const contributor = await isContributor(guard.user.login);
    if (!contributor.isContributor) {
      return jsonError(
        403,
        "not_a_contributor",
        `Only contributors to ${contributor.repo} may register *.contrib.resukisu.org.`,
        contributor.detail,
      );
    }
  }

  const fqdn = `${validation.label}.${zoneName}`;
  const publicNameservers = await lookupNameservers(fqdn);
  if (publicNameservers.length > 0) {
    return jsonError(
      409,
      "already_delegated",
      `${fqdn} is already delegated to ${publicNameservers.join(", ")}.`,
    );
  }

  let outcome: RegistrationOutcome;
  try {
    const zone = await resolveZone();
    outcome = await registerDomain({
      login: guard.user.login,
      label: validation.label,
      suffix: rawSuffix,
      zoneId: zone.id,
      nameservers: validation.nameservers,
    });
  } catch (error) {
    if (error instanceof CloudflareError) {
      return jsonError(502, "cloudflare_error", error.message, error.codes);
    }
    return jsonError(
      500,
      "registration_failed",
      error instanceof Error ? error.message : "Registration failed.",
    );
  }

  if (!outcome.ok || !outcome.record) {
    return jsonError(409, "registration_rejected", outcome.error ?? "Registration failed.", {
      rolledBack: outcome.rolledBack ?? null,
    });
  }

  await forgetNameservers(fqdn);

  return NextResponse.json(
    {
      success: true,
      domain: outcome.record,
      records: outcome.record.recordIds.length,
    },
    { status: 201 },
  );
}

/** Lists the domains owned by the signed-in user. */
export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireSession(request);
  if (!guard.ok) {
    return guard.response;
  }

  const domains = await listDomainsForUser(guard.user.login);

  return NextResponse.json({
    success: true,
    user: guard.user.login,
    domains,
  });
}
