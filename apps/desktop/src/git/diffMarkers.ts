// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Per-line diff markers for the editor gutter. We run `git diff --unified=0`
// (so each hunk header lists exact line counts with no surrounding context)
// and reduce the unified-diff text to a flat list of intervals classified
// as added / modified / removed. The renderer turns these into Monaco
// gutter decorations (the green/blue bars at the left of the line numbers).

import { runGit } from "./repository";

export type DiffMarkerKind = "added" | "modified" | "removed";

export interface DiffMarker {
  kind: DiffMarkerKind;
  /** 1-based start line in the NEW (working) file. */
  startLine: number;
  /** Inclusive end line. For `removed` markers this equals startLine and
   *  the marker is rendered as a triangle in the gutter rather than a bar. */
  endLine: number;
  /** How many lines were removed at this position (for tooltips). */
  removed: number;
  /** How many lines were added at this position (for tooltips). */
  added: number;
  /**
   * 1-based start line in the OLD (HEAD) file. Together with `removed`,
   * this lets the hunk-revert helper splice the exact HEAD line range
   * back into the working buffer (the NEW-side line numbers can't be
   * used as a stand-in once any prior hunk has a non-zero net delta).
   * 0 when the hunk has no OLD counterpart (pure addition).
   */
  oldStart: number;
}

type MarkersResult =
  | { ok: true; markers: DiffMarker[] }
  | { ok: false; error: string };

/**
 * Compute per-line markers for `relPath` vs the given ref (default HEAD).
 * Returns an empty marker list for unchanged or untracked files — those
 * are signalled at the file-level via the porcelain status snapshot.
 */
export async function diffMarkers(
  root: string,
  relPath: string,
  base = "HEAD",
): Promise<MarkersResult> {
  const res = await runGit(
    ["diff", "--unified=0", "--no-color", base, "--", relPath],
    { cwd: root, timeoutMs: 10_000 },
  );
  if (!res.ok) {
    // `git diff` exits 0 even with diffs — non-zero here means a real
    // problem (no such file in HEAD, repo missing, etc.).
    if (/unknown revision/.test(res.stderr) || /does not exist/.test(res.stderr)) {
      return { ok: true, markers: [] };
    }
    return { ok: false, error: res.stderr.trim() || `git diff exit ${res.code}` };
  }
  return { ok: true, markers: parseUnified(res.stdout) };
}

/**
 * Parse unified-diff output's hunk headers. We only look at
 *   `@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@`
 * lines — the bodies are irrelevant for gutter classification.
 */
export function parseUnified(stdout: string): DiffMarker[] {
  const markers: DiffMarker[] = [];
  const lines = stdout.split("\n");
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const oldStart = Number.parseInt(m[1], 10);
    const oldCount = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
    const newStart = Number.parseInt(m[3], 10);
    const newCount = m[4] === undefined ? 1 : Number.parseInt(m[4], 10);

    if (newCount === 0) {
      // Pure deletion. The "removed" marker is anchored at the line
      // AFTER which the deletion sat — newStart is then 0 if the file
      // had lines removed from the very top, in which case we anchor at 1.
      markers.push({
        kind: "removed",
        startLine: Math.max(1, newStart),
        endLine: Math.max(1, newStart),
        removed: oldCount,
        added: 0,
        oldStart,
      });
      continue;
    }
    if (oldCount === 0) {
      markers.push({
        kind: "added",
        startLine: newStart,
        endLine: newStart + newCount - 1,
        removed: 0,
        added: newCount,
        oldStart: 0,
      });
      continue;
    }
    markers.push({
      kind: "modified",
      startLine: newStart,
      endLine: newStart + newCount - 1,
      removed: oldCount,
      added: newCount,
      oldStart,
    });
  }
  return markers;
}
