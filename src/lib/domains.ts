import "server-only";

import { DOMAIN_SUFFIXES, type DomainSuffix, cloudflareZoneName, zoneNameFor } from "./config";
import { CloudflareError, createRecord, deleteRecord, findZoneByName } from "./cloudflare";
import { kvGetJson, kvSetAdd, kvSetJson, kvSetMembers, kvSetRemove } from "./kv";
import type { DomainRecord, GlueRecord, NameserverInput } from "./types";

/**
 * Domain registration. A registration is a DNS delegation: NS records for
 * `<label>.<zone>` in the parent zone, plus A/AAAA glue when the chosen
 * nameservers live inside the delegated name (RFC 1912 style in-zone glue).
 */

export const LABEL_MIN = 1;
export const LABEL_MAX = 63;
export const MAX_NAMESERVERS = 7;

/** Labels nobody may claim: they collide with service hostnames. */
const RESERVED_LABELS: Record<string, true> = {
  www: true,
  api: true,
  mail: true,
  ns: true,
  ns1: true,
  ns2: true,
  admin: true,
  root: true,
  status: true,
  dns: true,
  mx: true,
  _dmarc: true,
  localhost: true,
  resukisu: true,
  verified: true,
  contrib: true,
};

export type ValidationIssue =
  | { code: "label_empty"; message: string }
  | { code: "label_too_long"; message: string }
  | { code: "label_charset"; message: string }
  | { code: "label_hyphen"; message: string }
  | { code: "label_reserved"; message: string }
  | { code: "suffix_unknown"; message: string }
  | { code: "nameservers_count"; message: string }
  | { code: "nameserver_host"; message: string }
  | { code: "nameserver_addresses"; message: string }
  | { code: "nameserver_duplicate"; message: string };

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export function normalizeLabel(input: string): string {
  return input.trim().toLowerCase().replace(/\.+$/, "");
}

export function isDomainSuffix(value: string): value is DomainSuffix {
  return (DOMAIN_SUFFIXES as string[]).includes(value);
}

/** Validates the name itself: charset, length, reserved words. */
export function validateLabel(
  rawLabel: string,
  rawSuffix: string,
  zoneName: string,
): { label: string; suffix: DomainSuffix; fqdn: string; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const label = normalizeLabel(rawLabel);

  if (!isDomainSuffix(rawSuffix)) {
    issues.push({ code: "suffix_unknown", message: `Unknown domain suffix "${rawSuffix}".` });
  }
  const suffix: DomainSuffix = isDomainSuffix(rawSuffix) ? rawSuffix : "verified";

  if (label.length === 0) {
    issues.push({ code: "label_empty", message: "Enter a name for your domain." });
  } else if (label.length > LABEL_MAX) {
    issues.push({ code: "label_too_long", message: `Names may be at most ${LABEL_MAX} characters.` });
  } else if (!LABEL_PATTERN.test(label)) {
    issues.push({
      code: "label_charset",
      message: "Use lowercase letters, digits and hyphens only; no leading or trailing hyphen.",
    });
  } else if (RESERVED_LABELS[label]) {
    issues.push({ code: "label_reserved", message: `"${label}" is reserved.` });
  }

  return { label, suffix, fqdn: `${label}.${zoneName}`, issues };
}

