// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-CMDPAL — fzf-scorer contract lockdown.
 *
 * Every behaviour described in fzf-scorer.ts's module-doc is pinned by a
 * named test. Future refactors that "simplify" a bonus tier (the kind of
 * change that quietly degrades ranking quality) will break a specific
 * test by name, not just shift an opaque ordering.
 */
import { describe, expect, test } from "bun:test"
import { fzfScore, _CONSTANTS } from "../fzf-scorer"

// ─── basic shape ─────────────────────────────────────────────────────────
describe("fzfScore — shape", () => {
  test("empty needle returns score 0 / no positions", () => {
    expect(fzfScore("", "anything")).toEqual({ score: 0, positions: [] })
  })

  test("empty haystack with non-empty needle is null (no match possible)", () => {
    expect(fzfScore("a", "")).toBeNull()
  })

  test("needle longer than haystack: null when last char missing", () => {
    expect(fzfScore("hello", "hi")).toBeNull()
  })

  test("complete prefix match: positions are 0..n-1", () => {
    const r = fzfScore("abc", "abcdef")!
    expect(r).not.toBeNull()
    expect(r.positions).toEqual([0, 1, 2])
  })

  test("strictly-increasing positions even with gaps", () => {
    const r = fzfScore("abc", "axbycz")!
    expect(r.positions).toEqual([0, 2, 4])
    for (let i = 1; i < r.positions.length; i++) {
      expect(r.positions[i]).toBeGreaterThan(r.positions[i - 1]!)
    }
  })

  test("returns null when any needle char is missing", () => {
    expect(fzfScore("xyz", "abcdef")).toBeNull()
  })
})

// ─── smartcase ───────────────────────────────────────────────────────────
describe("fzfScore — smartcase", () => {
  test("all-lowercase needle is case-insensitive (matches any-case haystack)", () => {
    expect(fzfScore("editor", "EditorTabs")).not.toBeNull()
    expect(fzfScore("editor", "editortabs")).not.toBeNull()
    expect(fzfScore("editor", "EDITORTABS")).not.toBeNull()
  })

  test("any uppercase in needle triggers smartcase (case-sensitive)", () => {
    // Even ALL-uppercase counts as "has uppercase" — there is no
    // separate "shouty-case" mode. Picked to be consistent: any
    // uppercase ⇒ exact case. "EDITOR" against "EditorTabs" fails
    // because `D` (upper) cannot match `d` (lower) in sensitive mode.
    expect(fzfScore("EDITOR", "EditorTabs")).toBeNull()
    expect(fzfScore("EDITOR", "EDITORTABS")).not.toBeNull()
  })

  test("any uppercase in needle forces case-sensitive (matches MixedCase)", () => {
    expect(fzfScore("Editor", "EditorTabs")).not.toBeNull()
  })

  test("any uppercase in needle rejects all-lower haystack", () => {
    expect(fzfScore("Editor", "editortabs")).toBeNull()
  })

  test("smartcase boundary: single uppercase still triggers", () => {
    // The 'E' alone is enough to flip the mode.
    expect(fzfScore("Etabs", "etabs")).toBeNull()
    expect(fzfScore("Etabs", "Etabs")).not.toBeNull()
  })
})

// ─── boundary tiers ─────────────────────────────────────────────────────
describe("fzfScore — boundary ranking", () => {
  test("first char of haystack outranks first char of word", () => {
    // "s" → "src" (matches char 0) MUST beat "s" → "obs" (matches char 2,
    // a generic intra-word). Even with the late-match tiebreak alone,
    // first-char-of-haystack wins decisively because of the
    // BONUS_FIRST_CHAR_MULTIPLIER applied at index 0.
    const a = fzfScore("s", "src")!
    const b = fzfScore("s", "obs")!
    expect(a.score).toBeGreaterThan(b.score)
  })

  test("word-start hit (after /) outranks generic mid-word hit", () => {
    const a = fzfScore("c", "src/components")!  // after '/'
    const b = fzfScore("c", "src/abscissa")!     // generic mid-word
    expect(a.score).toBeGreaterThan(b.score)
  })

  test("after - outranks generic mid-word", () => {
    const a = fzfScore("c", "abc-component")!
    const b = fzfScore("c", "ab-abcssss")!
    // Both have matches; the first has a word-start "c" right after "-".
    expect(a.score).toBeGreaterThan(b.score)
  })

  test("after _ outranks generic mid-word", () => {
    const a = fzfScore("a", "abc_apple")!
    const b = fzfScore("a", "xbcdapple")!
    expect(a.score).toBeGreaterThan(b.score)
  })

  test("camelCase boundary recognised (lower→Upper)", () => {
    const a = fzfScore("c", "doSomeCommand")!  // 'C' at camelCase
    const b = fzfScore("c", "doommecommand")!  // generic
    expect(a.score).toBeGreaterThan(b.score)
  })
})

