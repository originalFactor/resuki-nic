import "server-only";

import { Resolver } from "node:dns/promises";

import { dnsResolvers } from "./config";
import { kvDel, kvGetJson, kvSetJson } from "./kv";

/**
 * Public DNS lookups used to tell whether a name is already delegated by
 * someone else. Cloudflare's API only knows about records in *our* zones, so
 * an empty result there does not mean the name is free.
 */

const NS_CACHE_PREFIX = "dns:ns:";
const NS_CACHE_SECONDS = 120;
const NS_LOOKUP_TIMEOUT_MS = 4000;

export async function lookupNameservers(fqdn: string): Promise<string[]> {
  const name = fqdn.toLowerCase();
  const cacheKey = NS_CACHE_PREFIX + name;

  const cached = await safeKvGet<string[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const resolver = new Resolver({ timeout: NS_LOOKUP_TIMEOUT_MS, tries: 2 });
  resolver.setServers(dnsResolvers());

  let nameservers: string[] = [];
  try {
    nameservers = (await resolver.resolveNs(name)).map((entry) => entry.toLowerCase().replace(/\.+$/, ""));
  } catch {
    nameservers = [];
  }

  await safeKvSet(cacheKey, nameservers, NS_CACHE_SECONDS);
  return nameservers;
}

/** Clears the cached delegation answer, e.g. right after a registration. */
export async function forgetNameservers(fqdn: string): Promise<void> {
  await kvDel(NS_CACHE_PREFIX + fqdn.toLowerCase());
}

async function safeKvGet<T>(key: string): Promise<T | null> {
  try {
    return await kvGetJson<T>(key);
  } catch {
    return null;
  }
}

async function safeKvSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await kvSetJson(key, value, ttlSeconds);
  } catch {
    // DNS answers are an optimisation; failing to cache must not fail the request.
  }
}
