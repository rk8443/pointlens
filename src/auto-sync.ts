#!/usr/bin/env tsx
/**
 * auto-sync.ts
 *
 * File watcher that calls `pnpm sync` automatically whenever something in the
 * workspace changes. Debounced so a burst of edits collapses into a single
 * commit.
 *
 * Usage:
 *   pnpm auto-sync                       # start the watcher (foreground)
 *   AUTO_SYNC_DEBOUNCE_MS=10000 pnpm auto-sync
 *   AUTO_SYNC=0 pnpm auto-sync           # disabled; exits immediately
 *
 * Env vars:
 *   AUTO_SYNC                  set to "0" / "false" / "off" to disable. Any
 *                              other value (or unset) keeps the watcher on.
 *   AUTO_SYNC_DEBOUNCE_MS      debounce window in milliseconds (default 5000).
 *
 * The watcher itself is intentionally dumb: it triggers `pnpm sync`, and the
 * sync script decides whether anything actually needs to go to GitHub. If
 * nothing changed (or only ignored files changed), `pnpm sync` prints
 * "nothing to push" and we move on — no commit spam.
 */

import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname, resolve, sep } from "node:path";

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

const ROOT = findRepoRoot(process.cwd());
const DEBOUNCE_MS = Number(process.env.AUTO_SYNC_DEBOUNCE_MS ?? 5000);

// Path prefixes (relative to repo root) we never want to react to. These are
// either ignored by git already, or churn so often that watching them would
// trigger sync continuously.
const IGNORED_PREFIXES = [
  ".git",
  "node_modules",
  ".pnpm-store",
  ".local",
  ".cache",
  ".turbo",
  ".next",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".vite",
  ".tmp",
  "tmp",
  "artifacts/point-cloud-viewer/src-tauri/target",
];

function isIgnored(rel: string): boolean {
  if (!rel) return true;
  const norm = rel.split(sep).join("/");
  for (const p of IGNORED_PREFIXES) {
    if (norm === p || norm.startsWith(`${p}/`)) return true;
    // also match nested node_modules anywhere in the tree
  }
  if (norm.includes("/node_modules/") || norm.includes("/.git/")) return true;
  return false;
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg: string): void {
  console.log(`[auto-sync ${ts()}] ${msg}`);
}

const disabled = ["0", "false", "off", "no"].includes(
  String(process.env.AUTO_SYNC ?? "").toLowerCase(),
);
if (disabled) {
  log("AUTO_SYNC is disabled via env var. Exiting.");
  process.exit(0);
}

if (!Number.isFinite(DEBOUNCE_MS) || DEBOUNCE_MS < 250) {
  console.error(
    `auto-sync: AUTO_SYNC_DEBOUNCE_MS must be a number >= 250 (got ${process.env.AUTO_SYNC_DEBOUNCE_MS}).`,
  );
  process.exit(1);
}

log(`watching ${ROOT}`);
log(`debounce window: ${DEBOUNCE_MS} ms`);
log(`to disable: set AUTO_SYNC=0 in the environment, or stop this process.`);

let pendingTimer: NodeJS.Timeout | undefined;
let syncing = false;
let syncQueued = false;

function runSync(): void {
  if (syncing) {
    syncQueued = true;
    return;
  }
  syncing = true;
  log("running `pnpm sync`...");
  const child = spawn("pnpm", ["sync"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => {
    syncing = false;
    if (code === 0) {
      log("sync finished cleanly.");
    } else {
      log(`sync exited with code ${code}. Will retry on next change.`);
    }
    if (syncQueued) {
      syncQueued = false;
      schedule();
    }
  });
  child.on("error", (err) => {
    syncing = false;
    log(`failed to spawn pnpm sync: ${err.message}`);
  });
}

function schedule(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = undefined;
    runSync();
  }, DEBOUNCE_MS);
}

let watcher: ReturnType<typeof watch>;
try {
  watcher = watch(ROOT, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel =
      typeof filename === "string" ? filename : Buffer.from(filename).toString();
    if (isIgnored(rel)) return;
    schedule();
  });
} catch (err) {
  console.error(
    `auto-sync: recursive fs.watch is not supported on this platform: ${
      err instanceof Error ? err.message : err
    }`,
  );
  process.exit(1);
}

watcher.on("error", (err) => {
  log(`watcher error: ${err.message}`);
});

function shutdown(signal: string): void {
  log(`received ${signal}, shutting down.`);
  watcher.close();
  if (pendingTimer) clearTimeout(pendingTimer);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
