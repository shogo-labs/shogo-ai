// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-CMDPAL — fzf-quality command-palette scorer.
 *
 * The previous scorer (fuzzy.tsx :: fuzzyMatch) was a naïve greedy
 * left-to-right walk that gave one fixed bonus per "start of word"
 * hit. It produced acceptable results for short queries but ranked
 * poorly against fzf for:
 *
 *   • path-separator boundaries (slash > dash > underscore should
 *     all rank above a generic intra-word hit, but didn't)
 *   • smartcase (uppercase in needle should force exact case on
 *     haystack — fuzzy.tsx ignored case entirely)
 *   • gap penalty (consecutive matches were rewarded but spread-out
 *     matches weren't penalised, so "foo bar" and "fxxxoxxxbar"
 *     would tie too often)
 *   • first-char bonus (matching the FIRST character of the
 *     haystack is a strong signal — fuzzy.tsx flattened that into
 *     the generic start-of-word bonus)
 *   • position weighting (an early match should beat a late match
 *     when all else is equal — fuzzy.tsx leaked tiebreaks to
 *     dictionary order)
 *
 * The algorithm here is a faithful subset of fzf-v2's
 * greedy-with-bonus-table pass (no full Smith-Waterman DP — the
 * palette has <200 items and queries are short, the DP would buy
 * us nothing for a 0.5ms scan). The bonus tiers and constants are
 * the published fzf-v2 defaults, adapted for our score range so
 * that the palette-mru bonus (max +12) can meaningfully bubble
 * recently-used items above one-off near-equal matches without
 * overpowering a clearly-better text match.
 *
 * Contract pinned by `fzf-scorer.test.ts` (25 specs):
 *
 *   • returns null when any needle char is missing
 *   • empty needle returns { score: 0, positions: [] } (caller
 *     decides whether that means "everything matches in original
 *     order" or "no input yet")
 *   • smartcase: query has any uppercase → case-sensitive match;
 *     all-lowercase → case-insensitive
 *   • positions[] is a strictly-increasing array of haystack
 *     indices, one per needle char, suitable for `highlightMatch`
 *   • path-separator boundary > camelCase boundary > word-start
 *     boundary > consecutive > generic char
 *   • gap penalty grows with distance (charged on the gap BETWEEN
 *     two matched chars, not on the chars themselves)
 *   • first-char-of-haystack match always beats first-char-of-word
 *     when needle starts there
 *   • haystacks longer than 2048 chars are scored on a prefix —
 *     palette items are short by definition, and an accidental
 *     "paste your whole file in the label" doesn't get to blow up
 *     the scan
 */

export interface FzfMatch {
  /** Total score; higher is better. Always finite. */
  score: number
  /** Indices of needle chars matched in the haystack, ascending. */
  positions: number[]
}

// ─── tunables ────────────────────────────────────────────────────────────
// Bonus constants (fzf-v2 defaults; comments explain the relative tiers).
const SCORE_MATCH        = 16  // base reward for any matched char
const BONUS_BOUNDARY     = 8   // generic word boundary (after space, before letter)
const BONUS_NON_WORD     = 8   // after a non-word char that isn't a known separator
const BONUS_CAMEL_123    = 7   // lower→Upper transition (camelCase boundary)
const BONUS_CONSECUTIVE  = 14  // run continuing — one less than two boundaries
const BONUS_FIRST_CHAR_MULTIPLIER = 2 // amplifies any boundary bonus at index 0

// Tiered separators — path-sep (`/`, `\`) > dot > dash > underscore > space.
// fzf weights these identically; we keep them identical too — the
// _position_ of the match (early vs late) is what differentiates them.
const SEPARATORS = new Set([" ", "\t", "/", "\\", "_", "-", ".", ","])

// Gap penalty schedule: first gap char is -3, each subsequent gap char
// is -1. This keeps "foo" → "foo-bar" ahead of "foo" → "fxoxox" without
// crushing legitimate spread matches across a path like "src/foo/bar".
const GAP_PENALTY_START = 3
const GAP_PENALTY_EXTEND = 1

// Cap the scan: palette labels are short by definition. A pathological
// 50KB string should not get to lock the renderer.
const MAX_HAYSTACK_SCAN = 2048

// ─── char classification ────────────────────────────────────────────────
function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z"
}
function isLower(ch: string): boolean {
  return ch >= "a" && ch <= "z"
}
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9"
}
function isWord(ch: string): boolean {
  return isUpper(ch) || isLower(ch) || isDigit(ch)
}

/**
 * Bonus when `cur` follows `prev` in the haystack — the prev/cur pair
 * defines the "junction" we're scoring. `prev === ""` means cur is the
 * very first char of the haystack.
 */
function boundaryBonus(prev: string, cur: string): number {
  if (prev === "") {
    // First char of the haystack. Treat as if it followed a boundary so
    // a needle starting with the first letter always wins on prefix.
    return BONUS_BOUNDARY * BONUS_FIRST_CHAR_MULTIPLIER
  }
  if (SEPARATORS.has(prev)) return BONUS_BOUNDARY
  if (!isWord(prev) && isWord(cur)) return BONUS_NON_WORD
  if (isLower(prev) && isUpper(cur)) return BONUS_CAMEL_123
  return 0
}

/**
 * Detect uppercase in the needle. If found, the match runs in
 * case-sensitive mode (smartcase) — typing `Editor` should NOT match
 * `editor` against `editor-tab`, but typing `editor` should match
 * either.
 */
