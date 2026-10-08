import { Suspense } from "react";

import Link from "next/link";

import { readSessionCookie } from "@/lib/auth";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The header reads the session cookie, so it cannot be part of the static
 * shell: `UserNav` streams in behind its own Suspense boundary.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-heading text-sm font-medium">
          <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
            <span className="text-xs">r</span>
          </span>
          resuki-nic
        </Link>
        <Suspense fallback={<Skeleton className="h-7 w-40 rounded-lg" />}>
          <SessionNav />
        </Suspense>
      </div>
    </header>
  );
}

async function SessionNav() {
  const user = await readSessionCookie();
  return <NavLinks login={user?.login ?? null} />;
}

function NavLinks({ login }: { login: string | null }) {
  return (
    <nav className="flex items-center gap-1 text-sm">
      <Link
        className="rounded-lg px-2.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        href="/"
      >
        Overview
      </Link>
      {login ? (
        <Link
          className="rounded-lg px-2.5 py-1 font-medium transition-colors hover:bg-muted"
          href="/dashboard"
        >
          {login}
        </Link>
      ) : (
        <Link
          className="rounded-lg bg-primary px-2.5 py-1 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
          href="/login"
        >
          Sign in
        </Link>
      )}
    </nav>
  );
}
