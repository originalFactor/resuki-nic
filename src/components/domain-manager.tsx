"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useRouter } from "next/navigation";
import { AlertTriangleIcon, CheckIcon, Loader2Icon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DomainSuffix } from "@/lib/config";
import type { DomainRecord, SessionUser } from "@/lib/types";

interface CheckPayload {
  available: boolean;
  issues: { code: string; message: string }[];
  takenBy: string | null;
  existingNameservers: string[];
}

interface Probe {
  /** Cache key the result belongs to; anything else is treated as stale. */
  key: string;
  payload: CheckPayload | null;
}

interface NameserverRow {
  id: number;
  host: string;
  addresses: string;
}

let rowCounter = 0;
function newRow(host = "", addresses = ""): NameserverRow {
  rowCounter += 1;
  return { id: rowCounter, host, addresses };
}

export function DomainManager({
  user,
  initialDomains,
  suffixZones,
}: {
  user: SessionUser;
  initialDomains: DomainRecord[];
  suffixZones: Record<DomainSuffix, string>;
}) {
  const router = useRouter();
  const [domains, setDomains] = useState<DomainRecord[]>(initialDomains);
  const [suffix, setSuffix] = useState<DomainSuffix>("verified");
  const [label, setLabel] = useState("");
  const [rows, setRows] = useState<NameserverRow[]>([newRow("ns1.example.com"), newRow("ns2.example.com")]);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<DomainRecord | null>(null);

  const suffixLocked = !user.canRegisterContrib;
  const ownedForSuffix = useMemo(
    () => domains.find((domain) => domain.suffix === suffix) ?? null,
    [domains, suffix],
  );

  const trimmedLabel = label.trim();
  const probeKey = trimmedLabel && !ownedForSuffix ? `${suffix}:${trimmedLabel}` : null;

  const refreshDomains = useCallback(async () => {
    const response = await fetch("/api/domains", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { domains?: DomainRecord[] };
    setDomains(body.domains ?? []);
  }, []);

  /**
   * Debounced availability probe. State is only set from the timer callback,
   * so the effect itself never triggers a cascading render; `availability`
   * below derives "loading" from the key mismatch in the meantime.
   */
  useEffect(() => {
    if (!probeKey) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/domains/check?label=${encodeURIComponent(trimmedLabel)}&suffix=${suffix}`,
          { signal: controller.signal, cache: "no-store" },
        );
        const body = (await response.json()) as Partial<CheckPayload> & { error?: string };
        if (!response.ok) {
          setProbe({
            key: probeKey,
            payload: {
              available: false,
              issues: [{ code: "error", message: body.error ?? "Check failed." }],
              takenBy: null,
              existingNameservers: [],
            },
          });
          return;
        }
        setProbe({
          key: probeKey,
          payload: {
            available: body.available === true,
            issues: body.issues ?? [],
            takenBy: body.takenBy ?? null,
            existingNameservers: body.existingNameservers ?? [],
          },
        });
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setProbe({
            key: probeKey,
            payload: {
              available: false,
              issues: [{ code: "error", message: "Could not reach the availability check." }],
              takenBy: null,
              existingNameservers: [],
            },
          });
        }
      }
    }, 350);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [probeKey, suffix, trimmedLabel]);

  const availability: CheckPayload & { loading: boolean } = useMemo(() => {
    if (!probeKey) {
      return { loading: false, available: false, issues: [], takenBy: null, existingNameservers: [] };
    }
    if (!probe || probe.key !== probeKey || !probe.payload) {
      return { loading: true, available: false, issues: [], takenBy: null, existingNameservers: [] };
    }
    return { loading: false, ...probe.payload };
  }, [probe, probeKey]);

  const submit = async () => {
    setSubmitting(true);
    try {
      const response = await fetch("/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: trimmedLabel,
          suffix,
          nameservers: rows
            .filter((row) => row.host.trim())
            .map((row) => ({
              host: row.host.trim(),
              addresses: row.addresses.split(/[\s,]+/).filter(Boolean),
            })),
        }),
      });

      const body = (await response.json()) as {
        error?: string;
        domain?: DomainRecord;
        details?: unknown;
      };

      if (!response.ok || !body.domain) {
        const detail = Array.isArray(body.details)
          ? (body.details as { message: string }[]).map((issue) => issue.message).join(" ")
          : typeof body.details === "string"
            ? body.details
            : "";
        toast.error(`${body.error ?? "Registration failed."} ${detail}`.trim());
        return;
      }

      toast.success(`${body.domain.fqdn} is delegated.`);
      setLabel("");
      setProbe(null);
      setRows([newRow(), newRow()]);
      await refreshDomains();
    } catch {
      toast.error("Network error during registration.");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) {
      return;
    }
    const target = deleting;
    setDeleting(null);
    try {
      const response = await fetch(`/api/domains/delete?fqdn=${encodeURIComponent(target.fqdn)}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        toast.error(body.error ?? "Deletion failed.");
        return;
      }
      toast.success(`${target.fqdn} was removed.`);
      setProbe(null);
      await refreshDomains();
    } catch {
      toast.error("Network error during deletion.");
    }
  };

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  };

  return (
    <div className="space-y-6">
      <AccountCard user={user} suffixZones={suffixZones} onSignOut={signOut} />

      <Card>
        <CardHeader>
          <CardTitle>Register a domain</CardTitle>
          <CardDescription>
            One domain per account per zone. Enter the nameservers that should become authoritative for
            it; we publish the delegation records through the Cloudflare API.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Tabs value={suffix} onValueChange={(value) => setSuffix(value as DomainSuffix)}>
            <TabsList>
              <TabsTrigger value="verified">{suffixZones.verified}</TabsTrigger>
              <TabsTrigger value="contrib" disabled={suffixLocked}>
                {suffixZones.contrib}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {suffixLocked && suffix === "contrib" ? (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>Contributor access required</AlertTitle>
              <AlertDescription>
                This suffix is limited to contributors of the upstream repository.
              </AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="label">Name</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value.toLowerCase())}
                  placeholder="yourname"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={availability.issues.length > 0}
                />
                <span className="shrink-0 font-mono text-sm text-muted-foreground">
                  .{suffixZones[suffix]}
                </span>
              </div>
              <AvailabilityHint state={availability} label={trimmedLabel} />
            </Field>
          </FieldGroup>

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Nameservers</p>
                <p className="text-xs text-muted-foreground">
                  Up to seven. Addresses are only needed when the nameserver lives inside the delegated
                  name, where we add glue records.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRows((current) => [...current, newRow()])}
                disabled={rows.length >= 7}
              >
                <PlusIcon />
                Add
              </Button>
            </div>

            <div className="space-y-3">
              {rows.map((row, index) => (
                <div key={row.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <Input
                    aria-label={`Nameserver ${index + 1} hostname`}
                    value={row.host}
                    placeholder="ns1.example.com"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((entry) =>
                          entry.id === row.id ? { ...entry, host: event.target.value.toLowerCase() } : entry,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label={`Nameserver ${index + 1} IP addresses`}
                    value={row.addresses}
                    placeholder="glue IPs, space separated"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((entry) =>
                          entry.id === row.id ? { ...entry, addresses: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove nameserver ${index + 1}`}
                    onClick={() =>
                      setRows((current) =>
                        current.length === 1 ? current : current.filter((entry) => entry.id !== row.id),
                      )
                    }
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {ownedForSuffix ? (
            <Alert>
              <AlertTitle>You already own a domain in this zone</AlertTitle>
              <AlertDescription>
                {ownedForSuffix.fqdn} — delete it first if you want to register a different name.
              </AlertDescription>
            </Alert>
          ) : null}

          <Button
            onClick={submit}
            disabled={
              submitting ||
              !!ownedForSuffix ||
              !availability.available ||
              rows.every((row) => !row.host.trim())
            }
            className="w-full"
          >
            {submitting ? <Spinner /> : null}
            {submitting ? "Delegating…" : `Register ${trimmedLabel || "<name>"}.${suffixZones[suffix]}`}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your domains</CardTitle>
          <CardDescription>
            Delegations created by this app. Removing one deletes its NS and glue records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">No domains registered yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Nameservers</TableHead>
                  <TableHead>Glue</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((domain) => (
                  <TableRow key={domain.fqdn}>
                    <TableCell className="font-mono text-xs">{domain.fqdn}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {domain.nameservers.join(", ")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {domain.glue.length === 0
                        ? "—"
                        : domain.glue
                            .map((entry) => `${entry.host} (${entry.addresses.join(", ")})`)
                            .join(", ")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(domain.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="destructive" size="sm" onClick={() => setDeleting(domain)}>
                        <Trash2Icon />
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.fqdn}?</AlertDialogTitle>
            <AlertDialogDescription>
              The NS records and any glue records for this delegation are removed from Cloudflare. Your
              nameservers keep whatever data they hold.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AvailabilityHint({
  state,
  label,
}: {
  state: CheckPayload & { loading: boolean };
  label: string;
}) {
  if (!label) {
    return <FieldDescription>Lowercase letters, digits and hyphens.</FieldDescription>;
  }

  if (state.loading) {
    return (
      <FieldDescription className="flex items-center gap-2">
        <Loader2Icon className="size-3 animate-spin" />
        Checking availability…
      </FieldDescription>
    );
  }

  if (state.issues.length > 0) {
    return (
      <FieldError>
        {state.issues.map((issue) => (
          <span key={`${issue.code}-${issue.message}`} className="block">
            {issue.message}
          </span>
        ))}
      </FieldError>
    );
  }

  if (state.available) {
    return (
      <FieldDescription className="flex items-center gap-2 text-foreground">
        <CheckIcon className="size-3" />
        Available.
      </FieldDescription>
    );
  }

  return (
    <FieldError>
      {state.takenBy === "an external DNS provider"
        ? `Already delegated to ${state.existingNameservers.join(", ") || "another provider"}.`
        : state.takenBy
          ? `Already registered by ${state.takenBy}.`
          : "Not available."}
    </FieldError>
  );
}

function AccountCard({
  user,
  suffixZones,
  onSignOut,
}: {
  user: SessionUser;
  suffixZones: Record<DomainSuffix, string>;
  onSignOut: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {user.login}
          {user.canRegisterContrib ? (
            <Badge variant="secondary">contributor</Badge>
          ) : (
            <Badge variant="outline">verified</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Verified {new Date(user.verifiedAt).toLocaleString()}
          {user.keyType ? ` with a ${user.keyType} key` : ""}
          {user.keyId !== null ? ` (#${user.keyId})` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">
          {user.canRegisterContrib ? `*.${suffixZones.verified} and *.${suffixZones.contrib}` : `*.${suffixZones.verified}`}
        </span>
        <Separator orientation="vertical" className="h-4" />
        <Button variant="ghost" size="sm" onClick={onSignOut}>
          Sign out
        </Button>
      </CardContent>
    </Card>
  );
}
