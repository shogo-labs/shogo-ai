// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// `git stash` operations. We list stashes by parsing
// `git stash list --format=...` (porcelain-stable enough), and write
// operations are simple shell-outs that refresh the status snapshot
// when they touch the working tree.

import { runGit } from "./repository";
import { getOrCreateGitWorkspace } from "./service";

export interface StashEntry {
  /** `stash@{N}` reference — pass back to apply/pop/drop. */
  ref: string;
  /** Index in the stash stack (0 = most recent). */
  index: number;
  /** Branch name the stash was created from. */
  branch: string | null;
  /** User-supplied message (or git's auto-generated one). */
  message: string;
  /** ISO 8601 commit date of the stash. */
  createdAt: string;
}

type OpResult = { ok: true } | { ok: false; error: string };
type ListResult = { ok: true; entries: StashEntry[] } | { ok: false; error: string };

export async function listStashes(root: string): Promise<ListResult> {
  const FIELD = "\x00";
  const REC = "\x0c";
  const fmt = ["%gd", "%ci", "%s"].join(FIELD) + REC;
  const res = await runGit(["stash", "list", `--format=${fmt}`], { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git stash list exit ${res.code}` };
  const entries: StashEntry[] = [];
  for (const rec of res.stdout.split(REC)) {
    if (!rec.trim()) continue;
    const [ref, createdAt, message] = rec.split(FIELD);
    const idxMatch = /^stash@\{(\d+)\}$/.exec(ref ?? "");
    const branchMatch = /^WIP on ([^:]+):/.exec(message ?? "") ?? /^On ([^:]+):/.exec(message ?? "");
    entries.push({
      ref: ref ?? "",
      index: idxMatch ? Number.parseInt(idxMatch[1], 10) : -1,
      branch: branchMatch ? branchMatch[1] : null,
      message: message ?? "",
      createdAt: createdAt ?? "",
    });
  }
  return { ok: true, entries };
}

export async function stashPush(
  root: string,
  opts?: { message?: string; keepIndex?: boolean; includeUntracked?: boolean },
): Promise<OpResult> {
  const args = ["stash", "push"];
  if (opts?.keepIndex) args.push("--keep-index");
  if (opts?.includeUntracked) args.push("--include-untracked");
  if (opts?.message) args.push("-m", opts.message);
  const res = await runGit(args, { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git stash push exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

export async function stashApply(root: string, ref: string): Promise<OpResult> {
  const res = await runGit(["stash", "apply", ref], { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git stash apply exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

export async function stashPop(root: string, ref: string): Promise<OpResult> {
  const res = await runGit(["stash", "pop", ref], { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git stash pop exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

export async function stashDrop(root: string, ref: string): Promise<OpResult> {
  const res = await runGit(["stash", "drop", ref], { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git stash drop exit ${res.code}` };
  return { ok: true };
}