/** Validates the delegation target: hostname shape, duplicates, glue needs. */
export function validateNameservers(
  nameservers: NameserverInput[],
  zoneName: string,
): { nameservers: NameserverInput[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const cleaned: NameserverInput[] = [];
  const seen = new Set<string>();

  for (const entry of nameservers) {
    const host = entry.host?.trim().toLowerCase().replace(/\.+$/, "") ?? "";
    if (!HOST_PATTERN.test(host)) {
      issues.push({ code: "nameserver_host", message: `"${entry.host}" is not a valid nameserver hostname.` });
      continue;
    }
    if (seen.has(host)) {
      issues.push({ code: "nameserver_duplicate", message: `Nameserver "${host}" is listed twice.` });
      continue;
    }
    seen.add(host);

    const addresses = Array.from(
      new Set((entry.addresses ?? []).map((address) => address.trim()).filter(Boolean)),
    );

    if (host.endsWith(`.${zoneName.toLowerCase()}`) && addresses.length === 0) {
      issues.push({
        code: "nameserver_addresses",
        message: `"${host}" is inside ${zoneName}, so at least one IPv4 or IPv6 address is required for glue.`,
      });
      continue;
    }

    for (const address of addresses) {
      if (!isIpAddress(address)) {
        issues.push({ code: "nameserver_addresses", message: `"${address}" is not a valid IP address.` });
      }
    }

    cleaned.push({ host, addresses });
  }

  if (cleaned.length === 0) {
    issues.push({ code: "nameservers_count", message: "Provide at least one nameserver." });
  } else if (cleaned.length > MAX_NAMESERVERS) {
    issues.push({
      code: "nameservers_count",
      message: `Provide at most ${MAX_NAMESERVERS} nameservers (RFC 1912 recommends 7 or fewer).`,
    });
  }

  return { nameservers: cleaned, issues };
}

/** Full validation of a registration request: name plus delegation target. */
export function validateRegistration(
  rawLabel: string,
  rawSuffix: string,
  nameservers: NameserverInput[],
  zoneName: string,
): { label: string; suffix: DomainSuffix; nameservers: NameserverInput[]; issues: ValidationIssue[] } {
  const label = validateLabel(rawLabel, rawSuffix, zoneName);
  // Nameserver shape is only meaningful once the name itself is usable.
  const hosts = label.issues.length === 0 ? validateNameservers(nameservers, zoneName) : { nameservers: [], issues: [] as ValidationIssue[] };

  return {
    label: label.label,
    suffix: label.suffix,
    nameservers: hosts.nameservers,
    issues: [...label.issues, ...hosts.issues],
  };
}

function isIpAddress(value: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":");
}

function fqdnFor(label: string, zoneName: string): string {
  return `${label}.${zoneName}`;
}

function domainKey(fqdn: string): string {
  return `domain:fqdn:${fqdn.toLowerCase()}`;
}

function ownerKey(login: string, suffix: DomainSuffix): string {
  return `domain:owner:${suffix}:${login.toLowerCase()}`;
}

function userIndexKey(login: string): string {
  return `domain:index:${login.toLowerCase()}`;
}

export async function getDomainByFqdn(fqdn: string): Promise<DomainRecord | null> {
  return kvGetJson<DomainRecord>(domainKey(fqdn));
}

export async function getOwnedDomain(
  login: string,
  suffix: DomainSuffix,
): Promise<DomainRecord | null> {
  return kvGetJson<DomainRecord>(ownerKey(login, suffix));
}

export async function listDomainsForUser(login: string): Promise<DomainRecord[]> {
  const fqdns = await kvSetMembers(userIndexKey(login));
  const records = await Promise.all(fqdns.map((fqdn) => getDomainByFqdn(fqdn)));
  return records
    .filter((record): record is DomainRecord => record !== null)
    .sort((a, b) => a.fqdn.localeCompare(b.fqdn));
}

export interface RegistrationOutcome {
  ok: boolean;
  record?: DomainRecord;
  error?: string;
  /** Records that were created and then rolled back. */
  rolledBack?: boolean;
}

export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationError";
  }
}

/**
 * Delegates `<label>.<zone>` to the caller's nameservers.
 *
 * Ordering matters: NS records are created first so that a failure partway
 * through glue creation still leaves a resolvable delegation whenever the
 * nameservers are out-of-zone. Any failure after the first write triggers a
 * rollback of everything this call created.
 */
