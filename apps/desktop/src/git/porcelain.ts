// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Pure parser for `git status --porcelain=v2 -z --branch`.
//
// Why we use porcelain v2 -z:
//   - Stable, machine-readable contract (vs --short which is human-flavored).
//   - NUL-delimited entries so we are safe against filenames containing
//     newlines, spaces, quotes, or backslashes.
//   - Includes the `# branch.*` header lines that give us the current
//     branch + upstream + ahead/behind counts in the same invocation.
//
// Format reference: https://git-scm.com/docs/git-status#_porcelain_format_version_2
//
// Header lines (prefix `# `):
//   # branch.oid <commit> | (initial)
//   # branch.head <name>  | (detached)
//   # branch.upstream <upstream>           — only if upstream configured
//   # branch.ab +<ahead> -<behind>         — only if upstream configured
//
// Entry lines:
//   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
//   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
//   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
//   ? <path>
//   ! <path>

export type FileStatusCode =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'conflict'
  | 'typechange'

export interface FileStatus {
  /** POSIX-style path relative to the repo root. */
  path: string
  /** Original path for renames/copies. */
  originalPath?: string
  /** Status in the index (X column). */
  index: FileStatusCode | 'unmodified'
  /** Status in the working tree (Y column). */
  working: FileStatusCode | 'unmodified'
  /** True when both index and working agree this is a conflict. */
  isConflict: boolean
  /** True when working has a real change vs. HEAD (modified/added/del/renamed). */
  isDirty: boolean
}

export interface PorcelainStatus {
  branch: string | null
  /** Detached state — when true, `branch` will be `'(detached)'`. */
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  files: FileStatus[]
}

const XY_MAP: Record<string, FileStatusCode | 'unmodified'> = {
  '.': 'unmodified',
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflict',
  '?': 'untracked',
  '!': 'ignored',
}

function decodeXY(c: string): FileStatusCode | 'unmodified' {
  return XY_MAP[c] ?? 'unmodified'
}

/**
 * Parse `git status --porcelain=v2 -z --branch` stdout into a structured
 * snapshot. Throws nothing — returns a best-effort result so callers don't
 * have to special-case parser bugs.
 */
export function parsePorcelainV2(stdout: string): PorcelainStatus {
  const result: PorcelainStatus = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  }

  // Split into NUL-delimited records. Header lines are newline-terminated
  // and may be mixed with NUL-delimited entries; we walk the input as a
  // single pass, splitting on NUL but treating any leading newline-bounded
  // chunk as potential headers.
  let i = 0
  const n = stdout.length
  while (i < n) {
    // Skip leading newlines
    while (i < n && (stdout[i] === '\n' || stdout[i] === '\r')) i++
    if (i >= n) break

    // Find next NUL or newline
    let j = i
    while (j < n && stdout[j] !== '\0' && stdout[j] !== '\n') j++
    const record = stdout.slice(i, j)

    if (record.startsWith('# ')) {
      // Header line — newline-terminated, no NUL involved
      parseHeader(record, result)
      i = j + 1
      continue
    }

    if (record.length === 0) {
      i = j + 1
      continue
    }

    // Status entry — NUL-terminated. For type '2' (rename/copy) there's an
    // additional NUL + origPath following the first NUL.
    const type = record[0]
    if (type === '1') {
      result.files.push(parseTracked(record))
      i = j + 1
    } else if (type === '2') {
      const tracked = parseTracked(record)
      // Next NUL-delimited record is the original path
      const startOrig = j + 1
      let k = startOrig
      while (k < n && stdout[k] !== '\0') k++
      tracked.originalPath = stdout.slice(startOrig, k)
      result.files.push(tracked)
      i = k + 1
    } else if (type === 'u') {
      result.files.push(parseUnmerged(record))
      i = j + 1
    } else if (type === '?') {
      // `? <path>`
      const path = record.slice(2)
      result.files.push({
        path,
        index: 'unmodified',
        working: 'untracked',
        isConflict: false,
        isDirty: true,
      })
      i = j + 1
    } else if (type === '!') {
      const path = record.slice(2)
      result.files.push({
        path,
        index: 'ignored',
        working: 'ignored',
        isConflict: false,
        isDirty: false,
      })
      i = j + 1
    } else {
      // Unknown record — skip
      i = j + 1
    }
  }

  return result
}

function parseHeader(line: string, out: PorcelainStatus): void {
  // line is e.g. "# branch.head main"
  const rest = line.slice(2).trim()
  if (rest.startsWith('branch.head ')) {
    const head = rest.slice('branch.head '.length).trim()
    if (head === '(detached)') {
      out.branch = '(detached)'
      out.detached = true
    } else {
      out.branch = head
    }
  } else if (rest.startsWith('branch.upstream ')) {
    out.upstream = rest.slice('branch.upstream '.length).trim()
  } else if (rest.startsWith('branch.ab ')) {
    // "+N -M"
    const m = /\+(\d+)\s+-(\d+)/.exec(rest)
    if (m) {
      out.ahead = Number.parseInt(m[1], 10)
      out.behind = Number.parseInt(m[2], 10)
    }
  }
  // branch.oid is ignored — we don't need it for G1.
}

/** Parse a `1 <XY> ...` or `2 <XY> ...` tracked-file record. */
function parseTracked(record: string): FileStatus {
  // Record shape (split on spaces, then take path = everything after field 8/9):
  //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
  //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>
  // Path itself may contain spaces — we count fields and the path is the rest.
  const parts = record.split(' ')
  const xy = parts[1] ?? '..'
  const x = xy[0] ?? '.'
  const y = xy[1] ?? '.'
  // type 1 → path starts at index 8 (fields 0..7 are token+meta)
  // type 2 → path starts at index 9 (extra Xscore field)
  const pathStart = parts[0] === '2' ? 9 : 8
  const path = parts.slice(pathStart).join(' ')
  const index = decodeXY(x)
  const working = decodeXY(y)
  return {
    path,
    index,
    working,
    isConflict: false,
    isDirty: index !== 'unmodified' || working !== 'unmodified',
  }
}

/** Parse a `u <XY> ...` unmerged (conflict) record. */
function parseUnmerged(record: string): FileStatus {
  const parts = record.split(' ')
  const xy = parts[1] ?? 'UU'
  const x = xy[0] ?? 'U'
  const y = xy[1] ?? 'U'
  // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
  //   0   1    2    3    4    5    6    7    8    9   10
  // Path starts at index 10 (the 11th token).
  const path = parts.slice(10).join(' ')
  return {
    path,
    index: decodeXY(x),
    working: decodeXY(y),
    isConflict: true,
    isDirty: true,
  }
}

/**
 * Compact one-letter status code for tree decorations. Working column wins,
 * falling back to index, falling back to '·'.
 */
export function shortCode(f: FileStatus): 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!' | '·' {
  if (f.isConflict) return 'U'
  if (f.working === 'modified' || f.index === 'modified') return 'M'
  if (f.working === 'added' || f.index === 'added') return 'A'
  if (f.working === 'deleted' || f.index === 'deleted') return 'D'
  if (f.working === 'renamed' || f.index === 'renamed') return 'R'
  if (f.working === 'copied' || f.index === 'copied') return 'C'
  if (f.working === 'typechange' || f.index === 'typechange') return 'T'
  if (f.working === 'untracked') return 'U'
  if (f.working === 'ignored') return '!'
  return '·'
}
