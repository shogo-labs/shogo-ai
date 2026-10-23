// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repair mistyped `share_file` download links in assistant text (pure,
 * unit-testable).
 *
 * A `/f/<payload>.<sig>` capability URL carries several hundred characters of
 * base64url. The model is told to paste it verbatim but still occasionally
 * flips a character while re-typing it, which breaks the HMAC and the user
 * gets a 404. We know every URL a tool result brought into the session, so any
 * `/f/<token>` in the text that is not an exact minted token is replaced with
 * the minted token it was meant to be.
 *
 * Two kinds of slip are repaired, in this order:
 *
 * 1. **Same signature.** If the JSON payload is re-encoded — one inserted or
 *    deleted character (`"workspaceId"` → `"wworkspaceId"`) shifts base64
 *    alignment, so *every* character after it differs while the signature is
 *    copied exactly — the signature still identifies the token. Since a tie
 *    between two minted tokens is not a guess we make, the text is left alone.
 * 2. **Near miss.** Otherwise a token within a small edit distance of a minted
 *    one is repaired; that absorbs a few typos, including inside the
 *    signature. Distinct minted tokens differ in payload (`iat`, path) and in
 *    a 43-char HMAC, so they are far apart and the bound stays well below that
 *    gap. A tie between two minted tokens leaves the text unchanged.
 */

const SHARE_TOKEN_RE = /\/f\/([A-Za-z0-9._%-]+)/g

/** Max edits tolerated, as a fraction of the minted token's length. */
const MAX_EDIT_RATIO = 0.05
const MIN_EDIT_BUDGET = 2

/**
 * Extract the `/f/<token>` token from each string that may carry a share URL
 * (a whole share URL, a JSON tool result, a relayed reply).
 */
export function extractShareLinkTokens(texts: Iterable<string>): Set<string> {
  const tokens = new Set<string>()
  for (const text of texts) {
    if (!text || !text.includes('/f/')) continue
    for (const m of text.matchAll(SHARE_TOKEN_RE)) tokens.add(m[1])
  }
  return tokens
}

/** The signature part of `<payload>.<signature>`, or null when there is none. */
function signatureOf(token: string): string | null {
  const dot = token.lastIndexOf('.')
  return dot > 0 && dot < token.length - 1 ? token.slice(dot + 1) : null
}

/** A token with a `%2E`-encoded separator decoded, so encoding cannot hide the signature. */
function decodeSeparator(token: string): string {
  return token.replace(/%2[eE]/g, '.')
}

/**
 * The minted token whose signature `candidate` carries verbatim, or null when
 * none or more than one does (a tie is never resolved by guessing).
 */
function matchBySignature(candidate: string, minted: ReadonlySet<string>): string | null {
  const signature = signatureOf(decodeSeparator(candidate))
  if (!signature) return null
  let match: string | null = null
  for (const token of minted) {
    if (signatureOf(token) !== signature) continue
    if (match !== null) return null
    match = token
  }
  return match
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
  const bySignature = matchBySignature(candidate, minted)
  if (bySignature) return bySignature

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
 * Replace each mistyped `/f/<token>` in `text` with the minted token it was
 * meant to be — by signature first, then by edit distance. Exact matches and
 * tokens that match no minted one are left alone. No-op when nothing has been
 * minted.
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
