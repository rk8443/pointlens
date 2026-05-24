#!/usr/bin/env tsx
/**
 * sync-github.ts
 *
 * One-shot "push the current Replit state to GitHub" helper.
 *
 * Usage:
 *   pnpm sync                 # commit + push tracked changes
 *   pnpm sync -m "msg"        # custom commit message
 *
 * Uses GITHUB_TOKEN + GITHUB_REPO_NAME (owner is hard-coded to rk8443, matching
 * the existing delegated push tasks). For text/small changes it commits via
 * GitHub's Git Data API directly — no local git push needed. For very large or
 * many-file changes it prints clear instructions to run the delegated
 * `push-to-github` task instead.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const OWNER = "rk8443";
const BRANCH = "main";

// Soft caps. Above these we recommend the delegated git-push fallback because
// (a) GitHub's Contents/Git Data API base64-encodes blobs (33% overhead) and
// rejects single requests near ~100 MB, and (b) hundreds of small writes get
// rate-limit unfriendly.
const MAX_FILE_BYTES = 25 * 1024 * 1024;       // 25 MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;      // 50 MB total payload
const MAX_FILES = 200;                         // arbitrary sanity cap

type ChangedFile = {
  path: string;
  /** absent => deleted */
  contents?: Buffer;
};

function fail(msg: string): never {
  console.error(`sync: ${msg}`);
  process.exit(1);
}

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

