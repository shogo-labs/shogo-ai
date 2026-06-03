// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-PEEK — Peek Definition / References (inline overlay) wiring.
 *
 * Shogo left Monaco's `gotoLocation` behaviour at its bare default, so
 * "Go to Definition" always opened a brand-new editor and Cmd/Ctrl+Click
 * never produced VS Code's inline Peek overlay — even though Monaco ships
 * the peek widgets, they were simply never configured. This module is the
 * pure, side-effect-free brain that (a) decides, for a given navigation
 * trigger and the number of resolved target locations, whether to PEEK
 * inline, GO TO the target, do both, or nothing; and (b) maps a small
 * preference object to the exact Monaco `gotoLocation` + peek options.
 *
 * Same extraction pattern as the other UX-* modules (quick-open-
 * disambiguate / diff-view-mode / minimap-settings / problems-navigation /
 * tab-context-menu): no React, no Monaco import, no DOM. The keybinding /
 * mouse handler and the editor-construction code stay thin and every rule
 * is unit-testable in isolation.
 *
 * Mapping to VS Code / Monaco concepts:
 *   • `editor.gotoLocation.multiple<Kind>` — what to do when a navigation
 *     resolves to MORE THAN ONE location: 'peek' | 'gotoAndPeek' | 'goto'.
 *   • Explicit "Peek …" commands (Alt+F12, Shift+F12) always peek, even
 *     for a single location.
 *   • Cmd/Ctrl+Click — the fix routes this to an inline peek by default
 *     (configurable), instead of opening a new editor.
 *   • `peekWidgetDefaultFocus` — 'tree' | 'editor'.
 *
 * Deliberately NOT here: Monaco import, editor instances, DOM, React.
 */

/** The kinds of "go to location" navigations Monaco supports. */
export type LocationKind =
  | "definition"
  | "typeDefinition"
  | "declaration"
  | "implementation"
  | "references"

/** What the user did to trigger navigation. */
export type PeekTrigger =
  | "click" // Cmd/Ctrl+Click on a symbol
  | "goToDefinition" // F12
  | "peekDefinition" // Alt+F12 (explicit peek)
  | "goToTypeDefinition"
  | "goToImplementation"
  | "goToDeclaration"
  | "goToReferences" // Go to References
  | "peekReferences" // Shift+F12 (explicit peek)

/** Monaco's per-kind multi-location preference. */
export type MultiLocationPreference = "peek" | "gotoAndPeek" | "goto"

/** The resolved action a handler should perform. */
export type PeekAction = "peek" | "goto" | "gotoAndPeek" | "none"

export type PeekWidgetFocus = "tree" | "editor"

export interface PeekPreferences {
  multipleDefinitions: MultiLocationPreference
  multipleTypeDefinitions: MultiLocationPreference
  multipleDeclarations: MultiLocationPreference
  multipleImplementations: MultiLocationPreference
  multipleReferences: MultiLocationPreference
  /** Where focus lands when a peek widget opens. */
  peekWidgetDefaultFocus: PeekWidgetFocus
  /** The fix: Cmd/Ctrl+Click opens an inline peek instead of a new editor. */
  clickOpensPeek: boolean
}

/** Defaults that realise the fix (cmd+click → peek; multi → peek). */
export const DEFAULT_PEEK_PREFERENCES: Readonly<PeekPreferences> = Object.freeze({
  multipleDefinitions: "peek",
  multipleTypeDefinitions: "peek",
  multipleDeclarations: "peek",
  multipleImplementations: "peek",
  multipleReferences: "peek",
  peekWidgetDefaultFocus: "tree",
  clickOpensPeek: true,
})

const MULTI_VALUES: readonly MultiLocationPreference[] = ["peek", "gotoAndPeek", "goto"]
const FOCUS_VALUES: readonly PeekWidgetFocus[] = ["tree", "editor"]

/** Triggers that ALWAYS peek, regardless of count or preference. */
const EXPLICIT_PEEK_TRIGGERS: ReadonlySet<PeekTrigger> = new Set<PeekTrigger>([
  "peekDefinition",
  "peekReferences",
])

/** Map a trigger to the location kind it navigates. */
export function triggerLocationKind(trigger: PeekTrigger): LocationKind {
  switch (trigger) {
    case "goToTypeDefinition":
      return "typeDefinition"
    case "goToDeclaration":
      return "declaration"
    case "goToImplementation":
      return "implementation"
    case "goToReferences":
    case "peekReferences":
      return "references"
    case "click":
    case "goToDefinition":
    case "peekDefinition":
    default:
      return "definition"
  }
}

function isMulti(v: unknown): v is MultiLocationPreference {
  return v === "peek" || v === "gotoAndPeek" || v === "goto"
}

function coerceMulti(v: unknown, fallback: MultiLocationPreference): MultiLocationPreference {
  if (isMulti(v)) return v
  if (typeof v === "string") {
    const n = v.trim()
    if (isMulti(n)) return n
  }
  return fallback
}

function coerceFocus(v: unknown, fallback: PeekWidgetFocus): PeekWidgetFocus {
  if (v === "tree" || v === "editor") return v
  if (typeof v === "string") {
    const n = v.trim().toLowerCase()
    if (n === "tree" || n === "editor") return n
  }
  return fallback
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "string") {
    const n = v.trim().toLowerCase()
    if (n === "true") return true
    if (n === "false") return false
  }
  return fallback
}

