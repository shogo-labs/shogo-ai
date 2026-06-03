// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the desktop-only Activity Bar badge helpers.
 *
 * Coverage targets — every branch + every weird input I could think of:
 *
 *   formatBadgeCount:
 *     - happy path 1..99 and the > 99 cap
 *     - 0 / negatives → ""
 *     - NaN, +Infinity, -Infinity
 *     - null, undefined (defensive against callers passing raw API output)
 *     - fractions are floored (1.9 → "1", not "2")
 *     - exact boundaries: 1, 99, 100
 *
 *   gitChangeCount:
 *     - null / undefined snapshot
 *     - snapshot.isRepo === false
 *     - missing / non-object fileStatus
 *     - mixture of every GitShortCode and verifies the counted-set matches
 *       VS Code (excludes '!' ignored and never counts the synthetic '·')
 *     - prototype-polluted fileStatus still produces a sane count
 *
 *   problemsBadge:
 *     - null / undefined / empty
 *     - errors only
 *     - warnings only
 *     - mix → errors win, count is errors-only (NOT errors+warnings)
 *     - info / hint only → no badge
 *     - unknown severities are ignored, not counted
 *     - null entries in the array don't crash
 */

import { describe, it, expect } from "bun:test"

import {
  formatBadgeCount,
  gitChangeCount,
  problemsBadge,
} from "../formatBadge"
import type { GitSnapshot, GitShortCode } from "../../git/bridge"
import type { Diagnostic } from "../../../../../lib/diagnostics-api"

// ───── helpers ────────────────────────────────────────────────────────────

function makeSnapshot(
  fileStatus: Record<string, GitShortCode>,
  overrides: Partial<GitSnapshot> = {},
): GitSnapshot {
  return {
    isRepo: true,
    fileStatus,
    // Required-but-unused fields filled with safe defaults. We only assert
    // against fileStatus + isRepo so the rest of the shape doesn't matter
    // for these tests; if GitSnapshot grows fields, this stays compiling.
    ...({} as Partial<GitSnapshot>),
    ...overrides,
  } as GitSnapshot
}

function diag(severity: Diagnostic["severity"], message = "x"): Diagnostic {
  return {
    id: `${severity}-${message}`,
    source: "ts",
    severity,
    file: "src/foo.ts",
    line: 1,
    column: 1,
    message,
  }
}

// ───── formatBadgeCount ───────────────────────────────────────────────────

describe("formatBadgeCount", () => {
  it("returns '' for 0", () => {
    expect(formatBadgeCount(0)).toBe("")
  })

  it("returns 'n' for 1..99", () => {
    expect(formatBadgeCount(1)).toBe("1")
    expect(formatBadgeCount(7)).toBe("7")
    expect(formatBadgeCount(99)).toBe("99")
  })

  it("caps at '99+' for anything over 99", () => {
    expect(formatBadgeCount(100)).toBe("99+")
    expect(formatBadgeCount(9999)).toBe("99+")
  })

  it("floors fractional inputs", () => {
    expect(formatBadgeCount(1.9)).toBe("1")
    expect(formatBadgeCount(0.999)).toBe("")
    expect(formatBadgeCount(99.999)).toBe("99")
  })

  it("returns '' for negatives", () => {
    expect(formatBadgeCount(-1)).toBe("")
    expect(formatBadgeCount(-9999)).toBe("")
  })

  it("returns '' for NaN", () => {
    expect(formatBadgeCount(NaN)).toBe("")
  })

  it("treats +Infinity as overflow → '99+'", () => {
    expect(formatBadgeCount(Number.POSITIVE_INFINITY)).toBe("99+")
  })

  it("treats -Infinity as empty", () => {
    expect(formatBadgeCount(Number.NEGATIVE_INFINITY)).toBe("")
  })

  it("returns '' for null / undefined (defensive)", () => {
    expect(formatBadgeCount(null)).toBe("")
    expect(formatBadgeCount(undefined)).toBe("")
  })

  it("returns '' for non-number inputs that sneak through as `any`", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatBadgeCount("5" as any)).toBe("")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatBadgeCount({} as any)).toBe("")
  })
})

// ───── gitChangeCount ─────────────────────────────────────────────────────

