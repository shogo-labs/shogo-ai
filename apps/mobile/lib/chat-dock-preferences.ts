// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Persisted expand/collapse state for chat dock panels, keyed by panel id.
 *
 * Only `autoShow` panels are meant to consult this — on-demand panels (e.g.
 * context usage) always start hidden and fall back to their own
 * `defaultExpanded` rather than a remembered value.
 *
 * Uses `safe-storage` (localStorage with an in-memory fallback) rather than
 * SecureStore since this is cosmetic UI state, not a security-sensitive
 * preference — cheap enough to read/write synchronously on every toggle,
 * matching the synchronous API `chat-dock-store.ts` expects.
 */

import { safeGetItem, safeSetItem } from "./safe-storage"

const STORAGE_KEY = "chat-dock-expanded-panels"

let cache: Record<string, boolean> | null = null

function loadCache(): Record<string, boolean> {
  if (cache) return cache
  try {
    const raw = safeGetItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    cache = parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {}
  } catch {
    cache = {}
  }
  return cache
}

function persist(): void {
  try {
    safeSetItem(STORAGE_KEY, JSON.stringify(cache ?? {}))
  } catch {
    // Cosmetic preference — ignore persistence errors.
  }
}

/** Returns null when no preference has been recorded yet for this panel. */
export function getDockPanelExpandedPreference(panelId: string): boolean | null {
  const c = loadCache()
  return panelId in c ? c[panelId] : null
}

export function setDockPanelExpandedPreference(panelId: string, expanded: boolean): void {
  const c = loadCache()
  if (c[panelId] === expanded) return
  c[panelId] = expanded
  persist()
}
