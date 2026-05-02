// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure log-line parsing utilities shared by Monitor's `LogsPanel` and the
 * IDE Output tab. These functions are framework-free so they can be unit
 * tested without a DOM.
 *
 * Parser contract (best-effort, never throws):
 *   1. Strip ANSI color escapes.
 *   2. Peel off a leading timestamp (ISO bracketed, 12h, or 24h).
 *   3. Peel off a leading bundler tag (`[vite]`, `[expo]`, `[metro]`).
 *   4. Classify as `error`/`warn`/`info` from word-boundary `\bERROR\b`,
 *      `\bERR\b`, `\bWARN\b` patterns.
 *
 * The level heuristic is intentionally conservative: prefer false negatives
 * (info) over false positives so that the unseen-error red dot in the
 * BottomPanel stays meaningful.
 */

export type LogLevel = 'info' | 'warn' | 'error'
export type LogSource = 'agent' | 'vite' | 'system'

export interface ParsedLogEntry {
  id: number
  ts: string | null
  level: LogLevel
  source: LogSource
  message: string
  raw: string
}

// Greedily-cropped escape sequence (CSI / ESC) — no fancy state machine,
// just the regex used by the existing LogsPanel.
const ANSI_RE = /[\x1B\x9B]\[[0-9;]*[A-Za-z]/g

const ISO_TS_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)]\s*/
const TIME12_RE = /^(\d{1,2}:\d{2}:\d{2}\s*[AP]M)\s+/i
const TIME24_RE = /^(\d{1,2}:\d{2}:\d{2})\s+/
const BUNDLER_PREFIX_RE = /^\[(vite|expo|metro)]\s*/i

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '')
}

let _nextId = 0

/**
 * Reset the monotonically increasing parser id counter. Tests use this to
 * keep id values deterministic across cases; the production `LogsPanel`
 * calls it from its `Clear` handler.
 */
export function resetParserIdsForTest(): void {
  _nextId = 0
}

export function parseLogLine(raw: string): ParsedLogEntry {
  const id = _nextId++
  let message = stripAnsi(raw).trimStart()
  let ts: string | null = null
  let level: LogLevel = 'info'
  let source: LogSource = 'system'

  const isoMatch = message.match(ISO_TS_RE)
  if (isoMatch) {
    ts = isoMatch[1] ?? null
    message = message.slice(isoMatch[0].length)
    source = 'agent'
  } else {
    const t12Match = message.match(TIME12_RE)
    if (t12Match) {
      ts = t12Match[1] ?? null
      message = message.slice(t12Match[0].length)
      source = 'agent'
    } else {
      const t24Match = message.match(TIME24_RE)
      if (t24Match) {
        ts = t24Match[1] ?? null
        message = message.slice(t24Match[0].length)
        source = 'agent'
      }
    }
  }

  const bundlerMatch = message.match(BUNDLER_PREFIX_RE)
  if (bundlerMatch) {
    source = 'vite'
    message = message.slice(bundlerMatch[0].length)
  }

  if (/\bERROR\b/.test(message) || /\bERR\b/.test(message)) {
    level = 'error'
  } else if (/\bWARN\b/.test(message)) {
    level = 'warn'
  }

  return { id, ts, level, source, message: message.trim(), raw }
}

/**
 * Render a parsed timestamp to a localized 12-hour clock string.
 *
 * The parser yields three flavors of `ts`:
 *   - `null`        → empty string
 *   - 12-hour string (already formatted) → returned unchanged
 *   - 24-hour HH:MM:SS → converted to 12h with AM/PM suffix
 *   - Anything else (likely ISO) → `Date#toLocaleTimeString`
 */
export function formatTime(ts: string | null): string {
  if (!ts) return ''
  if (/^\d{1,2}:\d{2}:\d{2}\s*[AP]M$/i.test(ts)) return ts
  const h24Match = ts.match(/^(\d{1,2}):(\d{2}):(\d{2})$/)
  if (h24Match) {
    let h = Number.parseInt(h24Match[1]!, 10)
    const suffix = h >= 12 ? 'PM' : 'AM'
    if (h === 0) h = 12
    else if (h > 12) h -= 12
    return `${h}:${h24Match[2]}:${h24Match[3]} ${suffix}`
  }
  try {
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ts
    return d.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return ts
  }
}

export type LevelFilter = 'all' | LogLevel
export const LEVEL_FILTERS: ReadonlyArray<LevelFilter> = ['all', 'error', 'warn', 'info']

export const LEVEL_COLORS: Record<LogLevel, { badge: string; text: string }> = {
  error: { badge: 'bg-red-900/60', text: 'text-red-400' },
  warn: { badge: 'bg-amber-900/50', text: 'text-amber-400' },
  info: { badge: '', text: 'text-zinc-400' },
}
