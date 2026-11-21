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

import { existsSync, readdirSync, statSync, writeFileSync, createReadStream } from 'fs'
import { join, relative } from 'path'
import type { Dirent } from 'fs'
import { createHash } from 'crypto'
import { isShogoRuntimeSubtree } from '@shogo/shared-runtime/shogo-state-paths'
import { lfsObjectKey, lfsPointerText, lfsTrackedPaths, objectExists, putFileToObjectStore, type S3ObjectStore } from '@shogo/shared-runtime'

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
    // Shogo's own runtime state, at any depth, from the shared predicate
    // (SHO-371) — a nested `.shogo/` or `.shogo-cwd-*` must not reach the image.
    if (isShogoRuntimeSubtree(rel)) return false

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

// ---------------------------------------------------------------------------
// Large media stays out of the artifact (SHO-485)
// ---------------------------------------------------------------------------

/**
 * A `dist/` file at or above this size is content-addressed into the object
 * store and replaced by LFS pointer text in the artifact.
 *
 * 5 MiB because that is the size where media starts to matter for a pod's 2 Gi
 * volume and for a response the runtime must stream. Below it, the bytes simply
 * travel: a small project must publish and serve byte-for-byte as it does
 * today, and a build context full of small files is not what hurt.
 */
export const PUBLISH_DIST_OFFLOAD_MIN_BYTES = 5 * 1024 * 1024

/**
 * Which files in a build context become pointer text.
 *
 * Pure, so the rule is testable without a git repo, an object store or a
 * build:
 *   - every source path `.gitattributes` marks `filter=lfs` (the bytes are
 *     already durable in `<projectId>/lfs/objects`, so the artifact only needs
 *     the pointer);
 *   - every `dist/` file at or above {@link PUBLISH_DIST_OFFLOAD_MIN_BYTES} —
 *     this covers a `public/` copy and a Vite-hashed import without having to
 *     map a dist path back to the source that produced it.
 *
 * `dist/` HTML is left alone: it is the one file the runtime has to read to
 * inject its bridge, and a 5 MiB HTML page is a bug, not media.
 */
export function artifactPointerTargets(input: {
  /** Root-relative paths of every file in the context. */
  paths: readonly string[]
  /** Root-relative paths of files tracked by Git LFS. */
  lfsTracked: ReadonlySet<string>
  /** Size in bytes, by root-relative path. */
  sizes: ReadonlyMap<string, number>
}): string[] {
  const out = new Set<string>()
  for (const path of input.paths) {
    if (input.lfsTracked.has(path)) {
      out.add(path)
      continue
    }
    if (!path.startsWith('dist/') || /\.html?$/i.test(path)) continue
    const size = input.sizes.get(path) ?? 0
    if (size >= PUBLISH_DIST_OFFLOAD_MIN_BYTES) out.add(path)
  }
  return [...out].sort()
}

export interface ArtifactMediaOffloadResult {
  /** Context files replaced by pointer text. */
  pointers: number
  /** Objects the store did not have, uploaded from the context. */
  uploaded: number
  /** Objects the store already had (the common case for committed LFS media). */
  reused: number
  /** Real media bytes left out of the artifact. */
  bytesLeftOut: number
}

/** Raised when a pointer could not be backed by an object in the store. */
export class ArtifactMediaOffloadError extends Error {
  constructor(
    readonly path: string,
    readonly oid: string,
    cause: unknown,
  ) {
    super(
      `lfs_object_missing: ${path} (oid ${oid}) has no object in the store — refusing to ship a pointer with no bytes behind it: ` +
        String((cause as any)?.message ?? cause).slice(0, 200),
    )
    this.name = 'ArtifactMediaOffloadError'
  }
}

/** Root-relative paths and sizes of every file under `root`. */
export function collectContextFiles(root: string): { paths: string[]; sizes: Map<string, number> } {
  const paths: string[] = []
  const sizes = new Map<string, number>()
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = statSync(full)
        const rel = relative(root, full).replace(/\\/g, '/')
        paths.push(rel)
        sizes.set(rel, stat.size)
      } catch {
        // unreadable file: leave it in the artifact rather than lose it
      }
    }
  }
  if (existsSync(root)) walk(root)
  return { paths, sizes }
}

/** sha256 of a file, streamed — the git-lfs oid of its content. */
export function hashFileOid(filePath: string): Promise<{ oid: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let size = 0
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      hash.update(chunk as Buffer)
      size += (chunk as Buffer).length
    })
    stream.on('error', reject)
    stream.on('end', () => resolve({ oid: hash.digest('hex'), size }))
  })
}

/**
 * Replace the context's large media with pointer text, after making sure each
 * object is durable in `<projectId>/lfs/objects/…`.
 *
 * This is what lets a published pod's artifact (and therefore its image) stay
 * small however much media the project has (SHO-485): the bytes are already
 * where the runtime reads them from on demand, so the image only needs the
 * pointer. A pointer whose object cannot be stored fails the publish here,
 * with a name — never later, as a 404 nobody can explain.
 */
export async function offloadArtifactMedia(opts: {
  /** The staged context (what the tar is made from). */
  contextDir: string
  /** The project working tree the LFS attributes are read from. */
  sourceDir: string
  projectId: string
  store: S3ObjectStore
  logger?: Pick<Console, 'log' | 'warn'>
}): Promise<ArtifactMediaOffloadResult> {
  const logger = opts.logger ?? console
  const result: ArtifactMediaOffloadResult = { pointers: 0, uploaded: 0, reused: 0, bytesLeftOut: 0 }
  const { paths, sizes } = collectContextFiles(opts.contextDir)
  if (paths.length === 0) return result

  const lfsTracked = await lfsTrackedPaths(opts.sourceDir, paths.filter((p) => !p.startsWith('dist/')))
  const targets = artifactPointerTargets({ paths, lfsTracked, sizes })
  if (targets.length === 0) return result

  for (const rel of targets) {
    const contextPath = join(opts.contextDir, rel)
    const { oid, size } = await hashFileOid(contextPath)
    const key = lfsObjectKey(opts.projectId, oid)
    try {
      if (await objectExists(opts.store, key)) {
        result.reused++
      } else {
        await putFileToObjectStore(opts.store, key, contextPath, { bytes: size, contentType: 'application/octet-stream' })
        result.uploaded++
      }
    } catch (err) {
      throw new ArtifactMediaOffloadError(rel, oid, err)
    }
    writeFileSync(contextPath, lfsPointerText(oid, size))
    result.pointers++
    result.bytesLeftOut += size
  }

  logger.log(
    `[publish-artifact] offloaded ${result.pointers} media file(s) ` +
      `(${result.uploaded} uploaded, ${result.reused} already stored, ` +
      `${(result.bytesLeftOut / (1024 * 1024)).toFixed(1)} MB left out of the image)`,
  )
  return result
}

