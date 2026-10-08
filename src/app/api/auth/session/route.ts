import { NextResponse } from "next/server";

import { readSessionFromRequest } from "@/lib/auth";
import { CONTRIBUTOR_REPO, GHSSH_ORIGIN, type DomainSuffix } from "@/lib/config";
import { cloudflareIsConfigured } from "@/lib/cloudflare";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await readSessionFromRequest(request);

  return NextResponse.json({
    authenticated: user !== null,
    user,
    options: {
      verifier: GHSSH_ORIGIN,
      contributorRepo: CONTRIBUTOR_REPO,
      suffixes: [
        { suffix: "verified" satisfies DomainSuffix, zone: "verified.resukisu.org", requires: "Any verified GitHub account" },
        {
          suffix: "contrib" satisfies DomainSuffix,
          zone: "contrib.resukisu.org",
          requires: `Contributor to ${CONTRIBUTOR_REPO}`,
        },
      ],
      cloudflareConfigured: cloudflareIsConfigured(),
    },
  });
}
