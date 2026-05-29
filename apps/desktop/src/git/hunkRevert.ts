// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Revert a single hunk in the working tree back to HEAD.
//
// Strategy: read HEAD's version of the file via `git show HEAD:<path>`,
// read the current working buffer, replace the working buffer's line
// range `[startLine, endLine]` with the corresponding range from HEAD,
// write the file back. This is robust to whitespace + line ending
// differences and doesn't require generating a patch ourselves.
//
// We accept the caller-provided HEAD line range (since the renderer
// already has the parsed `DiffMarker.startLine/endLine` for the working
// side, plus the original headStartLine via the patch header). When the
// caller doesn't know the HEAD-side range — which is true for "added"
// hunks — we just delete the lines in the working tree.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runGit } from "./repository";
import { getOrCreateGitWorkspace } from "./service";

export interface RevertHunkArgs {
  /** 1-based, inclusive line range in the current working buffer. */
  workingStart: number;
  workingEnd: number;
  /**
   * 1-based, inclusive line range in HEAD that should replace the
   * working range. Pass `null` if the hunk is purely additive (no HEAD
   * counterpart) — the working lines will simply be removed.
   */
  headStart: number | null;
  headEnd: number | null;
}

/**
 * Pure splice: given the current working buffer + HEAD buffer + the
 * caller's line range arguments, return the new working buffer with the
 * hunk reverted. Exported for unit tests — no I/O.
 */
export function spliceRevert(
  workingText: string,
  headText: string,
  args: RevertHunkArgs,
): string {
  const eol = workingText.includes("\r\n") ? "\r\n" : "\n";
  const workingLines = workingText.split(/\r?\n/);
  const headLines = headText.split(/\r?\n/);

  const wsRaw = Math.max(1, args.workingStart);
  const ws = Math.min(wsRaw, Math.max(1, workingLines.length));
  const we = Math.min(Math.max(ws - 1, args.workingEnd), workingLines.length);

  let replacement: string[] = [];
  if (args.headStart != null && args.headEnd != null && headLines.length > 0) {
    const hs = clamp(args.headStart, 1, headLines.length);
    const he = clamp(args.headEnd, hs, headLines.length);
    replacement = headLines.slice(hs - 1, he);
  }

  const next = [...workingLines.slice(0, ws - 1), ...replacement, ...workingLines.slice(we)];
  const trailing = workingText.endsWith("\n") ? eol : "";
  if (next.length > 0 && next[next.length - 1] === "" && trailing) next.pop();
  return next.join(eol) + trailing;
}

export async function revertHunk(
  root: string,
  relPath: string,
  args: RevertHunkArgs,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const headRes = await runGit(["show", `HEAD:${relPath}`], { cwd: root });
  // If HEAD doesn't have the file at all (the whole file is new), the
  // only meaningful revert is "delete it" — but that's a heavier action
  // we don't perform from a gutter hover.
  if (!headRes.ok && !/exists on disk|does not exist|unknown revision/.test(headRes.stderr)) {
    return { ok: false, error: headRes.stderr.trim() || `git show exit ${headRes.code}` };
  }
  const headText = headRes.ok ? headRes.stdout : "";
  let workingText: string;
  try {
    workingText = (await readFile(join(root, relPath))).toString("utf8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const out = spliceRevert(workingText, headText, args);

  try {
    await writeFile(join(root, relPath), out, "utf8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true };
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
