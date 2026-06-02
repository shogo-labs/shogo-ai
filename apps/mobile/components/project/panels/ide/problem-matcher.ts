// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-TASKS — problem matchers.
 *
 * The other half of the VS Code task runner: a problem matcher turns a
 * task's raw stdout/stderr into structured diagnostics (file, line,
 * column, severity, message, code) that surface in the Problems panel.
 * This module is the pure, side-effect-free matcher engine, a sibling of
 * `tasks-config.ts`: no React, no fs, no process. Feed it the output lines
 * and a matcher (a built-in like `$tsc` / `$eslint-stylish` / `$gcc`, or a
 * custom one) and it returns diagnostics.
 *
 * Supports both single-line matchers (each line matched independently) and
 * multi-line matchers with a trailing `loop` pattern — the shape used by
 * eslint's stylish formatter, where one file-header line is followed by
 * many indented message lines.
 *
 * Deliberately NOT here: React, fs, process, the Problems UI.
 */

export type DiagnosticSeverity = "error" | "warning" | "info"

export interface ProblemPattern {
  regexp: RegExp
  /** 1-based capture-group indices into the match. */
  file?: number
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  severity?: number
  code?: number
  message?: number
  /** Only valid on the LAST pattern: repeat it for consecutive matching lines. */
  loop?: boolean
}

export type FileLocation = "absolute" | "relative" | ["relative", string]

export interface ProblemMatcher {
  name: string
  owner?: string
  source?: string
  /** Default severity when a pattern doesn't capture one. */
  severity?: DiagnosticSeverity
  fileLocation?: FileLocation
  pattern: ProblemPattern | ProblemPattern[]
}

export interface MatchedDiagnostic {
  file: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  severity: DiagnosticSeverity
  message: string
  code?: string
  source?: string
}

/** Map a raw severity token to a canonical severity. */
export function normalizeSeverity(raw: unknown, fallback: DiagnosticSeverity = "error"): DiagnosticSeverity {
  if (typeof raw !== "string") return fallback
  const s = raw.trim().toLowerCase()
  if (s === "error" || s === "err" || s === "e" || s === "fatal") return "error"
  if (s === "warning" || s === "warn" || s === "w") return "warning"
  if (s === "info" || s === "information" || s === "note" || s === "hint" || s === "i") return "info"
  return fallback
}

