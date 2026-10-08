import { NextResponse } from "next/server";

import { cloudflareIsConfigured } from "@/lib/cloudflare";
import {
  CONTRIBUTOR_REPO,
  GHSSH_ORIGIN,
  cloudflareConfig,
  kvConfig,
  sessionSecretIsDevFallback,
} from "@/lib/config";
import { kvBackend, kvIsConfigured } from "@/lib/kv";

export async function GET() {
  const problems: string[] = [];

  if (!kvIsConfigured() && process.env.NODE_ENV === "production") {
    problems.push("KV_REST_API_URL / KV_REST_API_TOKEN are missing.");
  }
  if (!cloudflareIsConfigured()) {
    problems.push("CLOUDFLARE_API_TOKEN is missing; domain registration is disabled.");
  }
  if (sessionSecretIsDevFallback() && process.env.NODE_ENV === "production") {
    problems.push("SESSION_SECRET is missing.");
  }

  const zone = cloudflareConfig()?.zone ?? null;

  return NextResponse.json(
    {
      ok: problems.length === 0,
      problems,
      verifier: GHSSH_ORIGIN,
      contributorRepo: CONTRIBUTOR_REPO,
      store: {
        backend: kvBackend(),
        configured: kvIsConfigured(),
        hasCredentials: kvConfig() !== null,
      },
      cloudflare: { configured: cloudflareIsConfigured(), zone },
    },
    { status: problems.length === 0 ? 200 : 503 },
  );
}
