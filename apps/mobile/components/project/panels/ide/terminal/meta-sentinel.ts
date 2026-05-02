// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Record-Separator framed trailer emitted by the runtime terminal `/run`
 * route after a free-form command finishes. Carries `{ cwd, exitCode,
 * signal }` as base64-encoded JSON.
 *
 * Kept in sync with `META_SENTINEL_{PREFIX,SUFFIX}` in
 * `apps/api/src/routes/terminal.ts` and the runtime terminal route in
 * `packages/agent-runtime/src/runtime-terminal-routes.ts`. Change all of
 * them or none of them.
 */
export const META_SENTINEL_RE = /\u001eSHOGO_TERM_META:([A-Za-z0-9+/=]+)\u001e\n?/

export interface RunMeta {
  cwd?: string
  exitCode?: number | null
  signal?: string | null
}

/**
 * Pull the first complete sentinel out of `buf`, returning the decoded
 * payload (if any) plus the remaining buffer with the sentinel removed.
 * Callers feed chunks in progressively and hold back a tail to handle
 * sentinels that straddle chunk boundaries (use `findIncompleteTailIndex`).
 */
export function extractMeta(buf: string): { meta: RunMeta | null; rest: string } {
  const m = META_SENTINEL_RE.exec(buf)
  if (!m) return { meta: null, rest: buf }
  let meta: RunMeta | null = null
  try {
    const json =
      typeof atob === 'function'
        ? atob(m[1])
        : Buffer.from(m[1], 'base64').toString('utf8')
    meta = JSON.parse(json) as RunMeta
  } catch {
    meta = null
  }
  return { meta, rest: buf.slice(0, m.index) + buf.slice(m.index + m[0].length) }
}

/**
 * If `buf` ends with a possibly-incomplete sentinel (a trailing `\u001e`
 * that hasn't been closed yet), return the index of that opening byte so
 * the caller can hold back the tail. Returns -1 if no incomplete tail
 * exists.
 */
export function findIncompleteTailIndex(buf: string): number {
  return buf.lastIndexOf('\u001e')
}

/**
 * After end-of-stream, anything still matching `\u001eSHOGO_TERM_META:…`
 * but missing the closing byte is malformed and should be dropped instead
 * of leaking control bytes into the visible output.
 */
export const UNTERMINATED_SENTINEL_RE = /^\u001eSHOGO_TERM_META:[A-Za-z0-9+/=]*$/
