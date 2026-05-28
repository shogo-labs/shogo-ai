// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CWD-aware link provider.
 *
 * Scans rendered terminal lines for tokens that look like file paths
 * and, when the path is **relative**, resolves it against the working
 * directory that was in effect for that row at runtime — derived from
 * the Phase-3 tracker's `P;Cwd=…` history.
 *
 * Token matching, in order of precedence:
 *
 *   1. `path:line[:col]` — common compiler/linter format
 *      (e.g. `src/foo.ts:42:7`, `./README.md:10`). Captures line and
 *      optional column.
 *
 *   2. Bare path-ish tokens — anything containing `/` (POSIX) or `\`
 *      (Windows) plus a file-name segment, OR a single segment with a
 *      file extension (`package.json`, `README.md`). We avoid matching
 *      raw words to keep noise down; CLI output is dense.
 *
 * The provider deliberately does **not** stat() the path here. Whether
 * the file exists is the host's call — the link payload includes the
 * resolved absolute path and the host's `activate()` hook decides
 * whether to open it, show "file not found", etc.
 *
 * Like every other Phase 4/5 module, this one accepts xterm.js
 * through a narrow interface (`LinkHostLike`) and is fully tested
 * with deterministic fakes.
 */

// ─── tracker / xterm interfaces ─────────────────────────────────────

/**
 * Subset of Phase-3's tracker we need. The provider needs the cwd in
 * effect at a particular row; we derive that by walking the tracker's
 * Command list backwards from the row.
 */
export interface CommandWithCwd {
  /** Command id (1-based, monotonic). */
  id: number
  /** Working directory that was in effect when the command ran. */
  cwd: string | null
  /**
   * Best-effort marker pointing at where this command began rendering
   * (xterm row number). When null we fall back to the previous
   * command's range.
   */
  startLine: number | null
}

export interface TrackerCwdLookup {
  /** All known commands, in start order. */
  listCommands(): readonly CommandWithCwd[]
  /** Current shell cwd, or null if unknown. */
  currentCwd(): string | null
}

// ─── link match ─────────────────────────────────────────────────────

export interface LinkMatch {
  /** Original raw token as it appeared in the row. */
  text: string
  /** Resolved absolute path (or the original if already absolute). */
  resolvedPath: string
  /** 1-based line within the file, if captured. */
  fileLine?: number
  /** 1-based column within the file, if captured. */
  fileColumn?: number
  /** Inclusive 0-based start column of the match in the row. */
  start: number
  /** Exclusive 0-based end column of the match. */
  end: number
}

// ─── path helpers (POSIX + Windows aware, no node:path dep) ────────

/** True if the token looks absolute on either POSIX or Windows. */
export function isAbsolutePath(p: string): boolean {
  if (p.length === 0) return false
  if (p[0] === '/') return true
  if (p[0] === '~') return true
  // Windows: C:\foo or //server/share or \\server\share
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (p.startsWith('\\\\') || p.startsWith('//')) return true
  return false
}

/**
 * Join `cwd` and a relative path. Pure string join — does not stat.
 * Normalises `./` and `../` segments without touching the filesystem.
 * Mixes platforms by preferring the cwd's separator.
 */
export function joinPath(cwd: string, rel: string): string {
  const usesBackslash = /\\/.test(cwd) && !/\//.test(cwd)
  const sep = usesBackslash ? '\\' : '/'
  const cwdParts = cwd.split(/[\\/]/).filter((p, i) => p !== '' || i === 0)
  const relParts = rel.split(/[\\/]/)
  const out: string[] = [...cwdParts]
  for (const seg of relParts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(seg)
  }
  // Preserve a leading separator for POSIX cwd.
  if (!usesBackslash && cwd.startsWith('/') && out[0] !== '') out.unshift('')
  return out.join(sep).replace(/[\\/]+/g, sep) || sep
}

// ─── token scanner ──────────────────────────────────────────────────

/**
 * Token regex: captures `path[:line[:col]]`. We make the line/col
 * tail non-mandatory so a bare `src/foo.ts` matches too.
 *
 * Notes on the path body:
 *   - Allowed chars: letters, digits, `_`, `-`, `.`, `~`, `/`, `\`, `:`
 *     (the `:` is only the drive letter on Windows; we exclude
 *     trailing-`:`s below).
 *   - We disallow leading whitespace via `\b`-style anchoring done by
 *     splitting the row on whitespace before regex-testing.
 */
const PATH_BODY = /^([~A-Za-z]:?[\\/][\w.\-~/\\]*|\.{0,2}\/[\w.\-~/\\]*|\\\\[\w.\-~/\\]+|[\w.\-~]+\.[\w.\-]+)(:(\d+)(?::(\d+))?)?$/

/**
 * Trim shell punctuation that frequently glues onto the end of a path
 * in CLI output: `, ; . ) ] } ' " :` (the `:` only when not preceded
 * by digits — that's a line:col marker, not a sentence terminator).
 */
