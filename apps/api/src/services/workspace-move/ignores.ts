// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a workspace move leaves behind.
 *
 * A move is not an archive: the point is to take a 19 GB content workspace to
 * the other side without taking the 15 GB of `out/` and `.tmp/` renders that
 * the other side will regenerate. The default rules are deliberately the same
 * on both surfaces, and a project can add its own with a `.shogoignore` file
 * (gitignore syntax) at its root.
 *
 * The matcher is a gitignore subset — comments, blank lines, `!` negation,
 * leading `/` anchoring, trailing `/` for directories, and `*` / `**` / `?`
 * globs — because that is what people already have in `.gitignore` and what
 * they will copy from.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where a project can add its own rules. */
export const MOVE_IGNORE_FILE = '.shogoignore'

/**
 * Skips applied to every move, in every direction.
 *
 * `out/`, `dist/`, `.tmp/` and `.shogo/logs/` are build output and logs: the
 * target rebuilds them, and carrying them is how the 500 MB archive cap became
 * a problem in the first place. `node_modules` and the caches are per-machine.
 */
export const DEFAULT_MOVE_IGNORE_RULES: readonly string[] = Object.freeze([
  'node_modules/',
  '.git/',
  '.cache/',
  '.next/',
  '.turbo/',
  '.expo/',
  'out/',
  '.tmp/',
  'dist/',
  '.shogo/logs/',
])

export interface IgnoreRule {
  pattern: string
  negated: boolean
  dirOnly: boolean
  anchored: boolean
  regex: RegExp
}

const GLOB_SPECIAL = /[.+^${}()|[\]\\]/g

/** `**` crosses directories, `*` and `?` stay inside one segment. */
function globToRegex(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` also matches zero directories, so `a/**/b` matches `a/b`.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(GLOB_SPECIAL, '\\$&')
  }
  return out
}

/**
 * Compile gitignore-style lines. A line that cannot be compiled (an empty
 * pattern, or one that is only `!`) is dropped rather than thrown: a broken
 * ignore file must not stop a move.
 */
export function compileIgnoreRules(lines: readonly string[]): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    const body = negated ? line.slice(1) : line
    if (!body) continue
    const dirOnly = body.endsWith('/')
    const withoutSlash = dirOnly ? body.slice(0, -1) : body
    if (!withoutSlash) continue
    const anchored = withoutSlash.includes('/') && !withoutSlash.startsWith('**/')
    const glob = withoutSlash.replace(/^\//, '')
    if (!glob) continue
    const globRegex = globToRegex(glob)
    // A directory rule excludes the directory *and its contents* — gitignore's
    // contract, and the one people rely on when they write `out/`.
    const source = dirOnly
      ? `^(?:.*/)?${globRegex}(?:/.*)?$`
      : anchored
        ? `^${globRegex}$`
        : `^(?:.*/)?${globRegex}$`
    rules.push({ pattern: line, negated, dirOnly, anchored, regex: new RegExp(source) })
  }
  return rules
}

/** The default rules plus a project's own `.shogoignore`, in that order. */
export function moveIgnoreRules(projectDir?: string | null): IgnoreRule[] {
  const lines: string[] = [...DEFAULT_MOVE_IGNORE_RULES]
  if (projectDir) {
    const path = join(projectDir, MOVE_IGNORE_FILE)
    if (existsSync(path)) {
      try {
        lines.push(...readFileSync(path, 'utf8').split('\n'))
      } catch {
        // An unreadable ignore file means "defaults only", never a failed move.
      }
    }
  }
  return compileIgnoreRules(lines)
}

/**
 * Whether a relative path is ignored. Later rules win, so a `!` line can bring
 * back something an earlier rule excluded — that is the gitignore contract.
 *
 * `isDir` matters because `out/` must not exclude a *file* called `out`.
 */
export function isMoveIgnored(relPath: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  const path = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!path) return false
  const segments = path.split('/')
  let ignored = false
  for (const rule of rules) {
    // A directory rule matches the directory itself, and — for a file — any
    // directory it sits under. That is why `out/` skips `out/render.mp4` while
    // a *file* named `out` stays.
    let matches = false
    if (rule.dirOnly && !isDir) {
      for (let depth = 1; depth < segments.length; depth++) {
        if (rule.regex.test(segments.slice(0, depth).join('/'))) {
          matches = true
          break
        }
      }
    } else {
      matches = rule.regex.test(path)
    }
    if (!matches) continue
    ignored = !rule.negated
  }
  return ignored
}

/** Human-readable list for the plan step: "these rules, this many bytes saved". */
export function describeIgnoreRules(rules: readonly IgnoreRule[]): string[] {
  return rules.map((rule) => rule.pattern)
}