describe("gitChangeCount", () => {
  it("returns 0 for null / undefined snapshot", () => {
    expect(gitChangeCount(null)).toBe(0)
    expect(gitChangeCount(undefined)).toBe(0)
  })

  it("returns 0 when snapshot.isRepo is false", () => {
    expect(gitChangeCount(makeSnapshot({ "a.ts": "M" }, { isRepo: false }))).toBe(0)
  })

  it("returns 0 when fileStatus is missing or not an object", () => {
    // Force-cast: GitSnapshot.fileStatus is required, but we want to prove
    // the defensive guard fires if a future bridge bug ships undefined.
    expect(gitChangeCount({ isRepo: true } as unknown as GitSnapshot)).toBe(0)
    expect(gitChangeCount({ isRepo: true, fileStatus: null } as unknown as GitSnapshot)).toBe(0)
  })

  it("counts each non-clean, non-ignored code exactly once", () => {
    const snap = makeSnapshot({
      "a.ts": "M",
      "b.ts": "A",
      "c.ts": "D",
      "d.ts": "R",
      "e.ts": "C",
      "f.ts": "T",
      "g.ts": "U",
      "h.ts": "?",
    })
    expect(gitChangeCount(snap)).toBe(8)
  })

  it("excludes '!' (ignored files) just like VS Code's SCM badge", () => {
    const snap = makeSnapshot({
      "a.ts": "M",
      "node_modules/x.js": "!",
      ".env": "!",
    })
    expect(gitChangeCount(snap)).toBe(1)
  })

  it("ignores the synthetic '·' folder-dirty marker if it ever leaks into fileStatus", () => {
    // '·' is produced by GitStatusContext.folderDirty(); it should never be
    // stored in fileStatus, but the helper defends against bridge bugs.
    const snap = makeSnapshot({
      "a.ts": "M",
      "src": "·" as GitShortCode,
    })
    expect(gitChangeCount(snap)).toBe(1)
  })

  it("returns 0 for an empty fileStatus", () => {
    expect(gitChangeCount(makeSnapshot({}))).toBe(0)
  })

  it("survives prototype-polluted iteration (own-property only)", () => {
    const poisoned = Object.create({ "evil.ts": "M" }) as Record<string, GitShortCode>
    poisoned["a.ts"] = "M"
    poisoned["b.ts"] = "A"
    expect(gitChangeCount(makeSnapshot(poisoned))).toBe(2)
  })
})

// ───── problemsBadge ──────────────────────────────────────────────────────

describe("problemsBadge", () => {
  it("returns {0, null} for null / undefined / empty", () => {
    expect(problemsBadge(null)).toEqual({ count: 0, severity: null })
    expect(problemsBadge(undefined)).toEqual({ count: 0, severity: null })
    expect(problemsBadge([])).toEqual({ count: 0, severity: null })
  })

  it("counts errors and tags severity as 'error' when any error present", () => {
    const d = [diag("error"), diag("error"), diag("warning")]
    expect(problemsBadge(d)).toEqual({ count: 2, severity: "error" })
  })

  it("counts warnings and tags severity as 'warn' when only warnings present", () => {
    const d = [diag("warning"), diag("warning"), diag("info")]
    expect(problemsBadge(d)).toEqual({ count: 2, severity: "warn" })
  })

  it("returns {0, null} when only info / hint diagnostics are present", () => {
    const d = [diag("info"), diag("hint"), diag("info")]
    expect(problemsBadge(d)).toEqual({ count: 0, severity: null })
  })

  it("does NOT sum errors+warnings into the count (matches VS Code badge)", () => {
    const d = [diag("error"), diag("warning"), diag("warning"), diag("warning")]
    // Errors dominate → count is error count only.
    expect(problemsBadge(d)).toEqual({ count: 1, severity: "error" })
  })

  it("ignores unknown / malformed severities without throwing", () => {
    const garbage = [
      diag("error"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...diag("error"), severity: "fatal" as any },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...diag("warning"), severity: undefined as any },
    ]
    expect(problemsBadge(garbage)).toEqual({ count: 1, severity: "error" })
  })

  it("skips null entries in the array", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mixed = [diag("error"), null as any, diag("warning")]
    expect(problemsBadge(mixed)).toEqual({ count: 1, severity: "error" })
  })
})
