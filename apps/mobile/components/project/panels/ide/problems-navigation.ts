// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-PROBLEMS-NAV — F8 / Shift+F8 cross-file problem navigation.
 *
 * Shogo's F8 cycled only within the ACTIVE editor model: once the cursor
 * reached the last marker in the current file it wrapped back to the top
 * of the SAME file and never visited diagnostics in other files. VS Code's
 * "Go to Next/Previous Problem (F8 / Shift+F8)" iterates the ENTIRE
 * workspace diagnostics collection — when you run off the end of one file
 * it jumps to the first marker of the next file, and off the end of the
 * whole workspace it wraps around to the very first marker.
 *
 * This module is the pure, side-effect-free engine behind that command,
 * mirroring the extraction pattern of quick-open-disambiguate.ts /
 * diff-view-mode.ts / minimap-settings.ts: no React, no Monaco import, no
 * DOM. The keybinding handler and the Monaco marker service stay thin and
 * the navigation logic is unit-testable in isolation.
 *
 * The fix in one line: flatten + sort markers across ALL resources, then
 * step through that flat list with wraparound — instead of indexing into
 * the active model's marker array.
 *
 * What lives here:
 *   • Diagnostic / Position value types and the collection shapes we accept
 *     (record, Map, or flat array — whatever the marker layer hands us).
 *   • `flattenDiagnostics` — produce the stable, totally-ordered list F8
 *     walks (resource → line → column → severity → message).
 *   • `navigateDiagnostics` — the rich result (target, wrapped, index,
 *     total) the command + status bar consume.
 *   • `nextDiagnostic` — thin convenience wrapper returning just the target.
 *   • `scope: 'workspace' | 'file'` — 'workspace' is the new default (the
 *     fix); 'file' preserves/documents the OLD single-file behaviour and
 *     lets tests pin both.
 *   • Severity filtering + counts.
 */

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint"

/** Tiebreak ordering when two markers share a position (errors first). */
const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
}

export interface Diagnostic {
  /** File path or URI the marker belongs to. */
  resource: string
  startLineNumber: number
  startColumn: number
  endLineNumber?: number
  endColumn?: number
  severity: DiagnosticSeverity
  message?: string
}

/** A cursor location used as the navigation anchor. */
export interface Position {
  resource: string
  lineNumber: number
  column: number
}

/** Whatever shape the marker layer hands us. */
export type DiagnosticsCollection =
  | Record<string, Diagnostic[]>
  | Map<string, Diagnostic[]>
  | Diagnostic[]

export type NavigationDirection = "next" | "previous"
export type NavigationScope = "workspace" | "file"

export interface NavigateOptions {
  direction?: NavigationDirection
  /** 'workspace' (default, the fix) walks all files; 'file' = legacy single-file. */
  scope?: NavigationScope
  /** Restrict navigation to these severities (default: all). */
  severities?: readonly DiagnosticSeverity[]
}

export interface NavigationResult {
  /** The diagnostic to reveal, or null when there is nothing to navigate to. */
  target: Diagnostic | null
  /** True when the step wrapped around an end of the (scoped) collection. */
  wrapped: boolean
  /** Index of `target` within the scoped, ordered list (-1 when none). */
  index: number
  /** Size of the scoped, ordered list. */
  total: number
}

const EMPTY_RESULT: NavigationResult = { target: null, wrapped: false, index: -1, total: 0 }

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n)
}

/** A diagnostic is usable only with a resource and finite start position. */
function isValidDiagnostic(d: unknown): d is Diagnostic {
  if (!d || typeof d !== "object") return false
  const x = d as Record<string, unknown>
  return (
    typeof x.resource === "string" &&
    x.resource.length > 0 &&
    isFiniteNumber(x.startLineNumber) &&
    isFiniteNumber(x.startColumn) &&
    (x.severity === "error" || x.severity === "warning" || x.severity === "info" || x.severity === "hint")
  )
}

/** Normalise any accepted collection shape to a flat, validated array. */
function collectAll(collection: DiagnosticsCollection | null | undefined): Diagnostic[] {
  if (!collection) return []
  const out: Diagnostic[] = []
  const pushAll = (arr: unknown) => {
    if (!Array.isArray(arr)) return
    for (const d of arr) if (isValidDiagnostic(d)) out.push(d)
  }
  if (Array.isArray(collection)) {
    pushAll(collection)
  } else if (collection instanceof Map) {
    for (const arr of collection.values()) pushAll(arr)
  } else if (typeof collection === "object") {
    for (const key of Object.keys(collection)) pushAll((collection as Record<string, Diagnostic[]>)[key])
  }
  return out
}

