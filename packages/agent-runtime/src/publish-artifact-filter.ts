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

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, createReadStream } from 'fs'
import { join, relative } from 'path'
import type { Dirent } from 'fs'
import { createHash } from 'crypto'
import ignore from 'ignore'
import { isShogoRuntimeSubtree } from '@shogo/shared-runtime/shogo-state-paths'
import { headObject, lfsObjectKey, lfsPointerText, lfsTrackedPaths, putFileToObjectStore, sharedStaticAssetCacheControl, stampObjectMetadata, type S3ObjectStore } from '@shogo/shared-runtime'
import { staticMimeFor } from './dist-response'
import { isObjectStoreAuthFailure } from './object-store-errors'

/** Root-relative paths that never belong in the image. */
const SKIP_AT_ROOT = new Set(['node_modules', '.git', '.shogo', 'dist', '.tmp'])

/** Dependency and cache directories, skipped at ANY depth. */
const SKIP_ANYWHERE = new Set(['node_modules', '.turbo', '.next', '.cache'])

/** SQLite sidecar files: a `-wal` replayed onto the image's DB corrupts it. */
const SKIP_SUFFIX = /-(wal|shm)$/

/** Env files carry secrets. `.env.example` documents the shape and stays. */
const SKIP_ENV_FILE = /^\.env(\..+)?$/
const KEEP_ENV_FILE = /^\.env\.example$/

/**
 * The standard Docker build-context ignore file, read from the project root.
 * This IS a Docker context (`COPY . /app`), so honouring the file the project
 * already maintains beats inventing a Shogo-specific one (SHO-514).
 */
const DOCKERIGNORE_FILE = '.dockerignore'

/**
 * Paths the published image cannot boot without, whatever the project's
 * `.dockerignore` says: the packageless image has no dependency install step,
 * and the published database is pushed from `prisma/schema.prisma`.
 *
 * `.dockerignore` may only ADD to the exclusions — it can never remove these.
 * (The root `dist/` is deliberately absent: that copy is the canvas preview
 * build, which a published image must never contain. The published bundle is
 * copied in from the publish staging output, which this filter never sees, so
 * no `.dockerignore` can exclude it either.)
 */
const PLATFORM_REQUIRED = new Set([
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'prisma/schema.prisma',
  'prisma/dev.db',
])

/**
 * Every directory that contains a `PLATFORM_REQUIRED` file.
 *
 * `fs.cp` calls its filter on a directory BEFORE descending into it, so a
 * `.dockerignore` rule that matches the directory (`*`, `pr*`, an allowlist shape
 * like `*` + `!src`) prunes the whole subtree — and `PLATFORM_REQUIRED.has()`
 * only ever saw full file paths. Without this, the common "ship nothing but what
 * I list" `.dockerignore` silently stripped `prisma/`: the Dockerfile's
 * `prisma generate` was skipped and a SQLite-mode pod booted with no database.
 */
const PLATFORM_REQUIRED_DIRS = new Set(
  [...PLATFORM_REQUIRED].flatMap((required) => {
    const parts = required.split('/')
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
  }),
)

/** A path the platform needs, or a directory leading to one. */
function keepForPlatform(rel: string): boolean {
  return PLATFORM_REQUIRED.has(rel) || PLATFORM_REQUIRED_DIRS.has(rel)
}

export interface ArtifactFilterOptions {
  /** Absolute project directory the copy starts from. */
  projectDir: string
  /** The publish-staging directory name to exclude (the canvas preview build). */
  stagingDirName: string
}

/**
 * The hard exclusions: things that never reach a published image, and which no
 * `.dockerignore` negation can bring back.
 *
 * `rel` is the root-relative path, `/`-separated.
 */
function hardExcluded(rel: string, stagingDirName: string): boolean {
  if (!rel) return false
  if (SKIP_SUFFIX.test(rel)) return true
  // Shogo's own runtime state, at any depth, from the shared predicate
  // (SHO-371) — a nested `.shogo/` or `.shogo-cwd-*` must not reach the image.
  if (isShogoRuntimeSubtree(rel)) return true

  const segments = rel.split(/[\\/]/).filter(Boolean)
  if (segments.length === 0) return false

  const first = segments[0]
  if (SKIP_AT_ROOT.has(first) || first === stagingDirName) return true
  if (segments.some((segment) => SKIP_ANYWHERE.has(segment))) return true

  const base = segments[segments.length - 1]
  if (SKIP_ENV_FILE.test(base) && !KEEP_ENV_FILE.test(base)) return true
  return false
}

/** The project's `.dockerignore`, compiled, or null when it has none. */
export function readDockerignore(projectDir: string): ReturnType<typeof ignore> | null {
  const path = join(projectDir, DOCKERIGNORE_FILE)
  if (!existsSync(path)) return null
  try {
    const matcher = ignore()
    matcher.add(readFileSync(path, 'utf-8'))
    return matcher
  } catch {
    // An unreadable ignore file must not silently widen the context: no matcher
    // means exactly today's exclusions, never "ship everything".
    return null
  }
}

/**
 * Build the `cp` filter for a published build context.
 *
 * `src` is an absolute path under `projectDir`; anything outside it is refused,
 * which keeps a symlinked sibling repo out of the image.
 *
 * The project's `.dockerignore` is honoured, but one-directionally: it can only
 * remove paths. Hard exclusions (`.env*`, `.git`, `node_modules`, `.shogo`,
 * `-wal/-shm`) and the files the platform needs to boot are decided first, so a
 * `!.env` or `!node_modules` rule cannot bring either back.
 */