export async function registerDomain(options: {
  login: string;
  label: string;
  suffix: DomainSuffix;
  zoneId: string;
  nameservers: NameserverInput[];
}): Promise<RegistrationOutcome> {
  const zoneName = zoneNameFor(options.suffix);
  const fqdn = fqdnFor(options.label, zoneName);

  const existing = await getDomainByFqdn(fqdn);
  if (existing) {
    return { ok: false, error: `${fqdn} is already registered.` };
  }

  const owned = await getOwnedDomain(options.login, options.suffix);
  if (owned) {
    return {
      ok: false,
      error: `You already registered ${owned.fqdn}. Delete it before registering another.`,
    };
  }

  const created: string[] = [];
  const glue: GlueRecord[] = [];

  try {
    for (const nameserver of options.nameservers) {
      const record = await createRecord(options.zoneId, {
        type: "NS",
        name: fqdn,
        content: nameserver.host,
        ttl: 300,
        comment: `resuki-nic delegation for ${options.login}`,
      });
      created.push(record.id);
    }

    for (const nameserver of options.nameservers) {
      if (!nameserver.host.endsWith(`.${zoneName.toLowerCase()}`)) {
        continue;
      }

      const addresses = nameserver.addresses ?? [];
      const recordIds: string[] = [];
      for (const address of addresses) {
        const record = await createRecord(options.zoneId, {
          type: address.includes(":") ? "AAAA" : "A",
          name: nameserver.host,
          content: address,
          ttl: 300,
          comment: `resuki-nic glue for ${fqdn}`,
        });
        recordIds.push(record.id);
        created.push(record.id);
      }
      glue.push({ host: nameserver.host, addresses, recordIds });
    }

    const record: DomainRecord = {
      fqdn,
      label: options.label,
      suffix: options.suffix,
      zone: zoneName,
      zoneId: options.zoneId,
      owner: options.login,
      nameservers: options.nameservers.map((entry) => entry.host),
      glue,
      recordIds: created,
      createdAt: new Date().toISOString(),
    };

    await kvSetJson(domainKey(fqdn), record);
    await kvSetJson(ownerKey(options.login, options.suffix), record);
    await kvSetAdd(userIndexKey(options.login), fqdn);

    return { ok: true, record };
  } catch (error) {
    let rollbackFailed = false;
    for (const recordId of created) {
      try {
        await deleteRecord(options.zoneId, recordId);
      } catch {
        rollbackFailed = true;
      }
    }

    const detail =
      error instanceof CloudflareError
        ? error.message
        : error instanceof Error
          ? error.message
          : "unknown error";

    return {
      ok: false,
      error: rollbackFailed
        ? `${detail} — and cleaning up the partial delegation failed. Check the zone manually.`
        : detail,
      rolledBack: !rollbackFailed,
    };
  }
}

export interface DeletionOutcome {
  ok: boolean;
  error?: string;
  deleted?: DomainRecord;
}

export async function deleteDomain(
  login: string,
  fqdn: string,
): Promise<DeletionOutcome> {
  const record = await getDomainByFqdn(fqdn);
  if (!record) {
    return { ok: false, error: `${fqdn} is not registered.` };
  }
  if (record.owner.toLowerCase() !== login.toLowerCase()) {
    return { ok: false, error: "You do not own this domain." };
  }

  const failures: string[] = [];
  for (const recordId of [...record.recordIds].reverse()) {
    try {
      await deleteRecord(record.zoneId, recordId);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      error: `Cloudflare refused part of the cleanup: ${failures.join("; ")}`,
    };
  }

  await kvSetRemove(userIndexKey(record.owner), record.fqdn);
  await kvSetJson(domainKey(record.fqdn), null);
  await kvSetJson(ownerKey(record.owner, record.suffix), null);

  return { ok: true, deleted: record };
}

const ZONE_CACHE_SECONDS = 600;

export interface ResolvedZone {
  id: string;
  name: string;
}

/**
 * Looks up (and briefly caches) the Cloudflare zone id. Every delegation is a
 * record set inside this one zone, whichever suffix it belongs to.
 */
export async function resolveZone(): Promise<ResolvedZone> {
  const name = cloudflareZoneName();
  const cacheKey = `cf:zone:${name.toLowerCase()}`;
  const cached = await kvGetJson<ResolvedZone>(cacheKey);
  if (cached?.id) {
    return cached;
  }

  const zone = await findZoneByName(name);
  if (!zone) {
    throw new RegistrationError(
      `Zone ${name} was not found on this Cloudflare account. Add the zone or set CF_ZONE.`,
    );
  }

  const resolved: ResolvedZone = { id: zone.id, name: zone.name };
  await kvSetJson(cacheKey, resolved, ZONE_CACHE_SECONDS);
  return resolved;
}
