"use client";

import { useCallback, useState } from "react";

import Link from "next/link";
import { CheckCircle2Icon, KeyRoundIcon } from "lucide-react";

import { GithubMark } from "@/components/github-mark";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

interface StartResponse {
  authorizeUrl?: string;
  error?: string;
}

/**
 * The sign-in form never sees an SSH key: it starts a login with our API and
 * hands the browser to the verifier. The verifier comes back through
 * /api/auth/finalize, which sets the session cookie, so this page only needs
 * to get the user there.
 */
export function LoginForm({ initialError }: { initialError?: string }) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const response = await fetch("/api/auth/start", { method: "POST" });
      const body = (await response.json()) as StartResponse;
      if (!response.ok || !body.authorizeUrl) {
        setStartError(body.error ?? "Could not start the login flow.");
        setStarting(false);
        return;
      }

      // Same-tab navigation: the verifier redirects back to
      // /api/auth/finalize, which lands the user on the dashboard.
      window.location.assign(body.authorizeUrl);
    } catch {
      setStartError("Network error while starting the login flow.");
      setStarting(false);
    }
  }, []);

  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" />
          Sign in with your GitHub SSH key
        </CardTitle>
        <CardDescription>
          You will be handed to the verifier, sign a one-time challenge with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">ssh-keygen -Y sign</code>, and
          come back with a session.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {initialError ? (
          <Alert variant="destructive">
            <AlertTitle>Sign-in did not complete</AlertTitle>
            <AlertDescription>{describeError(initialError)}</AlertDescription>
          </Alert>
        ) : null}

        {startError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not start the login flow</AlertTitle>
            <AlertDescription>{startError}</AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup>
          <Field>
            <FieldLabel>GitHub account</FieldLabel>
            <Input placeholder="checked by the verifier, not entered here" disabled />
            <FieldDescription>
              Your GitHub username is read from the signed challenge — this app never asks for it.
            </FieldDescription>
          </Field>

          <Button onClick={start} disabled={starting} className="w-full">
            {starting ? <Spinner /> : <GithubMark />}
            {starting ? "Preparing challenge…" : "Continue to the verifier"}
          </Button>
        </FieldGroup>

        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>What this app stores</AlertTitle>
          <AlertDescription>
            Only your GitHub login, the key id that verified, and the domains you register. The SSH
            signature is verified and discarded.
          </AlertDescription>
        </Alert>

        <p className="text-xs text-muted-foreground">
          Already have a session?{" "}
          <Link className="underline underline-offset-4" href="/dashboard">
            Go to the dashboard
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

function describeError(code: string): string {
  switch (code) {
    case "missing_code":
      return "The verifier did not include a challenge code in the redirect. Start the sign-in again.";
    case "flow_mismatch":
      return "This browser did not start the login that just finished. Start again from this tab.";
    case "not_verified":
      return "The challenge expired or was already used. Start the sign-in again.";
    default:
      return "Something went wrong during verification. Start again.";
  }
}
