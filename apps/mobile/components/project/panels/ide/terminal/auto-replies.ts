// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Terminal auto-reply engine.
 *
 * Watches the byte stream coming back from the PTY and, when a configured
 * rule matches the recent output, sends a canned response to stdin. Used
 * for prompts like `[y/N]`, "Are you sure?", or "Press any key to continue".
 *
 * Design constraints:
 *   1. **Pure / deterministic.** The matcher is a pure function so it can be
 *      unit-tested without spinning up a PTY. Callers thread state in/out.
 *   2. **Robust to stream chunking.** A `[y/N]` prompt may arrive split
 *      across two data events. The engine maintains a sliding window of
 *      the last `WINDOW_BYTES` bytes per session so a match isn't lost.
 *   3. **Cooldown + hard rate limit.** Per-rule cooldown prevents the same
 *      rule re-firing on its own echo within `cooldownMs`. A hard rate
 *      limit (max `MAX_FIRES_PER_WINDOW` fires per `RATE_WINDOW_MS`) gives
 *      a second safety net.
 *   4. **Concurrent matches dedupe by send.text** — two rules matching the
 *      same chunk with the same canned response only fire once per tick.
 *   5. **Bad regex is the form layer's problem.** `compileMatcher` throws a
 *      typed `AutoReplyCompileError` so the settings UI can refuse to save.
 *
 * The runtime piece (subscribe to xterm data, call `evaluateAutoReplies`,
 * send via PtyClient) lives in Terminal.tsx — this module is engine-only.
 */

export interface AutoReplyMatch {
  readonly kind: 'substring' | 'regex'
  readonly pattern: string
  readonly flags?: string
}

export interface AutoReplySend {
  readonly text: string
  readonly appendNewline: boolean
}

export interface AutoReplyRule {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
  readonly match: AutoReplyMatch
  readonly send: AutoReplySend
  /** Minimum gap between consecutive fires for THIS rule. Default 5_000 ms. */
  readonly cooldownMs?: number
}

export interface AutoReplyState {
  /** Per-rule timestamp of the most recent fire. */
  readonly lastFiredAt: Readonly<Record<string, number>>
  /** Per-rule timestamps within the current rate window. */
  readonly recentFires: Readonly<Record<string, ReadonlyArray<number>>>
  /** Sliding output window — last N bytes of the session's stdout. */
  readonly window: string
}

export interface AutoReplyFire {
  readonly ruleId: string
  readonly send: AutoReplySend
}

export interface AutoReplyResult {
  readonly fires: ReadonlyArray<AutoReplyFire>
  readonly nextState: AutoReplyState
}

export const WINDOW_BYTES = 2048
export const DEFAULT_COOLDOWN_MS = 5_000
export const MAX_FIRES_PER_WINDOW = 5
export const RATE_WINDOW_MS = 30_000

export function emptyAutoReplyState(): AutoReplyState {
  return { lastFiredAt: {}, recentFires: {}, window: '' }
}

/**
 * Compile a rule's matcher into a one-shot predicate. Used by the settings
 * UI to validate user input at save time. Throws `AutoReplyCompileError`
 * with a human-readable reason — the form should surface this verbatim.
 */
export class AutoReplyCompileError extends Error {
  readonly ruleId: string
  constructor(ruleId: string, message: string) {
    super(message)
    this.name = 'AutoReplyCompileError'
    this.ruleId = ruleId
  }
}

export function compileMatcher(rule: AutoReplyRule): (haystack: string) => boolean {
  if (rule.match.kind === 'substring') {
    if (rule.match.pattern.length === 0) {
      throw new AutoReplyCompileError(rule.id, 'Substring pattern cannot be empty')
    }
    const needle = rule.match.pattern
    return (h) => h.includes(needle)
  }
  // regex
  let re: RegExp
  try {
    re = new RegExp(rule.match.pattern, rule.match.flags ?? '')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new AutoReplyCompileError(rule.id, `Invalid regex: ${msg}`)
  }
  return (h) => re.test(h)
}

