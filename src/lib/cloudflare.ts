import "server-only";

import { cloudflareConfig } from "./config";

/**
 * Thin Cloudflare API v4 client, limited to what subdomain delegation needs:
 * zone lookup and NS/glue record management.
 *
 * Docs: https://developers.cloudflare.com/api/resources/dns/subresources/records/
 *
 * CF_API_BASE exists so the suite can point at a local stub; leave it unset in
 * production so requests always go to Cloudflare.
 */

const API_BASE = process.env.CF_API_BASE?.trim() || "https://api.cloudflare.com/client/v4";

export interface CfEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  messages: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; per_page: number; total_pages: number; count: number };
}

export class CloudflareError extends Error {
  readonly codes: number[];
  readonly status: number;

  constructor(message: string, codes: number[] = [], status = 0) {
    super(message);
    this.name = "CloudflareError";
    this.codes = codes;
    this.status = status;
  }
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number> } = {},
): Promise<T> {
  const config = cloudflareConfig();
  if (!config) {
    throw new CloudflareError(
      "Cloudflare is not configured. Set CLOUDFLARE_API_TOKEN (and CF_ZONE_* if the zones differ from the defaults).",
    );
  }

  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });

  const text = await response.text();
  let envelope: CfEnvelope<T> | null = null;
  try {
    envelope = JSON.parse(text) as CfEnvelope<T>;
  } catch {
    throw new CloudflareError(
      `Cloudflare returned a non-JSON response (${response.status})`,
      [],
      response.status,
    );
  }

  if (!envelope.success) {
    const codes = envelope.errors.map((error) => error.code);
    const messages = envelope.errors.map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new CloudflareError(
      messages || `Cloudflare request failed (${response.status})`,
      codes,
      response.status,
    );
  }

  return envelope.result;
}

/** Looks a zone up by name; the id is required for every DNS record call. */
export async function findZoneByName(name: string): Promise<CfZone | null> {
  const zones = await call<CfZone[]>("/zones", { query: { name, per_page: 50 } });
  return zones.find((zone) => zone.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export interface CreateRecordInput {
  type: "NS" | "A" | "AAAA";
  name: string;
  content: string;
  ttl?: number;
  comment?: string;
}

export async function createRecord(zoneId: string, input: CreateRecordInput): Promise<CfDnsRecord> {
  return call<CfDnsRecord>(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: {
      type: input.type,
      name: input.name,
      content: input.content,
      ttl: input.ttl ?? 300,
      comment: input.comment,
    },
  });
}

export async function deleteRecord(zoneId: string, recordId: string): Promise<void> {
  await call<{ id: string }>(`/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE" });
}

export function cloudflareIsConfigured(): boolean {
  return cloudflareConfig() !== null;
}
