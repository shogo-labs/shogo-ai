// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BUG-012 — Font family setting was scattered across the IDE:
 *   • CodeEditor hardcoded its own family
 *   • XtermView/xterm-session read its own default from xterm-theme
 *   • Every HTML output panel just used Tailwind's `font-mono` utility
 *
 * Result: changing the user's preferred font in Settings updated… nothing
 * concrete, because there was no central setting and no central reader.
 *
 * This module is the single source of truth. Three exports:
 *
 *   DEFAULT_FONT_FAMILY    — the baked-in default. Mirrored once in
 *                            `DEFAULT_SETTINGS.fontFamily` (types.ts) and
 *                            in the CSS var in global.css. If you change
 *                            the literal, change those two too — there
 *                            is a test that pins all three to the same
 *                            string.
 *
 *   FONT_FAMILY_OPTIONS    — the curated dropdown list shown in the
 *                            Settings pane. Each option's `value` is a
 *                            full CSS font-family stack (with fallbacks)
 *                            so we ALWAYS land on monospace even if the
 *                            user's machine doesn't have the primary.
 *
 *   useEditorFont()        — React hook returning the live font-family
 *                            string. Subscribes to:
 *                              1. the cross-tab `storage` event (other
 *                                 windows changing the setting)
 *                              2. our same-tab pub/sub event
 *                                 `shogo:ide-font-changed`
 *                                 (`storage` doesn't fire in the writing
 *                                 tab; we dispatch this from Workbench).
 *
 *   getEditorFontFamily()  — synchronous reader for non-React code
 *                            (e.g. xterm-session boot path before the
 *                            React tree is in scope).
 *
 *   broadcastEditorFontChange(family) — same-tab notify helper. Called
 *                            by Workbench on every settings update.
 *
 * Why a custom event AND `storage`?
 *   The browser `storage` event fires in *other* tabs but NOT in the
 *   tab that performed the `localStorage.setItem`. We need same-tab
 *   reactivity (Settings pane is in the same tab as the editor), so
 *   we dispatch a CustomEvent on `window` and listen for that too.
 *
 * Why no React context?
 *   This is a leaf-readable value used by many panels (OutputTab,
 *   Problems, XtermView, DebugConsole, RunDebug, …). A context would
 *   force every panel into a single Provider subtree AND would still
 *   require XtermView (deeply nested) to be inside it. The hook reads
 *   from localStorage — same source of truth as the rest of editor
 *   settings — so the boot path doesn't change.
 */

import { useEffect, useState } from "react"

const STORAGE_KEY = "shogo.ide.settings"
const SAME_TAB_EVENT = "shogo:ide-font-changed"

/**
 * Canonical default. Picks a JetBrains-Mono-led stack that degrades
 * cleanly through Fira / Cascadia / Menlo / Consolas → generic mono.
 * Identical to the literal in `DEFAULT_SETTINGS.fontFamily` and the
 * fallback in `global.css` (`--ide-mono-font`). Pinned by a triple-
 * check test (`triple-source consistency`).
 */
export const DEFAULT_FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace"

export interface FontFamilyOption {
  /** Human-readable label shown in the Settings select. */
  label: string
  /** Full CSS font-family stack. */
  value: string
}

/**
 * Curated options. Each value is a complete font-family stack so the
 * IDE never resolves to the browser's serif fallback if the named
 * primary isn't installed.
 *
 * The first entry MUST be the system default (DEFAULT_FONT_FAMILY) so
 * the dropdown's first option always matches the baked-in state.
 */
export const FONT_FAMILY_OPTIONS: ReadonlyArray<FontFamilyOption> = [
  { label: "JetBrains Mono (default)", value: DEFAULT_FONT_FAMILY },
  {
    label: "Fira Code",
    value:
      "'Fira Code', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  },
  {
    label: "Cascadia Code",
    value:
      "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
  },
  {
    label: "SF Mono",
    value:
      "ui-monospace, 'SF Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
  },
  {
    label: "Menlo",
    value: "Menlo, 'DejaVu Sans Mono', Consolas, 'Liberation Mono', monospace",
  },
  {
    label: "Consolas",
    value: "Consolas, 'Liberation Mono', Menlo, monospace",
  },
  {
    label: "System monospace",
    value:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
] as const

/**
 * Read the live font-family from localStorage. Returns DEFAULT_FONT_FAMILY
 * on any failure (no DOM, malformed JSON, missing key, missing field,
 * non-string value).
 *
 * SAFE to call during SSR or in tests where `localStorage` is missing —
 * we guard each access. Never throws.
 */
export function getEditorFontFamily(): string {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_FONT_FAMILY
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_FONT_FAMILY
    const parsed = JSON.parse(raw) as { fontFamily?: unknown }
    const v = parsed?.fontFamily
    // Empty strings / whitespace-only / non-strings all fall back to the
    // default. Defensive: an old localStorage payload from before this
    // field existed lands cleanly on the default.
    if (typeof v !== "string") return DEFAULT_FONT_FAMILY
    const trimmed = v.trim()
    if (!trimmed) return DEFAULT_FONT_FAMILY
    return trimmed
  } catch {
    return DEFAULT_FONT_FAMILY
  }
}

/**
 * Same-tab broadcaster. Workbench calls this every time it persists a
 * new settings object so listeners in the same window get reactivity
 * without waiting on a `storage` event (which doesn't fire same-tab).
 *
 * `family` is forwarded in `event.detail.fontFamily` for subscribers
 * that prefer to skip the localStorage re-read. The hook still re-reads
 * (single source of truth) so the detail is purely informational.
 */
export function broadcastEditorFontChange(family: string): void {
  if (typeof window === "undefined") return
  try {
    window.dispatchEvent(
      new CustomEvent(SAME_TAB_EVENT, { detail: { fontFamily: family } }),
    )
  } catch {
    /* CustomEvent unsupported (very old browsers) — noop */
  }
}

/**
 * Live font-family for the current IDE settings. Resubscribes on every
 * mount; cleans up on unmount. Returns a string the caller can drop
 * straight into `style.fontFamily` or Monaco's `fontFamily` option.
 *
 * No React context, no prop drilling: any panel can call it.
 */
export function useEditorFont(): string {
  const [family, setFamily] = useState<string>(() => getEditorFontFamily())

  useEffect(() => {
    if (typeof window === "undefined") return
    const onStorage = (e: StorageEvent) => {
      // Other-tab updates only deliver the new raw payload via e.newValue
      // — re-read via the canonical reader so we honour the same parsing
      // rules (and ignore unrelated localStorage writes).
      if (e.key && e.key !== STORAGE_KEY) return
      setFamily(getEditorFontFamily())
    }
    const onSameTab = () => setFamily(getEditorFontFamily())
    window.addEventListener("storage", onStorage)
    window.addEventListener(SAME_TAB_EVENT, onSameTab as EventListener)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(SAME_TAB_EVENT, onSameTab as EventListener)
    }
  }, [])

  return family
}

// Test-facing constants (kept un-exported below to avoid leaking into the
// IDE surface). Tests import via the module path with the underscore
// prefix to make the intent explicit.
/** @internal — exposed for tests only. */
export const _STORAGE_KEY = STORAGE_KEY
/** @internal — exposed for tests only. */
export const _SAME_TAB_EVENT = SAME_TAB_EVENT
