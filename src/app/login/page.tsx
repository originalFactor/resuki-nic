import { Suspense } from "react";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { Skeleton } from "@/components/ui/skeleton";
import { readSessionCookie } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 items-start justify-center px-4 py-12">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-xl rounded-xl" />}>
        <LoginContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function LoginContent({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const user = await readSessionCookie();
  if (user) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;

  return <LoginForm initialError={error} />;
}