// ─── consecutive vs gap ─────────────────────────────────────────────────
describe("fzfScore — consecutive run vs gap penalty", () => {
  test("consecutive run beats spread match of equal length", () => {
    const tight = fzfScore("foo", "foobar")!
    const spread = fzfScore("foo", "fxxoxxo")!
    expect(tight.score).toBeGreaterThan(spread.score)
  })

  test("smaller gap beats larger gap (linear penalty)", () => {
    const small = fzfScore("ab", "axb")!   // 1-char gap
    const big = fzfScore("ab", "axxxxb")!  // 4-char gap
    expect(small.score).toBeGreaterThan(big.score)
  })

  test("zero-gap (consecutive) wins over one-char gap", () => {
    const zero = fzfScore("ab", "ab")!
    const one = fzfScore("ab", "axb")!
    expect(zero.score).toBeGreaterThan(one.score)
  })

  test("consecutive bonus is the published default (BONUS_CONSECUTIVE = 14)", () => {
    expect(_CONSTANTS.BONUS_CONSECUTIVE).toBe(14)
  })
})

// ─── tiebreaks ──────────────────────────────────────────────────────────
describe("fzfScore — tiebreaks", () => {
  test("earlier match wins when two haystacks have identical shape", () => {
    // 'a' matches at index 0 vs index 5; same length, same prev-char (none / 'b').
    // Tiebreak is the late-match -0.1 * positions[0] term.
    const early = fzfScore("a", "abcdefg")!
    const late = fzfScore("a", "bcdefga")!
    expect(early.score).toBeGreaterThan(late.score)
  })

  test("shorter haystack wins when matches are otherwise identical", () => {
    // -0.01 * length tiebreak. Both prefix-match on 'a'.
    const short = fzfScore("a", "a")!
    const long = fzfScore("a", "abcdefghij")!
    expect(short.score).toBeGreaterThan(long.score)
  })
})

// ─── full-string match invariants ───────────────────────────────────────
describe("fzfScore — exact match invariants", () => {
  test("identical needle and haystack scores highest among matching candidates", () => {
    const exact = fzfScore("editor", "editor")!
    const partial = fzfScore("editor", "editor-tabs")!
    const distant = fzfScore("editor", "extreme-disaster-fork")!
    expect(exact.score).toBeGreaterThan(partial.score)
    expect(partial.score).toBeGreaterThan(distant.score)
  })

  test("score is always finite (no NaN/Infinity from any constant combination)", () => {
    const cases = [
      ["a", "a"],
      ["abc", "abc"],
      ["aZ9", "aZ9"],
      ["zzzzz", "zzzzzzzzzz"],
      ["a", "a".repeat(2048)],
    ]
    for (const [n, h] of cases) {
      const r = fzfScore(n!, h!)
      if (r) expect(Number.isFinite(r.score)).toBe(true)
    }
  })
})

// ─── performance cap ────────────────────────────────────────────────────
describe("fzfScore — performance bounds", () => {
  test("haystack longer than MAX_HAYSTACK_SCAN is truncated, not scanned in full", () => {
    // We can't directly observe the truncation, but we CAN observe that
    // a match past MAX_HAYSTACK_SCAN is unreachable.
    const haystack = "a".repeat(_CONSTANTS.MAX_HAYSTACK_SCAN) + "Z"
    const r = fzfScore("Z", haystack)
    expect(r).toBeNull() // Z lives at position MAX_HAYSTACK_SCAN, past the scan cap
  })

  test("a match WITHIN MAX_HAYSTACK_SCAN is still found", () => {
    const haystack = "a".repeat(_CONSTANTS.MAX_HAYSTACK_SCAN - 1) + "Z"
    const r = fzfScore("Z", haystack)
    expect(r).not.toBeNull()
  })
})

// ─── separators ─────────────────────────────────────────────────────────
describe("fzfScore — separator recognition", () => {
  test("space is a boundary", () => {
    const after = fzfScore("c", "do command")!
    const mid = fzfScore("c", "decoction")!
    expect(after.score).toBeGreaterThan(mid.score)
  })

  test("backslash (windows path) treated as separator", () => {
    const after = fzfScore("c", "src\\components")!
    const mid = fzfScore("c", "src ddcccmpts")!
    expect(after.score).toBeGreaterThan(mid.score)
  })

  test("dot is a boundary (file extensions, namespaces)", () => {
    const after = fzfScore("t", "file.ts")!
    const mid = fzfScore("t", "filets")!
    expect(after.score).toBeGreaterThan(mid.score)
  })
})

// ─── numerics / unicode ─────────────────────────────────────────────────
describe("fzfScore — characters outside [a-z]", () => {
  test("digits match digits", () => {
    expect(fzfScore("123", "abc123")).not.toBeNull()
  })

  test("digits respect smartcase semantics by passing through unchanged", () => {
    // Digits have no upper/lower form — they always match themselves.
    const r = fzfScore("file7", "file7-tab")!
    expect(r).not.toBeNull()
    expect(r.positions).toEqual([0, 1, 2, 3, 4])
  })

  test("unicode chars don't crash (just non-matching)", () => {
    // The scorer's char predicates are ASCII-only — a non-ASCII needle
    // char simply won't match anything. The contract is "doesn't
    // throw"; producing useful unicode matching is out of scope for
    // this fix.
    expect(() => fzfScore("é", "édit")).not.toThrow()
  })
})
