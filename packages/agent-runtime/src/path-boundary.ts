// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Platform-correct "is this path inside that root?" containment checks.
 *
 * Every containment guard in this package used to open-code the test as
 * `resolved.startsWith(root + '/')`. That is wrong twice over:
 *
 *   1. On Windows `path.resolve()` returns backslash-separated paths, so the
 *      `root + '/'` prefix never matches and EVERY child path is rejected
 *      (SHOG-749). Only the root directory itself could pass, via `===`.
 *   2. A bare `startsWith(root)` without a trailing separator lets a sibling
 *      directory escape the root: `/workspace-evil` passes `startsWith('/workspace')`.
 *
 * `relative()` gets both cases right on every platform, including different
 * Windows drive letters (which yield an absolute result, not a `..` walk).
 *
 * Case sensitivity follows the filesystem: Windows and macOS are folded,
 * Linux is left alone (folding there would *widen* the guard and let
 * `/Workspace` match `/workspace`).
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** True on filesystems that treat `Foo` and `foo` as the same path. */
export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/** Fold case only where the filesystem does. */
export function normalizeForCompare(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p
}

/**
 * True when `candidate` is `root` itself or lives underneath it.
 *
 * Both arguments are `resolve()`d first, so relative inputs are interpreted
 * against the process cwd — pass absolute paths if that is not what you want.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForCompare(resolve(root))
  const normalizedCandidate = normalizeForCompare(resolve(candidate))

  if (normalizedRoot === normalizedCandidate) return true

  const rel = relative(normalizedRoot, normalizedCandidate)

  // Empty  -> same directory (already handled, but relative() can normalise to '').
  // '..' or '..<sep>...' -> candidate is outside root.
  // Absolute -> different Windows drive / UNC share, so also outside.
  if (rel === '') return true
  if (rel === '..' || rel.startsWith('..' + sep)) return false
  return !isAbsolute(rel)
}

/** True when `candidate` is inside (or equal to) at least one of `roots`. */
export function isWithinAnyRoot(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isWithinRoot(root, candidate))
}

/**
 * Drop duplicate roots, comparing the way the filesystem does.
 *
 * Folder-linked projects hand the same directory in twice — once as the
 * workspace dir and once via LINKED_FOLDERS — which is why "allowed roots"
 * error messages printed the same path repeatedly. Order is preserved.
 */
export function dedupeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    const key = normalizeForCompare(resolve(root))
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}