/** Total order: resource → startLine → startColumn → severity → message. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1
  if (a.startLineNumber !== b.startLineNumber) return a.startLineNumber - b.startLineNumber
  if (a.startColumn !== b.startColumn) return a.startColumn - b.startColumn
  const sr = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (sr !== 0) return sr
  return (a.message ?? "").localeCompare(b.message ?? "")
}

/** Compare a cursor position against a diagnostic's start (resource→line→col). */
function comparePositionToDiagnostic(pos: Position, d: Diagnostic): number {
  if (pos.resource !== d.resource) return pos.resource < d.resource ? -1 : 1
  if (pos.lineNumber !== d.startLineNumber) return pos.lineNumber - d.startLineNumber
  return pos.column - d.startColumn
}

/**
 * Flatten the whole collection into the stable, totally-ordered list F8
 * walks. Optionally filter by severity. Invalid entries are dropped.
 */
export function flattenDiagnostics(
  collection: DiagnosticsCollection | null | undefined,
  severities?: readonly DiagnosticSeverity[],
): Diagnostic[] {
  let all = collectAll(collection)
  if (severities && severities.length > 0) {
    const allow = new Set(severities)
    all = all.filter((d) => allow.has(d.severity))
  }
  // Stable: decorate-sort-undecorate so equal keys keep insertion order.
  return all
    .map((d, i) => ({ d, i }))
    .sort((x, y) => compareDiagnostics(x.d, y.d) || x.i - y.i)
    .map((w) => w.d)
}

/** Count diagnostics (optionally of given severities) in the collection. */
export function countDiagnostics(
  collection: DiagnosticsCollection | null | undefined,
  severities?: readonly DiagnosticSeverity[],
): number {
  return flattenDiagnostics(collection, severities).length
}

/**
 * The core navigation step.
 *
 * - Empty (scoped) collection → no target.
 * - No `from` anchor → first (next) or last (previous) marker.
 * - `from` strictly between/on markers → the next marker strictly after
 *   (next) or strictly before (previous) the cursor — so sitting ON a
 *   marker advances off it, matching VS Code.
 * - Running off either end wraps around and sets `wrapped: true`.
 * - scope 'workspace' (default) walks every file; 'file' restricts to
 *   `from.resource` (legacy behaviour, kept for parity/testing).
 */
export function navigateDiagnostics(
  collection: DiagnosticsCollection | null | undefined,
  from: Position | null | undefined,
  options: NavigateOptions = {},
): NavigationResult {
  const direction = options.direction ?? "next"
  const scope = options.scope ?? "workspace"

  let list = flattenDiagnostics(collection, options.severities)
  if (scope === "file") {
    if (!from) return { ...EMPTY_RESULT }
    list = list.filter((d) => d.resource === from.resource)
  }
  const total = list.length
  if (total === 0) return { ...EMPTY_RESULT }

  // No anchor: enter at the natural end for the direction.
  if (!from || !isValidPosition(from)) {
    const index = direction === "next" ? 0 : total - 1
    return { target: list[index], wrapped: false, index, total }
  }

  if (direction === "next") {
    for (let i = 0; i < total; i++) {
      if (comparePositionToDiagnostic(from, list[i]) < 0) {
        return { target: list[i], wrapped: false, index: i, total }
      }
    }
    // Past the last marker → wrap to the first.
    return { target: list[0], wrapped: true, index: 0, total }
  }

  // previous
  for (let i = total - 1; i >= 0; i--) {
    if (comparePositionToDiagnostic(from, list[i]) > 0) {
      return { target: list[i], wrapped: false, index: i, total }
    }
  }
  // Before the first marker → wrap to the last.
  return { target: list[total - 1], wrapped: true, index: total - 1, total }
}

/** Convenience wrapper returning just the target diagnostic (or null). */
export function nextDiagnostic(
  collection: DiagnosticsCollection | null | undefined,
  from: Position | null | undefined,
  options: NavigateOptions = {},
): Diagnostic | null {
  return navigateDiagnostics(collection, from, options).target
}

function isValidPosition(p: Position): boolean {
  return (
    typeof p.resource === "string" &&
    p.resource.length > 0 &&
    isFiniteNumber(p.lineNumber) &&
    isFiniteNumber(p.column)
  )
}
