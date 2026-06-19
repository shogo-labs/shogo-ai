// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Write-side git operations invoked from the SCM viewlet: stage, unstage,
// discard, commit. Plus a read-only `fileContent` helper used for diff
// view construction (we need `git show` against HEAD / index / arbitrary
// refs without round-tripping through a buffer cache).
//
// All operations:
//   - take a workspaceRoot the caller has already validated lives under
//     $HOME (this file does NOT re-validate — the IPC layer is the gate);
//   - shell out via runGit(), respecting GIT_TERMINAL_PROMPT=0;
//   - return a discriminated result so callers don't have to catch.

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runGit } from "./repository";
import { getOrCreateGitWorkspace } from "./service";
import { parsePorcelainV2 } from "./porcelain";

type OpResult =
  | { ok: true }
  | { ok: false; error: string };

type StringResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export interface GitCommitHistoryItem {
  hash: string;
  message: string;
  author: string;
  time: string;
  isMerge: boolean;
  branchLabel?: string;
  isRemote?: boolean;
}

/** `git add <paths...>` */
export async function gitStage(root: string, paths: string[]): Promise<OpResult> {
  if (paths.length === 0) return { ok: true };
  const res = await runGit(["add", "--", ...paths], { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git add exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

/** `git reset HEAD -- <paths...>` (kept for compatibility with older git). */
export async function gitUnstage(root: string, paths: string[]): Promise<OpResult> {
  if (paths.length === 0) return { ok: true };
  const res = await runGit(["reset", "HEAD", "--", ...paths], { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git reset exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

/**
 * Discard working-tree changes. Behaviour per current status of each path:
 *   - untracked      → delete file from disk
 *   - tracked dirty  → `git checkout -- <path>` (restore from index)
 *   - staged + dirty → `git checkout` clears the working diff but leaves the
 *                      stage; we leave the stage alone so the user can
 *                      still `git reset HEAD` separately if desired.
 */
export async function gitDiscard(root: string, paths: string[]): Promise<OpResult> {
  if (paths.length === 0) return { ok: true };
  // Refresh the porcelain so we classify accurately right now.
  const statusRes = await runGit(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    { cwd: root },
  );
  if (!statusRes.ok) {
    return { ok: false, error: statusRes.stderr.trim() || `git status exit ${statusRes.code}` };
  }
  const parsed = parsePorcelainV2(statusRes.stdout);
  const untracked = new Set<string>();
  for (const f of parsed.files) {
    if (f.working === "untracked" && f.index === "unmodified") untracked.add(f.path);
  }

  const toDelete: string[] = [];
  const toCheckout: string[] = [];
  for (const p of paths) {
    if (untracked.has(p)) toDelete.push(p);
    else toCheckout.push(p);
  }

  // Untracked: rm from disk. We DON'T use `git clean -f` because that
  // would also nuke any other untracked file the user hasn't selected.
  for (const rel of toDelete) {
    try {
      // `rm` with `recursive: true` handles both files and directories.
      // Porcelain with --untracked-files=all normally expands directories
      // into individual files, but a `.gitignore`'d subdirectory inside
      // an untracked dir can still come through as a directory entry.
      // `force: true` swallows ENOENT in case the file was already gone
      // (e.g. race with an external delete).
      await rm(join(root, rel), { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: `failed to delete ${rel}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (toCheckout.length > 0) {
    const res = await runGit(["checkout", "HEAD", "--", ...toCheckout], { cwd: root });
    if (!res.ok) {
      return { ok: false, error: res.stderr.trim() || `git checkout exit ${res.code}` };
    }
  }

  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

export interface CommitOptions {
  message: string;
  amend?: boolean;
  signoff?: boolean;
}


/**
 * Get per-file addition/deletion counts via `git diff --numstat`.
 * Returns a map of relative path → { added, removed }.
 */
export async function gitNumStat(
  root: string,
  cached = false,
): Promise<{ ok: true; stats: Record<string, { added: number; removed: number }> } | { ok: false; error: string }> {
  const args = ["diff", "--numstat"];
  if (cached) args.push("--cached");
  const res = await runGit(args, { cwd: root });
  if (!res.ok) {
    return { ok: false, error: res.stderr.trim() || `git diff --numstat exit ${res.code}` };
  }
  const stats: Record<string, { added: number; removed: number }> = {};
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const added = parseInt(parts[0], 10);
      const removed = parseInt(parts[1], 10);
      const path = parts.slice(2).join("\t");
      if (!Number.isNaN(added) && !Number.isNaN(removed)) {
        stats[path] = { added, removed };
      }
    }
  }
  return { ok: true, stats };
}


export async function gitCommitHistory(
  root: string,
  opts: { limit?: number; allBranches?: boolean } = {},
): Promise<{ ok: true; commits: GitCommitHistoryItem[] } | { ok: false; error: string }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const args = [
    "log",
    `--max-count=${limit}`,
    "--decorate=short",
    "--pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%cr%x1f%s%x1e",
  ];
  if (opts.allBranches) args.splice(1, 0, "--all");

  const res = await runGit(args, { cwd: root, timeoutMs: 10_000 });
  if (!res.ok) {
    const error = res.stderr.trim() || res.stdout.trim() || `git log exit ${res.code}`;
    if (
      error.includes("does not have any commits yet") ||
      error.includes("bad default revision") ||
      error.includes("ambiguous argument 'HEAD'")
    ) {
      return { ok: true, commits: [] };
    }
    return { ok: false, error };
  }

  const commits: GitCommitHistoryItem[] = [];
  for (const record of res.stdout.split("\x1e")) {
    if (!record.trim()) continue;
    const [hash = "", parentsRaw = "", decorationsRaw = "", author = "", time = "", message = ""] = record
      .replace(/^\n+/, "")
      .split("\x1f");
    if (!hash) continue;
    const decorations = decorationsRaw
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const branchDecoration = decorations.find((d) => !d.startsWith("tag: ") && d !== "HEAD");
    const branchLabel = branchDecoration?.replace(/^HEAD ->\s*/, "");
    commits.push({
      hash: hash.slice(0, 12),
      message: message || "(no commit message)",
      author,
      time,
      isMerge: parentsRaw.trim().split(/\s+/).filter(Boolean).length > 1,
      branchLabel,
      isRemote: Boolean(branchDecoration && !branchDecoration.startsWith("HEAD -> ") && branchDecoration.includes("/")),
    });
  }

  return { ok: true, commits };
}

/**
 * Commit then push in one shot.
 * Mirrors VS Code's "Commit & Push" action.
 */
export async function gitCommitAndPush(root: string, opts: CommitOptions): Promise<OpResult> {
  const commitRes = await gitCommit(root, opts);
  if (!commitRes.ok) return commitRes;
  const pushRes = await runGit(["push"], { cwd: root, timeoutMs: 60_000 });
  if (!pushRes.ok) {
    return { ok: false, error: pushRes.stderr.trim() || `git push exit ${pushRes.code}` };
  }
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

/**
 * Commit then sync (pull --rebase + push) in one shot.
 * Mirrors VS Code's "Commit & Sync" action.
 */
export async function gitCommitAndSync(root: string, opts: CommitOptions): Promise<OpResult> {
  const commitRes = await gitCommit(root, opts);
  if (!commitRes.ok) return commitRes;
  const pullRes = await runGit(["pull", "--rebase"], { cwd: root, timeoutMs: 60_000 });
  if (!pullRes.ok) {
    return { ok: false, error: pullRes.stderr.trim() || `git pull exit ${pullRes.code}` };
  }
  const pushRes = await runGit(["push"], { cwd: root, timeoutMs: 60_000 });
  if (!pushRes.ok) {
    return { ok: false, error: pushRes.stderr.trim() || `git push exit ${pushRes.code}` };
  }
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}



/**
 * Generate a commit message from staged diff using an LLM via Shogo Cloud.
 * Falls back to a generic message if the API call fails.
 */
export async function gitGenerateCommitMessage(
  root: string,
  apiUrl: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  // Get the staged diff
  const diffRes = await runGit(["diff", "--cached", "--stat"], { cwd: root });
  if (!diffRes.ok) {
    return { ok: false, error: diffRes.stderr.trim() || "failed to get staged diff" };
  }
  const diffStat = diffRes.stdout.trim();

  // Get a short log of recent commits for context
  const logRes = await runGit(["log", "--oneline", "-5"], { cwd: root });
  const recentCommits = logRes.ok ? logRes.stdout.trim() : "";

  // Get the actual diff (limited to first 4000 chars to stay within LLM context)
  const fullDiffRes = await runGit(["diff", "--cached"], { cwd: root });
  const diff = fullDiffRes.ok ? fullDiffRes.stdout.slice(0, 4000) : "";

  try {
    const res = await fetch(`${apiUrl}/api/ai/generate-commit-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diff, diffStat, recentCommits }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = await res.json() as { message?: string };
    if (data.message) {
      return { ok: true, message: data.message };
    }
    return { ok: false, error: "No message returned from LLM" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/** `git commit -m <message>` against the current index. No -a. */
export async function gitCommit(root: string, opts: CommitOptions): Promise<OpResult> {
  if (!opts.message.trim() && !opts.amend) {
    return { ok: false, error: "commit message is empty" };
  }
  const args = ["commit"];
  if (opts.amend) args.push("--amend");
  if (opts.signoff) args.push("--signoff");
  if (opts.message.trim()) {
    args.push("-m", opts.message);
  }
  // Pass message via -m flag, not stdin, so multi-line messages work
  // consistently across platforms. We rely on git's own quoting.
  const res = await runGit(args, { cwd: root, timeoutMs: 30_000 });
  if (!res.ok) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || `git commit exit ${res.code}` };
  }
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

/**
 * Stage ALL changes (including untracked) and commit in one shot.
 * Mirrors VS Code's "Commit All" action.
 */
export async function gitCommitAll(root: string, opts: CommitOptions): Promise<OpResult> {
  if (!opts.message.trim() && !opts.amend) {
    return { ok: false, error: "commit message is empty" };
  }
  // Stage everything first (including untracked).
  const addRes = await runGit(["add", "-A"], { cwd: root, timeoutMs: 30_000 });
  if (!addRes.ok) {
    return { ok: false, error: addRes.stderr.trim() || `git add exit ${addRes.code}` };
  }
  return gitCommit(root, opts);
}

/**
 * Undo the last commit (soft reset). Keeps all changes staged.
 * Mirrors VS Code's "Undo Last Commit" action.
 */
export async function gitUndoLastCommit(root: string): Promise<OpResult> {
  const res = await runGit(["reset", "--soft", "HEAD~1"], { cwd: root, timeoutMs: 30_000 });
  if (!res.ok) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || `git reset exit ${res.code}` };
  }
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

/**
 * Read a file at a given ref. Used to construct Monaco diff buffers in the
 * renderer. `ref` is one of:
 *   - "HEAD"   → committed version
 *   - ":"      → staged (index) version
 *   - "WORKING"→ working-tree version (just fs.readFile under the hood)
 *   - anything else is passed through verbatim (e.g. branch / sha)
 */
export async function gitFileContent(
  root: string,
  relPath: string,
  ref: string,
): Promise<StringResult> {
  if (ref === "WORKING") {
    const { readFile } = await import("node:fs/promises");
    try {
      const buf = await readFile(join(root, relPath));
      return { ok: true, content: buf.toString("utf8") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const spec = ref === ":" ? `:${relPath}` : `${ref}:${relPath}`;
  const res = await runGit(["show", spec], { cwd: root });
  if (!res.ok) {
    // Specifically detect "doesn't exist in HEAD" — for added files
    // there is no HEAD version, which is normal and we surface as empty.
    if (/exists on disk, but not in/.test(res.stderr) || /does not exist/.test(res.stderr) || /unknown revision/.test(res.stderr)) {
      return { ok: true, content: "" };
    }
    return { ok: false, error: res.stderr.trim() || `git show exit ${res.code}` };
  }
  return { ok: true, content: res.stdout };
}
