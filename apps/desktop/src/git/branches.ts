// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Branch operations for the SCM viewlet + StatusBar branch picker.
// Read-side uses `git for-each-ref` with a fixed format so we don't have
// to guess at locale-dependent output. Write-side shells out the obvious
// commands; we never persist branch state ourselves — git is the source
// of truth.

import { runGit } from "./repository";
import { getOrCreateGitWorkspace } from "./service";

export interface BranchInfo {
  name: string;
  fullRef: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  /** Short subject of the tip commit. */
  subject: string;
  /** Last commit timestamp (ISO 8601) — useful for sorting. */
  committedAt: string;
}

type OpResult = { ok: true } | { ok: false; error: string };
type ListResult = { ok: true; branches: BranchInfo[] } | { ok: false; error: string };

/**
 * `git for-each-ref` formatted with `%(field)<delim>` markers. We use
 * NUL between fields and the form-feed character between records — both
 * are invalid in branch names so they can't collide.
 */
export async function listBranches(root: string): Promise<ListResult> {
  const FIELD_SEP = "\x00";
  const REC_SEP = "\x0c"; // form feed
  const fmt = [
    "%(refname)",
    "%(refname:short)",
    "%(HEAD)",
    "%(upstream:short)",
    "%(contents:subject)",
    "%(committerdate:iso-strict)",
  ].join(FIELD_SEP) + REC_SEP;

  const res = await runGit(
    ["for-each-ref", `--format=${fmt}`, "refs/heads", "refs/remotes"],
    { cwd: root, timeoutMs: 10_000 },
  );
  if (!res.ok) {
    return { ok: false, error: res.stderr.trim() || `git for-each-ref exit ${res.code}` };
  }
  const branches: BranchInfo[] = [];
  for (const rec of res.stdout.split(REC_SEP)) {
    if (!rec.trim()) continue;
    const parts = rec.split(FIELD_SEP);
    if (parts.length < 6) continue;
    const [refname, short, head, upstream, subject, committedAt] = parts;
    branches.push({
      name: short,
      fullRef: refname,
      isHead: head === "*",
      isRemote: refname.startsWith("refs/remotes/"),
      upstream: upstream || null,
      subject: subject ?? "",
      committedAt: committedAt ?? "",
    });
  }
  return { ok: true, branches };
}

/** `git checkout <name>` — also handles ambiguous remote-tracking refs. */
export async function checkoutBranch(root: string, name: string): Promise<OpResult> {
  const res = await runGit(["checkout", name], { cwd: root, timeoutMs: 30_000 });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git checkout exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

/**
 * `git checkout -b <name> [<base>]`. If `base` is omitted we branch off
 * the current HEAD.
 */
export async function createBranch(
  root: string,
  name: string,
  base?: string,
): Promise<OpResult> {
  const args = ["checkout", "-b", name];
  if (base) args.push(base);
  const res = await runGit(args, { cwd: root, timeoutMs: 30_000 });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git checkout -b exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

/**
 * `git branch -d <name>` (safe) or `git branch -D <name>` (force). We
 * default to safe and let the caller pass `force: true` when they really
 * mean it (after a confirmation modal in the UI).
 */
export async function deleteBranch(
  root: string,
  name: string,
  opts?: { force?: boolean },
): Promise<OpResult> {
  const flag = opts?.force ? "-D" : "-d";
  const res = await runGit(["branch", flag, name], { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git branch ${flag} exit ${res.code}` };
  return { ok: true };
}

/** `git branch -m <oldName> <newName>` (or just `-m <newName>` for the current branch). */
export async function renameBranch(
  root: string,
  oldName: string,
  newName: string,
): Promise<OpResult> {
  const res = await runGit(["branch", "-m", oldName, newName], { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git branch -m exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

/** `git push -u <remote> <branch>` — publish a local branch to its upstream. */
export async function publishBranch(
  root: string,
  branch: string,
  remote = "origin",
): Promise<OpResult> {
  const res = await runGit(
    ["push", "-u", remote, branch],
    { cwd: root, timeoutMs: 120_000 },
  );
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git push -u exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}
