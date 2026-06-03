// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Pure parser for git conflict markers. Used by the 3-way merge editor
// to enumerate `<<<<<<<` / `=======` / `>>>>>>>` blocks. Exported so it
// can be unit-tested without spinning up Monaco.
//
// Supports both the default 2-way conflict style and the diff3 / zdiff3
// styles, which insert a common-ancestor section between the current side
// and the separator:
//
//     <<<<<<< ours
//     our change
//     ||||||| base            ← diff3/zdiff3 only
//     original
//     =======
//     their change
//     >>>>>>> theirs
//
// In diff3 the `current` content must STOP at the `|||||||` marker, not run
// all the way to `=======` — hence `currentEnd`, the line that bounds the
// current section (the `|||||||` line under diff3, otherwise `=======`).

export interface ConflictBlock {
  /** 1-based line number of the `<<<<<<<` marker line. */
  start: number;
  /** 1-based line number of the `=======` separator line. */
  mid: number;
  /** 1-based line number of the `>>>>>>>` marker line. */
  end: number;
  /**
   * 1-based line number that bounds the END of the current section: the
   * `|||||||` base marker under diff3/zdiff3, otherwise the same as `mid`.
   * The current content is the lines in (start, currentEnd).
   */
  currentEnd: number;
  /** Content between `<<<<<<<` and `currentEnd` (no markers, no trailing newline). */
  current: string;
  /** Content between `=======` and `>>>>>>>` (no markers, no trailing newline). */
  incoming: string;
  /** diff3/zdiff3 only: 1-based line number of the `|||||||` base marker. */
  baseStart?: number;
  /** diff3/zdiff3 only: content between `|||||||` and `=======`. */
  base?: string;
}

/** The git base marker: 7 pipes, optionally followed by a label. */
const BASE_MARKER = /^\|{7}(\s|$)/;

/**
 * Walk `text` once and emit a list of conflict blocks in document order.
 * Malformed blocks (e.g. `<<<<<<<` with no matching `=======` or `>>>>>>>`)
 * are skipped — we never throw, so a half-typed buffer keeps rendering.
 */
export function parseConflictBlocks(text: string): ConflictBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ConflictBlock[] = [];
  let start = -1;
  let baseStart = -1;
  let mid = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("<<<<<<< ")) {
      start = i;
      baseStart = -1;
      mid = -1;
    } else if (start >= 0 && mid === -1 && baseStart === -1 && BASE_MARKER.test(l)) {
      // diff3/zdiff3 common-ancestor marker, before the `=======` separator.
      baseStart = i;
    } else if (start >= 0 && mid === -1 && /^=======\s*$/.test(l)) {
      mid = i;
    } else if (start >= 0 && mid !== -1 && l.startsWith(">>>>>>> ")) {
      // Current section ends at the base marker (diff3) or the separator.
      const currentEndIdx = baseStart >= 0 ? baseStart : mid;
      const block: ConflictBlock = {
        start: start + 1,
        mid: mid + 1,
        end: i + 1,
        currentEnd: currentEndIdx + 1,
        current: lines.slice(start + 1, currentEndIdx).join("\n"),
        incoming: lines.slice(mid + 1, i).join("\n"),
      };
      if (baseStart >= 0) {
        block.baseStart = baseStart + 1;
        block.base = lines.slice(baseStart + 1, mid).join("\n");
      }
      blocks.push(block);
      start = -1;
      baseStart = -1;
      mid = -1;
    }
  }
  return blocks;
}
