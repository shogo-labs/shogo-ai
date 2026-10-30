// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Insert `insert` into `base` at `caret` (or at the end when the composer has
 * never had a caret), separated from its neighbours by single spaces. Returns
 * the new text and the caret position just after the inserted text and its
 * trailing space.
 */
export function insertAtCaret(base: string, caret: number | null, insert: string): { next: string; caret: number } {
  const at = caret === null ? base.length : Math.max(0, Math.min(caret, base.length));
  const before = base.slice(0, at);
  const after = base.slice(at);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = /^\s/.test(after) ? "" : " ";
  const next = `${before}${lead}${insert}${trail}${after}`;
  // Either a space was added after the insert or `after` already starts with one.
  return { next, caret: before.length + lead.length + insert.length + 1 };
}