function trimPunct(token: string): { text: string; trimmed: number } {
  let end = token.length
  while (end > 0) {
    const c = token[end - 1]!
    if (',;).]}\'"`'.includes(c)) { end--; continue }
    // Allow `:` only if followed by digits (line/col) — those are
    // already captured by PATH_BODY. A trailing `:` in `error in foo.ts:`
    // is noise.
    if (c === ':') { end--; continue }
    if (c === '.' && end > 1 && !/[A-Za-z0-9]/.test(token[end - 2]!)) { end--; continue }
    break
  }
  return { text: token.slice(0, end), trimmed: token.length - end }
}

interface RawToken {
  text: string
  start: number
  end: number
}

/** Split a row into whitespace-separated tokens with positions. */
export function tokeniseRow(row: string): RawToken[] {
  const out: RawToken[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(row)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  }
  return out
}

// ─── core: find links in a row ─────────────────────────────────────

export interface FindLinksOptions {
  /** Row text. */
  row: string
  /** 0-based xterm row number, used to look up the CWD context. */
  rowNumber: number
  /** Tracker (provides per-row cwd resolution). */
  tracker: TrackerCwdLookup
}

export function findLinksInRow(opts: FindLinksOptions): LinkMatch[] {
  const cwd = resolveCwdAtRow(opts.tracker, opts.rowNumber)
  const tokens = tokeniseRow(opts.row)
  const matches: LinkMatch[] = []
  for (const tok of tokens) {
    const link = matchToken(tok, cwd)
    if (link) matches.push(link)
  }
  return matches
}

/**
 * Walk the tracker's command list to find the cwd in effect for a
 * given row. The cwd of a command is what's in effect from the
 * command's `startLine` (inclusive) until the next command's
 * `startLine`. Rows above the first command fall back to currentCwd.
 */
export function resolveCwdAtRow(tracker: TrackerCwdLookup, rowNumber: number): string | null {
  const cmds = tracker.listCommands()
  let best: CommandWithCwd | null = null
  for (const c of cmds) {
    if (c.startLine === null) continue
    if (c.startLine <= rowNumber) best = c
    else break
  }
  return best?.cwd ?? tracker.currentCwd()
}

function matchToken(tok: RawToken, cwd: string | null): LinkMatch | null {
  const { text: trimmed, trimmed: shrink } = trimPunct(tok.text)
  if (trimmed.length === 0) return null
  const m = PATH_BODY.exec(trimmed)
  if (!m) return null
  const body = m[1]!
  const lineStr = m[3]
  const colStr = m[4]

  // Resolve path
  let resolved: string
  if (isAbsolutePath(body)) {
    resolved = body
  } else {
    if (!cwd) return null
    resolved = joinPath(cwd, body)
  }

  return {
    text: trimmed,
    resolvedPath: resolved,
    fileLine: lineStr ? parseInt(lineStr, 10) : undefined,
    fileColumn: colStr ? parseInt(colStr, 10) : undefined,
    start: tok.start,
    end: tok.end - shrink,
  }
}

// ─── provider wrapper (host integration) ───────────────────────────

export interface OpenFileTarget {
  /**
   * Activate handler. Host wires this to the editor "open file" IPC.
   * `event` is the original MouseEvent so the host can decide on
   * modifier-based behaviour (⌘-click → split, etc.). The match
   * payload contains the resolved absolute path + optional line/col.
   */
  (event: MouseEvent, match: LinkMatch): void
}

export interface LinkProviderOptions {
  tracker: TrackerCwdLookup
  open: OpenFileTarget
  /**
   * Optional per-link filter — return false to suppress a match.
   * Used by hosts that want to hide links for unsupported file
   * types or paths inside `.git/`.
   */
  filter?(match: LinkMatch): boolean
}

/**
 * Provider with the shape xterm.js's `registerLinkProvider` expects.
 * Hosts pass it through; tests call `provideLinks(row, rowNumber)`
 * directly to assert behaviour.
 */
export class CwdLinkProvider {
  constructor(private readonly opts: LinkProviderOptions) {}

  /** Returns the matches for a single row of terminal text. */
  provideLinks(row: string, rowNumber: number): LinkMatch[] {
    const raw = findLinksInRow({ row, rowNumber, tracker: this.opts.tracker })
    const filter = this.opts.filter
    return filter ? raw.filter(filter) : raw
  }

  /** Fire the host activate handler for a previously-emitted match. */
  activate(event: MouseEvent, match: LinkMatch): void {
    this.opts.open(event, match)
  }
}