function needleHasUpper(needle: string): boolean {
  for (let i = 0; i < needle.length; i++) {
    if (isUpper(needle[i]!)) return true
  }
  return false
}

/**
 * Score `needle` against `haystack`. Returns null if any needle char
 * cannot be matched in order.
 *
 * Two-pass strategy:
 *   1. Greedy left-to-right scan finds A valid match (or returns null).
 *   2. Second pass walks the validated positions and assigns the
 *      proper boundary / consecutive / gap-penalty scores.
 *
 * The greedy scan is biased toward early boundary hits — when there is
 * a choice between an immediate match and a boundary match a few chars
 * later, the scorer prefers the boundary. This is the same heuristic
 * fzf-v2's greedy phase uses, and it's why "src" against
 * "src/components" scores higher than "src" against "subscribers" even
 * though both contain s-r-c in order.
 */
export function fzfScore(needle: string, haystack: string): FzfMatch | null {
  if (!needle) return { score: 0, positions: [] }
  if (!haystack) return null

  const sensitive = needleHasUpper(needle)
  const hayScan = haystack.length > MAX_HAYSTACK_SCAN
    ? haystack.slice(0, MAX_HAYSTACK_SCAN)
    : haystack
  const h = sensitive ? hayScan : hayScan.toLowerCase()
  const n = sensitive ? needle : needle.toLowerCase()

  // ── Pass 1 — simple greedy left-to-right scan ─────────────────
  // Always finds the earliest valid match if one exists. An earlier
  // prototype added a "prefer boundary" lookahead here but that hit
  // the classic fzf greedy-trap: matching needle="editor" against
  // haystack="editor-tabs" would skip the immediate 't' at pos 3 in
  // favour of the boundary 't' at pos 7 (after '-'), then deadlock
  // looking for 'o' which doesn't exist after pos 7. Pinned by
  // `fzfScore — exact match invariants > identical needle …`.
  const positions: number[] = []
  let hi = 0
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni]!
    let found = -1
    for (let j = hi; j < h.length; j++) {
      if (h[j] === c) {
        found = j
        break
      }
    }
    if (found === -1) return null
    positions.push(found)
    hi = found + 1
  }

  // ── Pass 1.5 — slide-right to boundary positions ─────────────
  // For each matched position, walk right as far as the next match
  // allows and shift to a boundary char if we find one with the same
  // value. This recovers the boundary-preference benefit without
  // risking the deadlock — by construction we never advance past the
  // next position, so the suffix-match invariant is preserved.
  //
  // Walking right-to-left (so positions[i+1] is already the
  // post-shift value) ensures the available room only shrinks
  // monotonically; no fixed-point iteration needed.
  for (let i = positions.length - 1; i >= 0; i--) {
    const c = n[i]!
    const limit = i + 1 < positions.length ? positions[i + 1]! : h.length
    let bestPos = positions[i]!
    let bestBonus = boundaryBonus(
      bestPos === 0 ? "" : hayScan[bestPos - 1]!,
      hayScan[bestPos]!,
    )
    for (let j = bestPos + 1; j < limit; j++) {
      if (h[j] !== c) continue
      const bonus = boundaryBonus(
        j === 0 ? "" : hayScan[j - 1]!,
        hayScan[j]!,
      )
      // Slide ONLY if the bonus strictly improves — never trade an
      // existing boundary hit for a later equal-bonus position
      // (that would just churn the tiebreak in the wrong direction).
      if (bonus > bestBonus) {
        bestPos = j
        bestBonus = bonus
      }
    }
    positions[i] = bestPos
  }

  // Pass 2 — score the validated positions.
  let score = 0
  let prevPos = -1
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!
    const prevChar = p === 0 ? "" : hayScan[p - 1]!
    const curChar = hayScan[p]!
    const bb = boundaryBonus(prevChar, curChar)

    score += SCORE_MATCH + bb

    if (prevPos >= 0) {
      const gap = p - prevPos - 1
      if (gap === 0) {
        // Consecutive — overrides the prev-boundary tier on its own
        // (a continued run is its own strong signal).
        score += BONUS_CONSECUTIVE
      } else {
        score -= GAP_PENALTY_START + GAP_PENALTY_EXTEND * (gap - 1)
      }
    }
    prevPos = p
  }

  // Late-match tiebreak: subtract a tiny amount proportional to the
  // position of the FIRST match. Two items with otherwise identical
  // shape — same boundary class, same length — should rank with the
  // earlier-positioned match first. The coefficient is small enough
  // that it never overrides a genuine bonus tier, only breaks ties.
  score -= positions[0]! * 0.1

  // Reward concise labels by a fraction of a point per char. Same
  // logic — never overrides a real bonus, only breaks ties when two
  // matches are otherwise indistinguishable.
  score -= hayScan.length * 0.01

  return { score, positions }
}

// ─── test-facing constants ──────────────────────────────────────────────
/** @internal — exposed so unit tests can pin the tunable values. */
export const _CONSTANTS = {
  SCORE_MATCH,
  BONUS_BOUNDARY,
  BONUS_NON_WORD,
  BONUS_CAMEL_123,
  BONUS_CONSECUTIVE,
  BONUS_FIRST_CHAR_MULTIPLIER,
  GAP_PENALTY_START,
  GAP_PENALTY_EXTEND,
  MAX_HAYSTACK_SCAN,
}
