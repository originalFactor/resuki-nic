import { Suspense } from "react";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DomainManager } from "@/components/domain-manager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { readSessionCookie } from "@/lib/auth";
import { cloudflareIsConfigured } from "@/lib/cloudflare";
import { type DomainSuffix, cloudflareZoneName, zoneNameFor } from "@/lib/config";
import { listDomainsForUser } from "@/lib/domains";
import type { DomainRecord } from "@/lib/types";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Both suffixes live in the same parent zone; these are the fully-qualified
 * labels users get to pick names under.
 */
const SUFFIX_ZONES: Record<DomainSuffix, string> = {
  verified: zoneNameFor("verified"),
  contrib: zoneNameFor("contrib"),
};

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-12">
      <div className="mb-6 space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Manage the personal domain delegated to your nameservers.
        </p>
      </div>
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent />
      </Suspense>
    </main>
  );
}

async function DashboardContent() {
  const user = await readSessionCookie();
  if (!user) {
    redirect("/login");
  }

  const domains = await listDomainsForUser(user.login);

  return (
    <>
      {!cloudflareIsConfigured() ? (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>DNS backend not configured</AlertTitle>
          <AlertDescription>
            CLOUDFLARE_API_TOKEN is not set, so registration will fail. Set it together with
            CF_ZONE (currently {cloudflareZoneName()}) to enable delegations.
          </AlertDescription>
        </Alert>
      ) : null}
      <DomainManager user={user} initialDomains={domains as DomainRecord[]} suffixZones={SUFFIX_ZONES} />
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-64" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </CardContent>
      </Card>
    </div>
  );
}