/** Build a complete, valid preferences object from a partial/dirty input. */
export function parsePeekPreferences(
  raw: unknown,
  base: PeekPreferences = DEFAULT_PEEK_PREFERENCES,
): PeekPreferences {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const pick = (k: string) => (k in s ? s[k] : s[`gotoLocation.${k}`] ?? s[`editor.gotoLocation.${k}`])
  return {
    multipleDefinitions: coerceMulti(pick("multipleDefinitions"), base.multipleDefinitions),
    multipleTypeDefinitions: coerceMulti(pick("multipleTypeDefinitions"), base.multipleTypeDefinitions),
    multipleDeclarations: coerceMulti(pick("multipleDeclarations"), base.multipleDeclarations),
    multipleImplementations: coerceMulti(pick("multipleImplementations"), base.multipleImplementations),
    multipleReferences: coerceMulti(pick("multipleReferences"), base.multipleReferences),
    peekWidgetDefaultFocus: coerceFocus(pick("peekWidgetDefaultFocus"), base.peekWidgetDefaultFocus),
    clickOpensPeek: coerceBool(pick("clickOpensPeek"), base.clickOpensPeek),
  }
}

/** The per-kind multi preference for a given location kind. */
export function multiPreferenceFor(prefs: PeekPreferences, kind: LocationKind): MultiLocationPreference {
  switch (kind) {
    case "typeDefinition":
      return prefs.multipleTypeDefinitions
    case "declaration":
      return prefs.multipleDeclarations
    case "implementation":
      return prefs.multipleImplementations
    case "references":
      return prefs.multipleReferences
    case "definition":
    default:
      return prefs.multipleDefinitions
  }
}

/** Normalise a possibly-dirty location count to a non-negative integer. */
function normalizeCount(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0
  return n < 0 ? 0 : Math.floor(n)
}

/**
 * The core decision. Given the trigger, how many locations resolved, and
 * the preferences, return the action a handler should perform.
 *
 * Rules (VS Code parity, plus the cmd+click fix):
 *   • 0 locations → 'none' (caller shows the "No definition found" hint).
 *   • Explicit peek command (Alt+F12 / Shift+F12) → always 'peek',
 *     even for a single location.
 *   • References navigation is inherently a list → 'peek' unless the
 *     preference is 'goto' (then jump to the first), regardless of count.
 *   • Cmd/Ctrl+Click → 'peek' when clickOpensPeek (the fix) AND there is
 *     something to show; otherwise behaves like Go to Definition.
 *   • Single location on a goto trigger → 'goto' (jump straight there).
 *   • Multiple locations on a goto trigger → consult the per-kind multi
 *     preference ('peek' | 'gotoAndPeek' | 'goto').
 */
export function resolvePeekAction(
  trigger: PeekTrigger,
  locationCount: number,
  prefs: PeekPreferences = DEFAULT_PEEK_PREFERENCES,
): PeekAction {
  const count = normalizeCount(locationCount)
  if (count === 0) return "none"

  if (EXPLICIT_PEEK_TRIGGERS.has(trigger)) return "peek"

  const kind = triggerLocationKind(trigger)
  const multi = multiPreferenceFor(prefs, kind)

  // References: a list by nature — peek the list unless told to just goto.
  if (kind === "references") {
    return multi === "goto" ? "goto" : "peek"
  }

  // Cmd/Ctrl+Click — the fix: open an inline peek instead of a new editor.
  if (trigger === "click" && prefs.clickOpensPeek) {
    return count > 1 && multi === "gotoAndPeek" ? "gotoAndPeek" : "peek"
  }

  // Goto-style triggers (incl. click when clickOpensPeek is off).
  if (count <= 1) return "goto"
  return multi // 'peek' | 'gotoAndPeek' | 'goto'
}

/** The Monaco `gotoLocation` option slice (per-kind multi preferences). */
export interface MonacoGotoLocationOptions {
  multipleDefinitions: MultiLocationPreference
  multipleTypeDefinitions: MultiLocationPreference
  multipleDeclarations: MultiLocationPreference
  multipleImplementations: MultiLocationPreference
  multipleReferences: MultiLocationPreference
}

export interface MonacoPeekEditorOptions {
  gotoLocation: MonacoGotoLocationOptions
  peekWidgetDefaultFocus: PeekWidgetFocus
}

/** Map preferences to the exact Monaco editor options to set at construction. */
export function peekPreferencesToMonacoOptions(
  input: PeekPreferences | unknown,
): MonacoPeekEditorOptions {
  const p = parsePeekPreferences(input)
  return {
    gotoLocation: {
      multipleDefinitions: p.multipleDefinitions,
      multipleTypeDefinitions: p.multipleTypeDefinitions,
      multipleDeclarations: p.multipleDeclarations,
      multipleImplementations: p.multipleImplementations,
      multipleReferences: p.multipleReferences,
    },
    peekWidgetDefaultFocus: p.peekWidgetDefaultFocus,
  }
}

export const PEEK_INTERNAL = { MULTI_VALUES, FOCUS_VALUES, normalizeCount } as const
