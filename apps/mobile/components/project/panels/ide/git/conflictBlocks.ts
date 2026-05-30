// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Pure parser for git conflict markers. Used by the 3-way merge editor
// to enumerate `<<<<<<<` / `=======` / `>>>>>>>` blocks. Exported so it
// can be unit-tested without spinning up Monaco.

export interface ConflictBlock {
  /** 1-based line number of the `<<<<<<<` marker line. */
  start: number;
  /** 1-based line number of the `=======` separator line. */
  mid: number;
  /** 1-based line number of the `>>>>>>>` marker line. */
  end: number;
  /** Content between `<<<<<<<` and `=======` (no markers, no trailing newline). */
  current: string;
  /** Content between `=======` and `>>>>>>>` (no markers, no trailing newline). */
  incoming: string;
}

/**
 * Walk `text` once and emit a list of conflict blocks in document order.
 * Malformed blocks (e.g. `<<<<<<<` with no matching `=======` or `>>>>>>>`)
 * are skipped — we never throw, so a half-typed buffer keeps rendering.
 */
export function parseConflictBlocks(text: string): ConflictBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ConflictBlock[] = [];
  let start = -1;
  let mid = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("<<<<<<< ")) {
      start = i;
      mid = -1;
    } else if (start >= 0 && mid === -1 && /^=======\s*$/.test(l)) {
      mid = i;
    } else if (start >= 0 && mid !== -1 && l.startsWith(">>>>>>> ")) {
      blocks.push({
        start: start + 1,
        mid: mid + 1,
        end: i + 1,
        current: lines.slice(start + 1, mid).join("\n"),
        incoming: lines.slice(mid + 1, i).join("\n"),
      });
      start = -1;
      mid = -1;
    }
  }
  return blocks;
}
