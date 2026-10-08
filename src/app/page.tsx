import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CONTRIBUTOR_REPO, GHSSH_ORIGIN } from "@/lib/config";

const STEPS = [
  {
    title: "Prove you own a GitHub account",
    body: `You sign a one-time challenge with your SSH key and the verifier at ${GHSSH_ORIGIN.replace(
      /^https?:\/\//,
      "",
    )} checks it against your public keys. No OAuth app, no password.`,
  },
  {
    title: "Pick a name",
    body: "One personal domain per account, either <name>.verified.resukisu.org or — for contributors — <name>.contrib.resukisu.org.",
  },
  {
    title: "Delegate it to your own DNS",
    body: "We create the NS records (and glue, if your nameservers live inside the delegated name) through the Cloudflare API, so the zone stays under your control.",
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-12">
      <section className="space-y-4">
        <Badge variant="outline">Cloudflare-backed DNS delegation</Badge>
        <h1 className="max-w-2xl font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
          Your own domain under resukisu.org
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Sign in with your GitHub SSH key through{" "}
          <a className="underline underline-offset-4" href={GHSSH_ORIGIN}>
            {GHSSH_ORIGIN.replace(/^https?:\/\//, "")}
          </a>{" "}
          and register a subdomain you fully control. We only publish the delegation
          records — the DNS itself stays with your provider.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button render={<Link href="/login" />}>Register a domain</Button>
          <Button variant="outline" render={<Link href="/dashboard" />}>
            Open dashboard
          </Button>
        </div>
      </section>

      <Separator className="my-10" />

      <section className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <Card key={step.title}>
            <CardHeader>
              <CardDescription>Step {index + 1}</CardDescription>
              <CardTitle>{step.title}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{step.body}</CardContent>
          </Card>
        ))}
      </section>

      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-mono text-sm">*.verified.resukisu.org</CardTitle>
            <CardDescription>Available to any verified GitHub account.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            One personal domain per account, delegated with NS records of your choosing.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-mono text-sm">
              *.contrib.resukisu.org
              <Badge variant="secondary">Contributors</Badge>
            </CardTitle>
            <CardDescription>
              Restricted to contributors of{" "}
              <a className="underline underline-offset-4" href={`https://github.com/${CONTRIBUTOR_REPO}`}>
                {CONTRIBUTOR_REPO}
              </a>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Contributor status is re-checked against the GitHub API each time a domain is registered.
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