async function gh<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "replit-sync-script",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub API ${method} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 400)}`,
    );
  }
  return (await res.json()) as T;
}

function detectChanges(repoSha: string): ChangedFile[] {
  // Diff committed HEAD against the GitHub remote SHA, plus include any
  // uncommitted (working tree + staged) changes against HEAD.
  //
  // We use `git diff --name-status` so we get add/modify/delete in one pass.
  const lines: string[] = [];

  // Tree vs remote (committed history not yet on GitHub).
  // If the remote sha is unknown locally we still want a diff: fall back to
  // listing everything by treating the empty tree as the base.
  const haveRemote = (() => {
    try {
      git(["cat-file", "-e", `${repoSha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  })();

  if (haveRemote) {
    lines.push(...git(["diff", "--name-status", repoSha, "HEAD"]).split("\n"));
  } else {
    // First push or unknown SHA: include every tracked file as additions.
    const tracked = git(["ls-files"]).split("\n");
    for (const p of tracked) if (p) lines.push(`A\t${p}`);
  }

  // Working tree (uncommitted + untracked-but-not-ignored) vs HEAD.
  // `--no-renames` keeps the output as plain A/M/D entries.
  lines.push(
    ...git([
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])
      .split("\n")
      .flatMap((l) => {
        if (!l) return [];
        // porcelain v1: "XY path" where X=index, Y=worktree.
        const xy = l.slice(0, 2);
        const path = l.slice(3);
        if (xy.includes("?")) return [`A\t${path}`];
        if (xy.includes("D")) return [`D\t${path}`];
        return [`M\t${path}`];
      }),
  );

  const map = new Map<string, ChangedFile>();
  for (const raw of lines) {
    if (!raw) continue;
    const [status, ...rest] = raw.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const s = status[0];
    if (s === "D") {
      map.set(path, { path });
    } else {
      try {
        const abs = resolve(path);
        const contents = readFileSync(abs);
        map.set(path, { path, contents });
      } catch {
        // File listed as added/modified but unreadable — treat as delete.
        map.set(path, { path });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO_NAME;
  if (!token) fail("GITHUB_TOKEN is not set.");
  if (!repo) fail("GITHUB_REPO_NAME is not set.");

  const message =
    getArg("-m") ??
    getArg("--message") ??
    `Sync from Replit (${new Date().toISOString()})`;

  console.log(`sync: target = https://github.com/${OWNER}/${repo} (${BRANCH})`);

  // 1. Look up the current remote head.
  const ref = await gh<{ object: { sha: string } }>(
    token,
    "GET",
    `/repos/${OWNER}/${repo}/git/refs/heads/${BRANCH}`,
  );
  const remoteSha = ref.object.sha;
  console.log(`sync: remote HEAD = ${remoteSha.slice(0, 10)}`);

  // 2. Find what to send.
  const changes = detectChanges(remoteSha);
  if (changes.length === 0) {
    console.log("sync: nothing to push — local matches remote.");
    return;
  }

  let totalBytes = 0;
  let oversize: ChangedFile | undefined;
  for (const c of changes) {
    if (!c.contents) continue;
    totalBytes += c.contents.length;
    if (c.contents.length > MAX_FILE_BYTES && !oversize) oversize = c;
  }

  console.log(
    `sync: ${changes.length} changed path(s), ~${(totalBytes / 1024).toFixed(1)} KiB`,
  );

  if (
    changes.length > MAX_FILES ||
    totalBytes > MAX_TOTAL_BYTES ||
    oversize
  ) {
    console.error("");
    console.error("sync: payload too large for the GitHub API path.");
    if (oversize) {
      console.error(
        `  - "${oversize.path}" is ${(oversize.contents!.length / 1024 / 1024).toFixed(1)} MiB (cap ${MAX_FILE_BYTES / 1024 / 1024} MiB).`,
      );
    }
    if (changes.length > MAX_FILES) {
      console.error(`  - ${changes.length} files (cap ${MAX_FILES}).`);
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      console.error(
        `  - total ${(totalBytes / 1024 / 1024).toFixed(1)} MiB (cap ${MAX_TOTAL_BYTES / 1024 / 1024} MiB).`,
      );
    }
    console.error("");
    console.error(
      "Fallback: ask the agent to run the delegated 'sync-to-github' (or 'push-to-github') task — it shells out to real git and isn't bound by API limits.",
    );
    process.exit(2);
  }

  // 3. Upload blobs.
  const blobShas = new Map<string, string>();
  for (const c of changes) {
    if (!c.contents) continue;
    process.stdout.write(`sync: upload ${c.path} ... `);
    const blob = await gh<{ sha: string }>(
      token,
      "POST",
      `/repos/${OWNER}/${repo}/git/blobs`,
      {
        content: c.contents.toString("base64"),
        encoding: "base64",
      },
    );
    blobShas.set(c.path, blob.sha);
    process.stdout.write(`${blob.sha.slice(0, 10)}\n`);
  }

  // 4. Build a new tree based on the remote.
  const tree = changes.map((c) => {
    const mode = c.contents
      ? // Preserve executable bit on POSIX.
        (() => {
          try {
            const st = statSync(c.path);
            return (st.mode & 0o111) !== 0 ? "100755" : "100644";
          } catch {
            return "100644";
          }
        })()
      : "100644";
    if (!c.contents) {
      return { path: c.path, mode, type: "blob", sha: null };
    }
    return { path: c.path, mode, type: "blob", sha: blobShas.get(c.path)! };
  });

  const newTree = await gh<{ sha: string }>(
    token,
    "POST",
    `/repos/${OWNER}/${repo}/git/trees`,
    { base_tree: remoteSha, tree },
  );
  console.log(`sync: tree = ${newTree.sha.slice(0, 10)}`);

  // 5. Create the commit.
  const commit = await gh<{ sha: string }>(
    token,
    "POST",
    `/repos/${OWNER}/${repo}/git/commits`,
    {
      message,
      tree: newTree.sha,
      parents: [remoteSha],
    },
  );
  console.log(`sync: commit = ${commit.sha.slice(0, 10)}  "${message}"`);

  // 6. Move the branch ref.
  await gh(token, "PATCH", `/repos/${OWNER}/${repo}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha,
    force: false,
  });

  console.log("");
  console.log(`sync: done — https://github.com/${OWNER}/${repo}/commit/${commit.sha}`);
}

main().catch((err) => {
  console.error(`sync: failed — ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
