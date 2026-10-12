// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repair mistyped `share_file` download links in assistant text (pure,
 * unit-testable).
 *
 * `share_file` returns a signed capability URL (`.../api/f/<payload>.<sig>`)
 * whose token is several hundred characters of base64url. The model is told
 * to paste it verbatim but still occasionally flips a character while
 * re-typing it, which breaks the HMAC and the user gets a 404. We know every
 * URL the tool minted, so any `/f/<token>` in the text that is not an exact
 * minted token but is within a small edit distance of one is replaced with
 * the minted token.
 *
 * Distinct minted tokens differ in their payload (`iat`, path) and in a
 * 43-char HMAC, so they are far apart; the distance bound only has to absorb
 * a few typos and is kept well below that gap. A tie between two minted
 * tokens leaves the text unchanged rather than guessing.
 */

const SHARE_TOKEN_RE = /\/f\/([A-Za-z0-9._%-]+)/g

/** Max edits tolerated, as a fraction of the minted token's length. */
const MAX_EDIT_RATIO = 0.05
const MIN_EDIT_BUDGET = 2

/** Extract the `/f/<token>` token from each minted share URL. */
export function extractShareLinkTokens(urls: Iterable<string>): Set<string> {
  const tokens = new Set<string>()
  for (const url of urls) {
    for (const m of url.matchAll(SHARE_TOKEN_RE)) tokens.add(m[1])
  }
  return tokens
}

/**
 * Levenshtein distance between `a` and `b`, or `Infinity` once it is certain
 * to exceed `max` (keeps a mismatch against a long token cheap).
 */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return Infinity
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return Infinity
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length] <= max ? prev[b.length] : Infinity
}

function closestToken(candidate: string, minted: ReadonlySet<string>): string | null {
  let best: string | null = null
  let bestDistance = Infinity
  let tied = false
  for (const token of minted) {
    const budget = Math.max(MIN_EDIT_BUDGET, Math.floor(token.length * MAX_EDIT_RATIO))
    const distance = boundedEditDistance(candidate, token, budget)
    if (distance < bestDistance) {
      best = token
      bestDistance = distance
      tied = false
    } else if (distance === bestDistance && distance !== Infinity) {
      tied = true
    }
  }
  return best && !tied ? best : null
}

/**
 * Replace each near-miss `/f/<token>` in `text` with the minted token it was
 * meant to be. Exact matches and tokens not close to any minted one are left
 * alone. No-op when nothing has been minted.
 */
export function repairShareLinks(text: string, mintedTokens: ReadonlySet<string>): string {
  if (!text || mintedTokens.size === 0 || !text.includes('/f/')) return text
  return text.replace(SHARE_TOKEN_RE, (match, raw: string) => {
    // Minted tokens never end in `.`, so a trailing one is sentence punctuation.
    const trailing = raw.match(/\.+$/)?.[0] ?? ''
    const token = raw.slice(0, raw.length - trailing.length)
    if (!token || mintedTokens.has(token)) return match
    const fixed = closestToken(token, mintedTokens)
    return fixed ? `/f/${fixed}${trailing}` : match
  })
}
