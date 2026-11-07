// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What goes into a published build context (SHO-308 §2).
 *
 * The built image is a copy of the project at its published commit plus the
 * root-based `dist/` — so the filter decides what ends up in an OCI layer. It is
 * a separate module because it is the security boundary of that copy and it kept
 * getting this wrong inline: matching only the FIRST path segment let a nested
 * `apps/web/node_modules` through, which `COPY . /app` then lays down *before*
 * `bun install`, and it let `.env` files (real secrets) ride into the image.
 */

/** Root-relative paths that never belong in the image. */
const SKIP_AT_ROOT = new Set(['node_modules', '.git', '.shogo', 'dist', '.tmp'])

/** Dependency and cache directories, skipped at ANY depth. */
const SKIP_ANYWHERE = new Set(['node_modules', '.turbo', '.next', '.cache'])

/** SQLite sidecar files: a `-wal` replayed onto the image's DB corrupts it. */
const SKIP_SUFFIX = /-(wal|shm)$/

/** Env files carry secrets. `.env.example` documents the shape and stays. */
const SKIP_ENV_FILE = /^\.env(\..+)?$/
const KEEP_ENV_FILE = /^\.env\.example$/

export interface ArtifactFilterOptions {
  /** Absolute project directory the copy starts from. */
  projectDir: string
  /** The publish-staging directory name to exclude (the canvas preview build). */
  stagingDirName: string
}

/**
 * Build the `cp` filter for a published build context.
 *
 * `src` is an absolute path under `projectDir`; anything outside it is refused,
 * which keeps a symlinked sibling repo out of the image.
 */
export function createPublishedArtifactFilter(
  opts: ArtifactFilterOptions,
): (src: string) => boolean {
  const root = opts.projectDir.replace(/\/+$/, '')
  const prefix = `${root}/`
  return (src: string): boolean => {
    if (src === root) return true
    // Prefix, not `startsWith(root)`: a sibling checkout whose name merely
    // begins with the same characters (`/work/project-two`) would otherwise slip
    // through with a mangled relative path.
    if (!src.startsWith(prefix)) return false
    const rel = src.slice(prefix.length)
    if (!rel) return true
    if (SKIP_SUFFIX.test(rel)) return false

    const segments = rel.split(/[\\/]/).filter(Boolean)
    if (segments.length === 0) return true

    const first = segments[0]
    if (SKIP_AT_ROOT.has(first) || first === opts.stagingDirName) return false
    if (segments.some((segment) => SKIP_ANYWHERE.has(segment))) return false

    const base = segments[segments.length - 1]
    if (SKIP_ENV_FILE.test(base) && !KEEP_ENV_FILE.test(base)) return false
    return true
  }
}
