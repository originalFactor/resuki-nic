import "server-only";

/**
 * Central environment access. Nothing here throws at import time so that
 * `next build` can prerender pages without credentials present.
 */

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readBool(name: string): boolean {
  const value = read(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export const GHSSH_ORIGIN = read("GHSSH_ORIGIN") ?? "https://verify.resukisu.org";

export const isProduction = process.env.NODE_ENV === "production";

/** Set when the deployment sits behind a trusted proxy (Vercel always is). */
const trustProxy = process.env.VERCEL === "1" || readBool("TRUST_PROXY");

/**
 * Public origin of this app. Used to build the callback/redirect URLs handed to
 * the verifier, which are called server-to-server and by the browser.
 */
export function resolveOrigin(request?: Request): string {
  const configured = read("APP_ORIGIN");
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  if (request) {
    const url = new URL(request.url);
    if (trustProxy) {
      const host = request.headers.get("x-forwarded-host") ?? url.host;
      const proto = request.headers.get("x-forwarded-proto") ?? "https";
      return `${proto}://${host}`;
    }
    return url.origin;
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3000";
}

const DEV_SESSION_SECRET = "resuki-nic-insecure-development-session-secret";

/** HMAC key for session cookies. Required in production. */
export function sessionSecret(): string {
  const secret = read("SESSION_SECRET");
  if (secret) {
    return secret;
  }
  if (isProduction) {
    throw new Error(
      "SESSION_SECRET is required in production. Generate one with `openssl rand -base64 48`.",
    );
  }
  return DEV_SESSION_SECRET;
}

export function sessionSecretIsDevFallback(): boolean {
  return !read("SESSION_SECRET");
}

export interface KvConfig {
  url: string;
  token: string;
}

export function kvConfig(): KvConfig | null {
  const url = read("KV_REST_API_URL") ?? read("UPSTASH_REDIS_REST_URL");
  const token = read("KV_REST_API_TOKEN") ?? read("UPSTASH_REDIS_REST_TOKEN");
  if (!url || !token) {
    return null;
  }
  return { url, token };
}

export interface CloudflareConfig {
  token: string;
  /** The single zone that holds every delegation. */
  zone: string;
  /** How long a cached DNS answer is trusted, in seconds. */
  cacheTtlSeconds: number;
}

export type DomainSuffix = "verified" | "contrib";

export const DOMAIN_SUFFIXES: DomainSuffix[] = ["verified", "contrib"];

export function cloudflareConfig(): CloudflareConfig | null {
  const token = read("CLOUDFLARE_API_TOKEN");
  if (!token) {
    return null;
  }
  return {
    token,
    zone: read("CF_ZONE") ?? "resukisu.org",
    cacheTtlSeconds: Number(read("CF_CACHE_TTL_SECONDS") ?? "60"),
  };
}

export const GITHUB_API = read("GITHUB_API_BASE") ?? "https://api.github.com";
export const GITHUB_TOKEN = read("GITHUB_TOKEN");

/** Repository whose contributors may register `*.contrib.resukisu.org`. */
export const CONTRIBUTOR_REPO = read("CONTRIBUTOR_REPO") ?? "Baka-SU/BakaSU";

export const CONTRIBUTOR_CACHE_SECONDS = Number(read("CONTRIBUTOR_CACHE_SECONDS") ?? "3600");

/** Lifetime of a pending login challenge, in seconds. Must stay under 300 to
 * match the verifier's own signing window. */
export const CHALLENGE_TTL_SECONDS = 240;

/** Session cookie lifetime. */
export const SESSION_TTL_SECONDS = Number(read("SESSION_TTL_SECONDS") ?? String(7 * 24 * 3600));

export const MEMORY_STORE_ALLOWED = !isProduction || readBool("ALLOW_MEMORY_STORE");

/**
 * Fully-qualified zone that backs a registrable suffix.
 *
 * Both suffixes live in one Cloudflare zone (the parent domain): users get
 * `<label>.<suffix>.<parent>`, and the delegation records are created there.
 * A per-suffix zone would require Cloudflare's Enterprise-only "subdomain
 * setup", so it is deliberately not supported.
 */
export function cloudflareZoneName(): string {
  return cloudflareConfig()?.zone ?? "resukisu.org";
}

export function zoneNameFor(suffix: DomainSuffix): string {
  return `${suffix}.${cloudflareZoneName()}`;
}

/**
 * Recursive resolvers used to ask whether a name is already delegated.
 * DNS_RESOLVERS exists so a test suite can point at a local stub; production
 * leaves it unset and gets Cloudflare's and Google's public resolvers.
 */
export function dnsResolvers(): string[] {
  const raw = read("DNS_RESOLVERS");
  const configured = raw
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured && configured.length > 0 ? configured : ["1.1.1.1", "8.8.8.8"];
}

/**
 * Fixed-window rate limits. They are configuration because a local harness
 * needs to run the same flow repeatedly, and operators may want to tighten or
 * loosen them per environment.
 */
export const RATE_LIMITS = {
  loginStart: Number(read("RATE_LIMIT_LOGIN_START") ?? "20"),
  loginStartWindow: Number(read("RATE_LIMIT_LOGIN_START_WINDOW") ?? "600"),
  authCallback: Number(read("RATE_LIMIT_AUTH_CALLBACK") ?? "10"),
  authCallbackWindow: Number(read("RATE_LIMIT_AUTH_CALLBACK_WINDOW") ?? "300"),
  domainCheck: Number(read("RATE_LIMIT_DOMAIN_CHECK") ?? "120"),
  domainCheckWindow: Number(read("RATE_LIMIT_DOMAIN_CHECK_WINDOW") ?? "600"),
  domainCreate: Number(read("RATE_LIMIT_DOMAIN_CREATE") ?? "10"),
  domainCreateWindow: Number(read("RATE_LIMIT_DOMAIN_CREATE_WINDOW") ?? "3600"),
} as const;