function toInt(v: string | undefined, fallback = 1): number {
  if (v == null) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

function cap(match: RegExpMatchArray, idx: number | undefined): string | undefined {
  if (idx == null) return undefined
  return match[idx]
}

/** Build a diagnostic from a (possibly multi-pattern) accumulated capture set. */
function buildDiagnostic(
  matcher: ProblemMatcher,
  acc: {
    file?: string
    line?: string
    column?: string
    endLine?: string
    endColumn?: string
    severity?: string
    code?: string
    message?: string
  },
): MatchedDiagnostic | null {
  if (acc.file == null || acc.message == null) return null
  const diag: MatchedDiagnostic = {
    file: acc.file,
    line: toInt(acc.line),
    column: toInt(acc.column),
    severity: normalizeSeverity(acc.severity, matcher.severity ?? "error"),
    message: acc.message,
  }
  if (acc.endLine != null) diag.endLine = toInt(acc.endLine)
  if (acc.endColumn != null) diag.endColumn = toInt(acc.endColumn)
  if (acc.code != null && acc.code !== "") diag.code = acc.code
  if (matcher.source) diag.source = matcher.source
  return diag
}

function accumulate(
  acc: Record<string, string | undefined>,
  pattern: ProblemPattern,
  match: RegExpMatchArray,
): void {
  for (const key of ["file", "line", "column", "endLine", "endColumn", "severity", "code", "message"] as const) {
    const idx = pattern[key]
    if (typeof idx === "number") {
      const value = cap(match, idx)
      if (value !== undefined) acc[key] = value
    }
  }
}

/**
 * Apply a problem matcher to output lines and return diagnostics.
 *
 * - Single pattern → each line is matched independently.
 * - Multi-pattern → the patterns match consecutive lines; the captures
 *   accumulate and a diagnostic is emitted when the sequence completes. If
 *   the last pattern has `loop:true`, it repeats: each subsequent matching
 *   line emits another diagnostic reusing the earlier captures (e.g. the
 *   file header), and the loop ends at the first non-matching line.
 */
export function applyMatcher(matcher: ProblemMatcher, lines: readonly string[] | string): MatchedDiagnostic[] {
  if (!matcher || !matcher.pattern) return []
  const list = typeof lines === "string" ? lines.split(/\r?\n/) : Array.isArray(lines) ? lines : []
  const patterns = Array.isArray(matcher.pattern) ? matcher.pattern : [matcher.pattern]
  if (patterns.length === 0) return []
  const out: MatchedDiagnostic[] = []

  // Single-line fast path.
  if (patterns.length === 1 && !patterns[0].loop) {
    const p = patterns[0]
    for (const line of list) {
      const m = line.match(p.regexp)
      if (!m) continue
      const acc: Record<string, string | undefined> = {}
      accumulate(acc, p, m)
      const d = buildDiagnostic(matcher, acc)
      if (d) out.push(d)
    }
    return out
  }

  // Multi-line state machine.
  const lastIsLoop = !!patterns[patterns.length - 1].loop
  let i = 0
  while (i < list.length) {
    const acc: Record<string, string | undefined> = {}
    let matchedPrefix = true
    let consumed = 0
    const prefixCount = lastIsLoop ? patterns.length - 1 : patterns.length

    // Match the non-loop prefix on consecutive lines.
    for (let p = 0; p < prefixCount; p++) {
      const line = list[i + p]
      const m = line != null ? line.match(patterns[p].regexp) : null
      if (!m) { matchedPrefix = false; break }
      accumulate(acc, patterns[p], m)
      consumed++
    }

    if (!matchedPrefix) { i++; continue }

    if (!lastIsLoop) {
      const d = buildDiagnostic(matcher, acc)
      if (d) out.push(d)
      i += consumed
      continue
    }

    // Loop the last pattern over subsequent matching lines.
    const loopPattern = patterns[patterns.length - 1]
    let j = i + consumed
    let looped = 0
    while (j < list.length) {
      const m = list[j].match(loopPattern.regexp)
      if (!m) break
      const loopAcc = { ...acc }
      accumulate(loopAcc, loopPattern, m)
      const d = buildDiagnostic(matcher, loopAcc)
      if (d) out.push(d)
      looped++
      j++
    }
    // Advance past the prefix; if the loop matched nothing, still move on.
    i = looped > 0 ? j : i + consumed
  }

  return out
}

/**
 * Resolve a matched diagnostic's file to an absolute path according to the
 * matcher's `fileLocation`. Pure string join — no fs.
 */
export function resolveFileLocation(
  matcher: ProblemMatcher,
  file: string,
  workspaceFolder = "",
  sep = "/",
): string {
  const loc = matcher.fileLocation ?? "relative"
  if (loc === "absolute") return file
  if (file.startsWith(sep)) return file // already absolute
  const base = Array.isArray(loc) ? loc[1] : workspaceFolder
  if (!base) return file
  return base.replace(new RegExp(`${escapeRe(sep)}+$`), "") + sep + file
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ── built-in matchers ───────────────────────────────────────────────────────

const TSC: ProblemMatcher = {
  name: "$tsc",
  owner: "typescript",
  source: "ts",
  fileLocation: "relative",
  // src/app.ts(12,5): error TS2304: Cannot find name 'foo'.
  pattern: {
    regexp: /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+)\s*:\s*(.+)$/,
    file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6,
  },
}

const GCC: ProblemMatcher = {
  name: "$gcc",
  owner: "cpp",
  source: "gcc",
  fileLocation: "absolute",
  // /path/main.c:10:5: error: 'x' undeclared
  pattern: {
    regexp: /^(.+?):(\d+):(\d+):\s+(error|warning|note|fatal error):\s+(.+)$/,
    file: 1, line: 2, column: 3, severity: 4, message: 5,
  },
}

const ESLINT_COMPACT: ProblemMatcher = {
  name: "$eslint-compact",
  owner: "eslint",
  source: "eslint",
  fileLocation: "absolute",
  // /path/file.js: line 1, col 1, Error - 'x' is not defined. (no-undef)
  pattern: {
    regexp: /^(.+?):\s+line\s+(\d+),\s+col\s+(\d+),\s+(Error|Warning|Info)\s+-\s+(.+?)(?:\s+\((.+)\))?$/,
    file: 1, line: 2, column: 3, severity: 4, message: 5, code: 6,
  },
}

const ESLINT_STYLISH: ProblemMatcher = {
  name: "$eslint-stylish",
  owner: "eslint",
  source: "eslint",
  fileLocation: "absolute",
  pattern: [
    // file header line, e.g. "/path/file.js"
    { regexp: /^([^\s].*)$/, file: 1 },
    // indented message lines, e.g. "  1:5  error  'x' is not defined  no-undef"
    {
      regexp: /^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.+?)(?:\s{2,}(\S+))?\s*$/,
      line: 1, column: 2, severity: 3, message: 4, code: 5, loop: true,
    },
  ],
}

const BUILT_INS: Record<string, ProblemMatcher> = {
  $tsc: TSC,
  $gcc: GCC,
  "$eslint-compact": ESLINT_COMPACT,
  "$eslint-stylish": ESLINT_STYLISH,
}

/** A built-in matcher by ref name (e.g. "$tsc"), or undefined. */
export function getBuiltInMatcher(name: string): ProblemMatcher | undefined {
  return BUILT_INS[name]
}

export function builtInMatcherNames(): string[] {
  return Object.keys(BUILT_INS)
}

/**
 * Resolve an array of matcher refs (from a task's `problemMatchers`) into
 * concrete matchers, consulting `custom` first then the built-ins. Unknown
 * refs are skipped.
 */
export function resolveMatchers(
  refs: readonly string[],
  custom: Record<string, ProblemMatcher> = {},
): ProblemMatcher[] {
  const out: ProblemMatcher[] = []
  for (const ref of refs) {
    const m = custom[ref] ?? getBuiltInMatcher(ref)
    if (m) out.push(m)
  }
  return out
}

/** Run several matchers over the same output and concatenate diagnostics. */
export function applyMatchers(matchers: readonly ProblemMatcher[], lines: readonly string[] | string): MatchedDiagnostic[] {
  const out: MatchedDiagnostic[] = []
  for (const m of matchers) out.push(...applyMatcher(m, lines))
  return out
}
