// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Translate a drag-drop event (or a paste of file paths) into a
 * single shell-safe string the host can feed to `client.sendData()`.
 *
 * Rules:
 *
 *   - One whitespace-separated token per path.
 *   - POSIX single-quote with `'` escaping for any token containing
 *     a shell-meaningful character. Tokens that contain ONLY safe
 *     characters (letters/digits/`._-/+:@`) pass through unquoted to
 *     keep the readable result readable.
 *   - Trailing single space so the user can keep typing args.
 *   - When the drop has zero paths but does have `text/plain`, fall
 *     back to that text — covers dragging from a browser address
 *     bar or selecting text on the host OS.
 *
 * Cross-platform: on Windows the host typically gives us native
 * backslash paths. We DO NOT translate them to POSIX (cmd / pwsh
 * handle them just fine) — translation would also be wrong inside
 * WSL where forward slashes are correct.
 */

// ─── narrow DOM interface ──────────────────────────────────────────

export interface DropFile {
  /** File name only. */
  name: string
  /**
   * Best-effort absolute path. Electron exposes this via the non-
   * standard `webkitGetAsEntry` / `File.path` in renderer. Host code
   * extracts the strings before calling our helpers.
   */
  path: string
}

export interface DropData {
  files?: readonly DropFile[]
  /** Fallback text/plain content from `dataTransfer.getData('text/plain')`. */
  text?: string
}

// ─── quoting ───────────────────────────────────────────────────────

/** POSIX-shell-quote a single token. Idempotent for already-safe tokens. */
export function posixQuote(token: string): string {
  if (token.length === 0) return "''"
  // Allow only the conservative "safe set" through unquoted. Note that
  // `/` is safe in POSIX command tokens; `:` is safe in arguments
  // (uri paths, host:port, etc.). Anything else triggers quoting.
  if (/^[A-Za-z0-9_.\-/:+@%=]+$/.test(token)) return token
  // Single-quote with the standard `'\''` escape sequence.
  return "'" + token.replace(/'/g, "'\\''") + "'"
}

/**
 * Quote multiple paths and join with a single space. No trailing
 * space — `formatDropPaths` adds one when there's any content.
 */
export function quotePaths(paths: readonly string[]): string {
  return paths.map(posixQuote).join(' ')
}

// ─── high-level formatter ──────────────────────────────────────────

export interface FormatDropResult {
  /**
   * The string to inject into the terminal. Always non-empty when
   * the drop carried any paths or text. Includes the trailing space.
   */
  payload: string
  /** Number of paths the result represents. */
  pathCount: number
  /**
   * Why we picked this payload. Useful for telemetry + debugging
   * "why did dropping nothing produce something?" reports.
   */
  source: 'files' | 'text' | 'empty'
}

export function formatDropPaths(drop: DropData): FormatDropResult {
  const files = drop.files ?? []
  if (files.length > 0) {
    const paths = files.map((f) => f.path).filter((p) => p.length > 0)
    if (paths.length > 0) {
      return { payload: quotePaths(paths) + ' ', pathCount: paths.length, source: 'files' }
    }
  }
  const text = (drop.text ?? '').trim()
  if (text.length > 0) {
    // For text drops we don't quote — the user wanted the literal
    // text. But we still append a space.
    return { payload: text + ' ', pathCount: 0, source: 'text' }
  }
  return { payload: '', pathCount: 0, source: 'empty' }
}

/**
 * Extract a `DropData` from a real `DragEvent`. Lives here so the
 * host call-site stays a one-liner. Tests that exercise the formatter
 * use `formatDropPaths` directly and never need a real DataTransfer.
 */
export function dropDataFromEvent(ev: { dataTransfer: DataTransfer | null }): DropData {
  const dt = ev.dataTransfer
  if (!dt) return {}
  const out: DropData = {}
  const files: DropFile[] = []
  // FileList iteration — kept narrow so we don't pull in lib.dom.iterable.
  if (dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files.item(i) as (File & { path?: string }) | null
      if (!f) continue
      const path = (f.path && f.path.length > 0) ? f.path : f.name
      files.push({ name: f.name, path })
    }
  }
  if (files.length > 0) out.files = files
  try {
    const text = dt.getData('text/plain')
    if (text && text.length > 0) out.text = text
  } catch { /* some browsers throw on text-not-allowed drops */ }
  return out
}
