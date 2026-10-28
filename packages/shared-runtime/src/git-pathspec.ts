// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `:(exclude)` pathspecs for `paths`, minus those `.gitignore` already covers.
 * `git add` exits 1 ("The following paths are ignored...") when an exclude
 * names an ignored path that exists, which is the default for `.shogo/local`.
 * `isIgnored` should run `git check-ignore -q -- <path>` (exit 0 = ignored).
 *
 * `literal: true` emits `:(exclude,literal)` — use it for a path handed to us by
 * git rather than one of our own constants, so a filename containing `*` or `?`
 * is excluded exactly rather than as a glob (SHO-180).
 */
export async function excludePathspecs(
  paths: string[],
  isIgnored: (path: string) => Promise<boolean>,
  opts: { literal?: boolean } = {},
): Promise<string[]> {
  const magic = opts.literal ? ':(exclude,literal)' : ':(exclude)'
  const out: string[] = []
  for (const p of paths) {
    if (!(await isIgnored(p))) out.push(`${magic}${p}`)
  }
  return out
}
