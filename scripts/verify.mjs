/**
 * Runs the full local verification suite: boots the stub upstreams, boots the
 * app against them, waits for both to answer, runs scripts/smoke.mjs, and
 * shuts everything down.
 *
 * All configuration is injected here, so the suite needs no `.env.local` and
 * never touches real Cloudflare, GitHub or the live verifier.
 *
 * Usage: node scripts/verify.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const APP_PORT = Number(process.env.APP_PORT ?? 3100);
const STUB_PORT = Number(process.env.STUB_PORT ?? 3200);
const DNS_PORT = Number(process.env.DNS_PORT ?? 35353);

/** Points every upstream at the local stubs and relaxes rate limits. */
const APP_ENV = {
  ...process.env,
  GHSSH_ORIGIN: `http://127.0.0.1:${STUB_PORT}`,
  GITHUB_API_BASE: `http://127.0.0.1:${STUB_PORT}/gh`,
  CF_API_BASE: `http://127.0.0.1:${STUB_PORT}/cf`,
  CLOUDFLARE_API_TOKEN: "stub-token",
  GITHUB_TOKEN: "stub-token",
  SESSION_SECRET: "local-smoke-secret-not-for-production",
  APP_ORIGIN: `http://127.0.0.1:${APP_PORT}`,
  DNS_RESOLVERS: `127.0.0.1:${DNS_PORT}`,
  // The suite registers several domains and logs in several times per run.
  RATE_LIMIT_DOMAIN_CREATE: "100",
  RATE_LIMIT_LOGIN_START: "100",
  RATE_LIMIT_AUTH_CALLBACK: "50",
  RATE_LIMIT_DOMAIN_CHECK: "1000",
};

const children = [];

function launch(name, args, env = process.env) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const child of children) {
    if (child.pid === undefined) {
      continue;
    }
    if (process.platform === "win32") {
      // `shell: true` means the child is cmd.exe; killing only that leaves the
      // grandchild (next dev) listening on the port. Kill the whole tree.
      try {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
}

async function waitFor(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`timed out waiting for ${label} at ${url}`);
}

async function main() {
  launch("stub", ["scripts/stub-services.mjs", String(STUB_PORT)]);
  launch("dns", ["scripts/stub-dns.mjs", String(DNS_PORT)]);

  // Run the Next CLI through its JS entry point: Windows cannot spawn the
  // pnpm.cmd shim without a shell (Node rejects it), and going straight to the
  // script keeps arguments exact and the process tree shallow.
  const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
  const next = spawn(process.execPath, [nextCli, "dev", "-p", String(APP_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: APP_ENV,
  });
  next.stdout.on("data", (chunk) => process.stdout.write(`[next] ${chunk}`));
  next.stderr.on("data", (chunk) => process.stderr.write(`[next] ${chunk}`));
  children.push(next);

  await waitFor(`http://127.0.0.1:${STUB_PORT}/api/public-key`, "stub services");
  await waitFor(`http://127.0.0.1:${APP_PORT}/api/health`, "the app", 90_000);

  const smoke = spawn(process.execPath, ["scripts/smoke.mjs"], {
    stdio: "inherit",
    env: { ...process.env, BASE: `http://127.0.0.1:${APP_PORT}`, STUB: `http://127.0.0.1:${STUB_PORT}` },
  });
  smoke.on("exit", (code) => shutdown(code ?? 1));
}

process.on("SIGINT", () => shutdown(130));
main().catch((error) => {
  console.error(error);
  shutdown(1);
});
