// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helpers for the desktop-only Activity Bar badge system.
 *
 * Three small functions, three small contracts:
 *
 *   formatBadgeCount(n)   — turn a raw number into the string we render in
 *                            the pill. VS Code parity: 1..99 raw, anything
 *                            larger collapses to "99+". 0, negatives, NaN,
 *                            and non-finite values all return "" so the
 *                            renderer can short-circuit to "no badge".
 *
 *   gitChangeCount(snap)  — count of files VS Code would surface in the
 *                            SCM gutter: anything non-clean except '!'
 *                            (ignored). Returns 0 when there is no repo /
 *                            no snapshot.
 *
 *   problemsBadge(diags)  — collapses a diagnostics list into a single
 *                            { count, severity } pair following the same
 *                            precedence as VS Code's Problems badge:
 *                            errors win over warnings, and info/hint are
 *                            invisible to the badge.
 *
 * No React, no Monaco, no DOM. All three are pure so they unit-test under
 * `bun test` without any of the editor surface mounted.
 */

import type { GitShortCode, GitSnapshot } from "../git/bridge"
import { isCountedGitCode } from "../git/git-counting"
import type { Diagnostic } from "../../../../lib/diagnostics-api"

/** Tone tells the renderer which color family to use for the pill. */
export type BadgeTone = "neutral" | "warn" | "error"

/** Renderable badge slot. count===0 means "do not render". */
export interface BadgeData {
  count: number
  tone?: BadgeTone
}

// ─── formatBadgeCount ──────────────────────────────────────────────────────

/**
 * Render-string for a badge count. Returns "" when the badge should not
 * be drawn, so the renderer can do a single truthy check.
 *
 * Rules:
 *   - non-finite, NaN, undefined-coerced  → ""
 *   - <= 0                                → ""
 *   - 1..99                               → "n" (integers only — fractions floored)
 *   - > 99                                → "99+"
 *
 * `Infinity` is treated as "huge" (renders "99+") rather than dropped,
 * since dropping it would silently hide a real (if pathological) overflow.
 */
export function formatBadgeCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return ""
  if (typeof n !== "number" || Number.isNaN(n)) return ""
  if (n === Number.POSITIVE_INFINITY) return "99+"
  if (n === Number.NEGATIVE_INFINITY) return ""
  const i = Math.floor(n)
  if (i <= 0) return ""
  if (i > 99) return "99+"
  return String(i)
}

// ─── gitChangeCount ────────────────────────────────────────────────────────

/**
 * Number of changed files VS Code's SCM badge would show.
 *
 * Defensive: returns 0 for null, undefined, non-repo, missing fileStatus,
 * or a fileStatus that is not a plain object. Per-code rule lives in
 * git-counting.isCountedGitCode — the single source of truth shared with
 * ChangesList.buildGroups (BUG-007 fix).
 */
export function gitChangeCount(snapshot: GitSnapshot | null | undefined): number {
  if (!snapshot || !snapshot.isRepo) return 0
  const fs = snapshot.fileStatus
  if (!fs || typeof fs !== "object") return 0
  let n = 0
  for (const path in fs) {
    // Defend against prototype-polluted iteration.
    if (!Object.prototype.hasOwnProperty.call(fs, path)) continue
    if (isCountedGitCode(fs[path])) n++
  }
  return n
}

// Re-exported for back-compat with any test that imported the constant
// directly; new code should use isCountedGitCode().
// (Internal: not part of the public API.)

// ─── problemsBadge ─────────────────────────────────────────────────────────

export interface ProblemsBadgeResult {
  /** Count to render. 0 → no badge. */
  count: number
  /**
   * Tone hint for the renderer. 'error' when any diagnostic is an error,
   * 'warn' when only warnings are present, null when nothing badge-worthy.
   */
  severity: "error" | "warn" | null
}

/**
 * VS Code-style problems badge:
 *
 *   - any errors        → { count: errors,   severity: 'error' }
 *   - only warnings     → { count: warnings, severity: 'warn'  }
 *   - only info / hint  → { count: 0,        severity: null    }
 *   - empty / null      → { count: 0,        severity: null    }
 *
 * This matches what the VS Code Problems badge surfaces — info and hint
 * diagnostics are intentionally invisible to the rail so the badge tracks
 * "things that need attention" only.
 *
 * Robust to:
 *   - null / undefined / empty arrays
 *   - diagnostics with unexpected/garbage severities (they're ignored, not counted)
 */
export function problemsBadge(
  diagnostics: readonly Diagnostic[] | null | undefined,
): ProblemsBadgeResult {
  if (!diagnostics || diagnostics.length === 0) {
    return { count: 0, severity: null }
  }
  let errors = 0
  let warnings = 0
  for (const d of diagnostics) {
    if (!d) continue
    if (d.severity === "error") errors++
    else if (d.severity === "warning") warnings++
    // info / hint / unknown → ignored
  }
  if (errors > 0) return { count: errors, severity: "error" }
  if (warnings > 0) return { count: warnings, severity: "warn" }
  return { count: 0, severity: null }
}
