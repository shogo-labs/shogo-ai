// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// ─── Search history (↑/↓ in the query box) ──────────────────────────────

const HISTORY_KEY = "shogo.ide.searchHistory";
const HISTORY_MAX = 20;

/** Newest first, de-duplicated, capped. Pure. */
export function pushSearchHistory(list: string[], q: string): string[] {
  return [q, ...list.filter((x) => x !== q)].slice(0, HISTORY_MAX);
}

export function loadSearchHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveSearchHistory(list: string[]): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
