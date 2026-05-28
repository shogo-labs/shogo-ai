// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hardcoded-port lint pass for read_lints.
 *
 * The canvas-mode runtime has two ports that are *always* overridden at launch
 * (by the knative scheduler or the local RuntimeManager) but that the agent
 * keeps hard-coding into generated code:
 *
 *   - Project API port `3001` (sidecar `server.tsx`). The sidecar receives
 *     this as `process.env.API_SERVER_PORT` (and `process.env.PORT`) — see
 *     preview-manager.ts where `out.API_SERVER_PORT = portStr` is set.
 *   - Outer agent-runtime port (default `8080`). Inside the sidecar this is
 *     exposed as `process.env.RUNTIME_PORT` — see preview-manager.ts where
 *     `out.RUNTIME_PORT = parentEnv.PORT ?? '8080'` is set.
 *
 * This module finds those URLs inside string literals and rewrites them to
 * template literals interpolating the right env var. Other ports (e.g. 5432
 * for Postgres) are surfaced as warnings only — we don't presume to know the
 * right env var for them.
 *
 * Auto-fix is conservative: only `.ts/.tsx/.js/.jsx` files are rewritten.
 * `.py` files with a known runtime port get an error instead, because a safe
 * Python rewrite would require touching imports and converting plain string
 * literals to f-strings.
 */

/** The project's sidecar API server port — kept in sync with canvas-v2-prompt.ts. */
export const PROJECT_API_PORT = '3001'

/** Default outer runtime port if `process.env.PORT` is unset. */
export const DEFAULT_RUNTIME_PORT = '8080'

/**
 * String-literal-aware regex. Captures:
 *   1. quote char (', ", or `)
 *   2. scheme (http:// or https://)
 *   3. host (localhost | 127.0.0.1 | 0.0.0.0)
 *   4. port (digits)
 *   5. trailing path / query / hash (anything up to the closing quote)
 * The same quote is required at both ends via the \1 backreference, so we
 * only match well-formed string literals.
 */
export const HARDCODED_LOCALHOST_RE =
  /(['"`])(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)([^'"`\\\n]*)\1/g

/**
 * Maps a hardcoded port string to the env var the runtime injects for it.
 * Resolved lazily so `process.env.PORT` picks up launcher overrides.
 */
export function getRuntimePortEnvMap(): Map<string, string> {
  return new Map([
    [PROJECT_API_PORT, 'API_SERVER_PORT'],
    [String(process.env.PORT || DEFAULT_RUNTIME_PORT), 'RUNTIME_PORT'],
  ])
}

export interface PortFix {
  line: number
  before: string
  after: string
  envVar: string
}

export interface PortWarning {
  line: number
  match: string
  reason: string
}

export interface PortError {
  line: number
  match: string
  reason: string
}

export interface PortScanResult {
  fixes: PortFix[]
  warnings: PortWarning[]
  errors: PortError[]
  /** Present iff at least one fix was applied; the rewritten file contents. */
  newContent?: string
}

const TS_LIKE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i
const PY_EXT_RE = /\.py$/i

/**
 * Convert a 1-based line lookup from a string offset.
 */
function lineOfOffset(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0a) line++
  }
  return line
}

/**
 * Build the replacement template-literal for a TS/JS string match.
 * The output is always a backtick string so it can hold the `${...}`
 * interpolation regardless of the original quote style.
 */
function buildTsReplacement(
  scheme: string,
  host: string,
  tail: string,
  envVar: string,
): string {
  // Normalize the host back to `localhost` — it reads more naturally and the
  // semantics are identical (`127.0.0.1` / `0.0.0.0` resolve the same way for
  // the runtime sidecar in practice).
  void host
  return `\`${scheme}localhost:\${process.env.${envVar}}${tail}\``
}

/**
 * Scan a file for hardcoded `localhost:<port>` URLs inside string literals,
 * classify each match, and (for TS/JS files with known runtime ports) emit a
 * rewritten file body.
 */
export function scanAndFixFile(
  relPath: string,
  content: string,
  envMap: Map<string, string> = getRuntimePortEnvMap(),
): PortScanResult {
  const fixes: PortFix[] = []
  const warnings: PortWarning[] = []
  const errors: PortError[] = []

  const isTsLike = TS_LIKE_EXT_RE.test(relPath)
  const isPy = PY_EXT_RE.test(relPath)

  // Build the new content via piecewise replacement so we can mix
  // rewrite-some-matches-and-leave-others behavior in the same pass.
  let out = ''
  let cursor = 0
  let rewrote = false

  HARDCODED_LOCALHOST_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HARDCODED_LOCALHOST_RE.exec(content)) !== null) {
    const [whole, , scheme, host, port, tail] = m
    const matchStart = m.index
    const line = lineOfOffset(content, matchStart)
    const envVar = envMap.get(port)

    out += content.slice(cursor, matchStart)

    if (envVar && isTsLike) {
      const after = buildTsReplacement(scheme, host, tail, envVar)
      out += after
      fixes.push({ line, before: whole, after, envVar })
      rewrote = true
    } else if (envVar && isPy) {
      out += whole
      errors.push({
        line,
        match: whole,
        reason: `hardcoded runtime port ${port}; use os.environ['${envVar}'] instead`,
      })
    } else if (envVar) {
      // Lintable file we don't auto-fix (none today, but future-proof) —
      // surface as error so the agent can deal with it.
      out += whole
      errors.push({
        line,
        match: whole,
        reason: `hardcoded runtime port ${port}; use process.env.${envVar} instead`,
      })
    } else {
      // Not a known runtime port — warn only.
      out += whole
      warnings.push({
        line,
        match: whole,
        reason: `hardcoded localhost port ${port}; source it from an env var if this is a service URL`,
      })
    }

    cursor = matchStart + whole.length
  }
  out += content.slice(cursor)

  const result: PortScanResult = { fixes, warnings, errors }
  if (rewrote) result.newContent = out
  return result
}