/**
 * Pure evaluation step. Append the new `chunk` to the sliding window, then
 * for each enabled rule test the window — fire if matched, throttled by
 * cooldown and rate-limit. Returns deduped fires and the next state.
 *
 * The caller is responsible for actually writing `fires[*].send` bytes to
 * the PTY stdin; this function never has side effects.
 */
export function evaluateAutoReplies(
  rules: ReadonlyArray<AutoReplyRule>,
  state: AutoReplyState,
  chunk: string,
  now: number,
): AutoReplyResult {
  const windowCombined = state.window + chunk
  const window = windowCombined.length > WINDOW_BYTES
    ? windowCombined.slice(windowCombined.length - WINDOW_BYTES)
    : windowCombined

  const fires: AutoReplyFire[] = []
  const lastFiredAt: Record<string, number> = { ...state.lastFiredAt }
  const recentFires: Record<string, number[]> = {}
  for (const k of Object.keys(state.recentFires)) {
    recentFires[k] = state.recentFires[k].filter((t) => now - t < RATE_WINDOW_MS)
  }
  const seenSendTexts = new Set<string>()

  for (const rule of rules) {
    if (!rule.enabled) continue
    const cooldown = rule.cooldownMs ?? DEFAULT_COOLDOWN_MS
    const last = lastFiredAt[rule.id] ?? 0
    if (now - last < cooldown) continue
    const recent = recentFires[rule.id] ?? []
    if (recent.length >= MAX_FIRES_PER_WINDOW) continue
    let matcher: (h: string) => boolean
    try {
      matcher = compileMatcher(rule)
    } catch {
      // Bad rule — ignore at runtime; the form should have caught it at save time.
      continue
    }
    if (!matcher(window)) continue
    if (seenSendTexts.has(rule.send.text)) continue
    seenSendTexts.add(rule.send.text)
    fires.push({ ruleId: rule.id, send: rule.send })
    lastFiredAt[rule.id] = now
    recentFires[rule.id] = [...recent, now]
  }

  return {
    fires,
    nextState: { lastFiredAt, recentFires, window },
  }
}

/**
 * Render the canned response to bytes: append `\r` (carriage return) when
 * `appendNewline` is set, which is the Unix terminal convention shells
 * expect for "the user pressed Enter".
 */
export function renderReply(send: AutoReplySend): string {
  return send.appendNewline ? `${send.text}\r` : send.text
}

/** A small curated list of built-in rules, all disabled by default. */
export function defaultRuleTemplates(): AutoReplyRule[] {
  return [
    {
      id: 'tpl-yn',
      label: 'Confirm "y/N" prompts with "y"',
      enabled: false,
      match: { kind: 'regex', pattern: '\\[(y/N|Y/n|y/n|Y/N)\\]\\s*$', flags: '' },
      send: { text: 'y', appendNewline: true },
    },
    {
      id: 'tpl-ssh-fingerprint',
      label: 'Accept SSH host fingerprint',
      enabled: false,
      match: { kind: 'substring', pattern: 'Are you sure you want to continue connecting' },
      send: { text: 'yes', appendNewline: true },
    },
    {
      id: 'tpl-anykey',
      label: 'Press any key to continue → press Enter',
      enabled: false,
      match: { kind: 'substring', pattern: 'Press any key to continue' },
      send: { text: '', appendNewline: true },
    },
  ]
}

/** Storage key for persisted user rules. */
export const AUTO_REPLY_STORAGE_KEY = 'shogo:terminal:auto-replies:v1'

/**
 * Validate a rule for storage. Returns null if OK, a human-readable error
 * string otherwise. The settings UI uses this to refuse invalid saves.
 */
export function validateRule(rule: AutoReplyRule): string | null {
  if (!rule.id || rule.id.length === 0) return 'Rule id is required'
  if (!rule.label || rule.label.length === 0) return 'Rule label is required'
  if (!rule.match.pattern || rule.match.pattern.length === 0) {
    return 'Match pattern cannot be empty'
  }
  try {
    compileMatcher(rule)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return null
}
