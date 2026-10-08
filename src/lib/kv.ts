import "server-only";

import { kvConfig, MEMORY_STORE_ALLOWED } from "./config";

/**
 * Minimal key/value store over the Upstash Redis REST protocol (the protocol
 * used by Vercel KV). Commands are issued as JSON arrays, which Upstash maps
 * 1:1 onto Redis commands.
 *
 * When no KV credentials are configured we fall back to an in-process Map so
 * `next dev` works out of the box. That fallback is dev-only: in production it
 * is refused unless ALLOW_MEMORY_STORE=1 (see assertPersistentStore).
 */

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

const memory = new Map<string, MemoryEntry>();
const memorySets = new Map<string, Set<string>>();

let warnedAboutMemory = false;

function memoryStore(): void {
  if (!MEMORY_STORE_ALLOWED) {
    throw new Error(
      "No KV store configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel KV / Upstash).",
    );
  }
  if (!warnedAboutMemory) {
    warnedAboutMemory = true;
    console.warn(
      "[kv] Using the in-process memory store. Configure KV_REST_API_URL/KV_REST_API_TOKEN for durable, multi-instance state.",
    );
  }
}

export function kvIsConfigured(): boolean {
  return kvConfig() !== null;
}

export function kvBackend(): "upstash" | "memory" {
  return kvIsConfigured() ? "upstash" : "memory";
}

/** Throws when the app is running without a durable store in production. */
export function assertPersistentStore(): void {
  if (!kvIsConfigured()) {
    memoryStore();
  }
}

async function redis(command: (string | number)[]): Promise<unknown> {
  const config = kvConfig();
  if (!config) {
    throw new Error("kv not configured");
  }

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command.map((part) => String(part))),
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`kv request failed: ${response.status} ${text.slice(0, 200)}`);
  }

  let parsed: { result?: unknown; error?: string };
  try {
    parsed = JSON.parse(text) as { result?: unknown; error?: string };
  } catch {
    throw new Error(`kv returned a non-JSON body: ${text.slice(0, 200)}`);
  }

  if (parsed.error) {
    throw new Error(`kv error: ${parsed.error}`);
  }

  return parsed.result;
}

function sweep(now: number): void {
  for (const [key, entry] of memory) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      memory.delete(key);
    }
  }
}

export async function kvGet(key: string): Promise<string | null> {
  if (kvIsConfigured()) {
    const result = await redis(["GET", key]);
    return typeof result === "string" ? result : null;
  }

  memoryStore();
  const now = Date.now();
  sweep(now);
  const entry = memory.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt !== null && entry.expiresAt <= now) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

export async function kvSet(
  key: string,
  value: string,
  ttlSeconds?: number,
): Promise<void> {
  if (kvIsConfigured()) {
    if (ttlSeconds) {
      await redis(["SET", key, value, "EX", ttlSeconds]);
    } else {
      await redis(["SET", key, value]);
    }
    return;
  }

  memoryStore();
  memory.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
}

/**
 * Sets a key only when it does not already exist.
 * Returns true when this call created the key.
 */
export async function kvSetIfAbsent(
  key: string,
  value: string,
  ttlSeconds?: number,
): Promise<boolean> {
  if (kvIsConfigured()) {
    const command: (string | number)[] = ["SET", key, value, "NX"];
    if (ttlSeconds) {
      command.push("EX", ttlSeconds);
    }
    const result = await redis(command);
    return result === "OK";
  }

  memoryStore();
  const existing = await kvGet(key);
  if (existing !== null) {
    return false;
  }
  await kvSet(key, value, ttlSeconds);
  return true;
}

export async function kvDel(key: string): Promise<void> {
  if (kvIsConfigured()) {
    await redis(["DEL", key]);
    return;
  }
  memoryStore();
  memory.delete(key);
}

/**
 * Reads a key and deletes it in one step, so a value can only be consumed
 * once even when two requests race (used for single-use login artifacts).
 * Returns null when the key was absent.
 */
export async function kvTake(key: string): Promise<string | null> {
  if (kvIsConfigured()) {
    const result = await redis(["GETDEL", key]);
    return typeof result === "string" ? result : null;
  }

  memoryStore();
  const value = await kvGet(key);
  if (value === null) {
    return null;
  }
  memory.delete(key);
  return value;
}

export async function kvTakeJson<T>(key: string): Promise<T | null> {
  const raw = await kvTake(key);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvGetJson<T>(key: string): Promise<T | null> {
  const raw = await kvGet(key);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvSetJson(
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  await kvSet(key, JSON.stringify(value), ttlSeconds);
}

export async function kvSetAdd(setKey: string, member: string): Promise<void> {
  if (kvIsConfigured()) {
    await redis(["SADD", setKey, member]);
    return;
  }
  memoryStore();
  const set = memorySets.get(setKey) ?? new Set<string>();
  set.add(member);
  memorySets.set(setKey, set);
}

export async function kvSetRemove(setKey: string, member: string): Promise<void> {
  if (kvIsConfigured()) {
    await redis(["SREM", setKey, member]);
    return;
  }
  memoryStore();
  memorySets.get(setKey)?.delete(member);
}

export async function kvSetMembers(setKey: string): Promise<string[]> {
  if (kvIsConfigured()) {
    const result = await redis(["SMEMBERS", setKey]);
    return Array.isArray(result) ? (result as string[]) : [];
  }
  memoryStore();
  return Array.from(memorySets.get(setKey) ?? []);
}

/**
 * Increments a counter and returns the new value. A TTL is applied on the
 * first increment so the window decays on its own.
 */
export async function kvIncrement(
  key: string,
  ttlSeconds: number,
): Promise<number> {
  if (kvIsConfigured()) {
    const count = Number(await redis(["INCR", key]));
    if (count === 1) {
      await redis(["EXPIRE", key, ttlSeconds]);
    }
    return count;
  }

  memoryStore();
  const now = Date.now();
  sweep(now);
  const entry = memory.get(key);
  const current = entry ? Number(entry.value) : 0;
  const next = (Number.isFinite(current) ? current : 0) + 1;
  memory.set(key, {
    value: String(next),
    expiresAt: entry?.expiresAt ?? now + ttlSeconds * 1000,
  });
  return next;
}

/**
 * Fixed-window rate limit. Returns the remaining allowance; negative numbers
 * mean the caller is over budget.
 */
export async function rateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const used = await kvIncrement(`ratelimit:${bucket}:${Math.floor(Date.now() / (windowSeconds * 1000))}`, windowSeconds);
  return { allowed: used <= limit, used, limit };
}