export function createPublishedArtifactFilter(
  opts: ArtifactFilterOptions,
): (src: string) => boolean {
  const root = opts.projectDir.replace(/\/+$/, '')
  const prefix = `${root}/`
  const dockerignore = readDockerignore(opts.projectDir)
  return (src: string): boolean => {
    if (src === root) return true
    // Prefix, not `startsWith(root)`: a sibling checkout whose name merely
    // begins with the same characters (`/work/project-two`) would otherwise slip
    // through with a mangled relative path.
    if (!src.startsWith(prefix)) return false
    const rel = src.slice(prefix.length)
    if (!rel) return true

    const normalized = rel.split(/[\\/]/).join('/')
    if (hardExcluded(normalized, opts.stagingDirName)) return false
    // The context is built BY Docker, so shipping `.dockerignore` would make
    // BuildKit apply it a second time to the platform-added files.
    if (normalized === DOCKERIGNORE_FILE) return false
    if (keepForPlatform(normalized)) return true
    if (dockerignore?.ignores(normalized)) return false
    return true
  }
}

/**
 * What the project's `.dockerignore` removes from an otherwise-identical
 * context: file count and bytes. Used by the publish endpoint to say, in the
 * publish output, how much a project is already leaving out — the difference
 * between a 20 MB image and a 2 GB one usually hides in a rule nobody wrote.
 */
export function measureDockerignoreExclusion(
  opts: ArtifactFilterOptions,
): { paths: number; bytes: number } {
  if (!readDockerignore(opts.projectDir)) return { paths: 0, bytes: 0 }
  // Ask the filter itself rather than re-deriving the rules here: the number in
  // the publish output has to be what the context actually lost, and a second
  // copy of those rules is how it stops being that (a directory-pruning rule
  // once counted `prisma/` as dropped while the image kept it).
  const keep = createPublishedArtifactFilter(opts)
  let paths = 0
  let bytes = 0
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relative(opts.projectDir, full).replace(/\\/g, '/')
      if (hardExcluded(rel, opts.stagingDirName)) continue
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      // Kept in the context, or excluded by the platform rather than by the
      // project — either way it is not the `.dockerignore`'s doing.
      if (keep(full) || rel === DOCKERIGNORE_FILE || PLATFORM_REQUIRED.has(rel)) continue
      paths++
      try {
        bytes += statSync(full).size
      } catch {}
    }
  }
  walk(opts.projectDir)
  return { paths, bytes }
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
  /** Existing objects whose stored `Content-Type` was wrong and corrected in place. */
  restamped: number
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
  const result: ArtifactMediaOffloadResult = { pointers: 0, uploaded: 0, reused: 0, restamped: 0, bytesLeftOut: 0 }
  const { paths, sizes } = collectContextFiles(opts.contextDir)
  if (paths.length === 0) return result

  const lfsTracked = await lfsTrackedPaths(opts.sourceDir, paths.filter((p) => !p.startsWith('dist/')))
  const targets = artifactPointerTargets({ paths, lfsTracked, sizes })
  if (targets.length === 0) return result

  // Group by oid before touching the store: an oid is one object, and the pod
  // serves that object's own metadata, so every path referencing it shares one
  // `Content-Type` and one `Cache-Control`. Stamping per path let the last
  // writer win — a hashed copy could put `immutable` on a stable URL.
  const byOid = new Map<string, { size: number; entries: { rel: string; contextPath: string }[] }>()
  for (const rel of targets) {
    const contextPath = join(opts.contextDir, rel)
    const { oid, size } = await hashFileOid(contextPath)
    const group = byOid.get(oid)
    if (group) group.entries.push({ rel, contextPath })
    else byOid.set(oid, { size, entries: [{ rel, contextPath }] })
  }

  for (const [oid, group] of byOid) {
    const key = lfsObjectKey(opts.projectId, oid)
    const referencing = group.entries.map((entry) => entry.rel).sort()
    const contentType = staticMimeFor(referencing[0]!)
    const cacheControl = sharedStaticAssetCacheControl(referencing)
    try {
      const existing = await headObject(opts.store, key)
      if (!existing) {
        await putFileToObjectStore(opts.store, key, group.entries[0]!.contextPath, {
          bytes: group.size,
          contentType,
          cacheControl,
        })
        result.uploaded++
      } else if (existing.contentType !== contentType || existing.cacheControl !== cacheControl) {
        // Same bytes, wrong (or absent) stamp: `git lfs push` uploads through a
        // presigned PUT and picks `application/octet-stream`, and this key is
        // reused by every later publish.
        await stampObjectMetadata(opts.store, key, { contentType, cacheControl })
        result.restamped++
      } else {
        result.reused++
      }
    } catch (err) {
      // A credentials failure is not data loss: the object was never readable
      // because this runtime has no usable keys. Rethrowing it unchanged lets
      // the caller keep the media in the tar and still upload the artifact;
      // wrapping it here made a metal host with `S3_LFS_BUCKET` and no access
      // key report `lfs_object_missing` and 500 the whole publish (SHO-551 C).
      if (isObjectStoreAuthFailure(err)) throw err
      throw new ArtifactMediaOffloadError(referencing[0]!, oid, err)
    }
    for (const entry of group.entries) {
      writeFileSync(entry.contextPath, lfsPointerText(oid, group.size))
      result.pointers++
      result.bytesLeftOut += group.size
    }
  }

  logger.log(
    `[publish-artifact] offloaded ${result.pointers} media file(s) ` +
      `(${result.uploaded} uploaded, ${result.reused} already stored, ` +
      `${result.restamped} re-stamped, ` +
      `${(result.bytesLeftOut / (1024 * 1024)).toFixed(1)} MB left out of the image)`,
  )
  return result
}

