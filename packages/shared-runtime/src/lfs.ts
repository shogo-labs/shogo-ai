// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Git LFS support for the pod-owned `git_only` model.
 *
 * Replaces the size-based S3 offload in `large-file-sync.ts` with real
 * Git LFS: large files are tracked via `.gitattributes`, stored as tiny
 * pointer blobs in the commit DAG, and their bytes are offloaded to OCI
 * Object Storage through the API's LFS batch endpoint
 * (`apps/api/src/routes/git-lfs.ts`).
 *
 * Division of labour:
 *   - The POD has the `git-lfs` binary (see `Dockerfile.base`). It runs the
 *     clean filter on `git add` (writing pointers + local objects), pushes
 *     objects to OCI via `git lfs push`, and pulls them back on cold start.
 *   - The API has NO `git-lfs` binary. It only mints presigned OCI URLs in
 *     the batch response, so bytes flow pod<->OCI directly and the API's
 *     hydrate/`reset --hard` path leaves pointer files untouched (the commit
 *     graph still shows the files).
 *
 * Auth: every `git lfs` invocation passes the runtime bearer via
 * `-c http.extraHeader=...` and the LFS endpoint via `-c lfs.url=...`, so
 * neither the token nor an environment-specific URL is ever persisted into
 * `.git/config` (which rides along in the durable `.git` tarball).
 *
 * Smudge is skipped globally in the pod image (`git lfs install --system
 * --skip-smudge`): checkout/`reset --hard` leaves pointers (fast, no
 * network), and the runtime materializes content deterministically with an
 * explicit {@link lfsPull}.
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  classifyLargeFiles,
  largeFileThreshold,
  hasManagedExclude,
  clearManagedExclude,
} from './large-file-sync'

type Logger = Pick<Console, 'log' | 'warn' | 'error'>

const GIT_TIMEOUT_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Feature flag + storage layout (shared API <-> pod contract)
// ---------------------------------------------------------------------------

/** Whether real Git LFS is enabled for this pod. */
export function isLfsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LFS_ENABLED === 'true' || env.LFS_ENABLED === '1'
}

/** Object-storage key prefix for LFS objects within a project namespace. */
export function lfsKeyPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return (env.S3_LFS_PREFIX || 'lfs/objects').replace(/^\/+|\/+$/g, '')
}

/** A Git LFS oid is a lowercase sha256 hex digest. */
export function isValidLfsOid(oid: string): boolean {
  return /^[0-9a-f]{64}$/.test(oid)
}

/**
 * Build the object-storage key for an LFS object, sharded by the first two
 * byte-pairs of the oid (the same layout git-lfs uses on disk):
 *   `<projectId>/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`
 *
 * Throws on an invalid oid so a malformed batch request can't escape the
 * project's key namespace.
 */
export function lfsObjectKey(
  projectId: string,
  oid: string,
  prefix: string = lfsKeyPrefix(),
): string {
  if (!isValidLfsOid(oid)) throw new Error(`invalid lfs oid: ${oid}`)
  return `${projectId}/${prefix}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
}

/**
 * Derive the LFS server base URL from the cloud API root + project id. The
 * git-lfs client appends `/objects/batch` (and `/objects/verify`) to this.
 *
 * We set this explicitly via `-c lfs.url=` rather than letting git-lfs guess
 * it from the remote URL: our smart-HTTP remote ends in `/git` (not `.git`),
 * which git-lfs would mangle into `.../git.git/info/lfs`.
 */
export function buildLfsEndpointUrl(cloudApiUrl: string, projectId: string): string {
  const base = cloudApiUrl.replace(/\/+$/, '')
  return `${base}/api/projects/${projectId}/git/info/lfs`
}

/** Smart-HTTP git URL for the project (used as the `cloud` remote). */
function buildGitUrl(cloudApiUrl: string, projectId: string): string {
  const base = cloudApiUrl.replace(/\/+$/, '')
  return `${base}/api/projects/${projectId}/git`
}

// ---------------------------------------------------------------------------
// .gitattributes management
// ---------------------------------------------------------------------------

const ATTR_HEADER = '# >>> shogo git-lfs (managed) >>>'
const ATTR_FOOTER = '# <<< shogo git-lfs (managed) <<<'

/**
 * Curated set of binary-ish extensions tracked by Git LFS. Files outside
 * this list that still exceed the size threshold are caught at sync time by
 * {@link autoTrackLargeFiles} (preserving the legacy "anything large" rule).
 */
export const DEFAULT_LFS_EXTENSIONS: readonly string[] = [
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'heic', 'avif', 'psd', 'ai',
  // video
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v',
  // audio
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac',
  // archives
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar',
  // documents
  'pdf',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // 3d / graphics
  'glb', 'gltf', 'fbx', 'obj', 'blend',
  // native / wasm
  'wasm', 'so', 'dylib', 'dll', 'node',
  // ml / data
  'bin', 'onnx', 'pt', 'pth', 'h5', 'npy', 'npz', 'safetensors', 'gguf', 'parquet',
]

function attributeLineFor(ext: string): string {
  return `*.${ext} filter=lfs diff=lfs merge=lfs -text`
}

/** The managed `.gitattributes` block (header + curated patterns + footer). */
export function buildManagedAttributesBlock(): string {
  return [ATTR_HEADER, ...DEFAULT_LFS_EXTENSIONS.map(attributeLineFor), ATTR_FOOTER].join('\n')
}

/**
 * Write/refresh the Shogo-managed block in `<workspaceDir>/.gitattributes`,
 * preserving any user-authored entries outside the markers. Idempotent.
 */
export function writeManagedGitAttributes(workspaceDir: string): void {
  const attrPath = join(workspaceDir, '.gitattributes')
  let existing = ''
  try {
    existing = readFileSync(attrPath, 'utf-8')
  } catch {
    existing = ''
  }
  const start = existing.indexOf(ATTR_HEADER)
  if (start !== -1) {
    const end = existing.indexOf(ATTR_FOOTER)
    if (end !== -1) {
      existing = existing.slice(0, start) + existing.slice(end + ATTR_FOOTER.length)
    }
  }
  existing = existing.replace(/\n{3,}/g, '\n\n').trim()
  const next = [existing, buildManagedAttributesBlock()].filter(Boolean).join('\n\n') + '\n'
  writeFileSync(attrPath, next)
}

// ---------------------------------------------------------------------------
// git invocation
// ---------------------------------------------------------------------------

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: string[] = []
    const err: string[] = []
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (c: string) => out.push(c))
    child.stderr.on('data', (c: string) => err.push(c))
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error(`git ${args.join(' ')} timed out after ${GIT_TIMEOUT_MS}ms`))
    }, GIT_TIMEOUT_MS)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout: out.join(''), stderr: err.join('') })
    })
  })
}

// ---------------------------------------------------------------------------
// Repo setup (pod side, git_only + LFS_ENABLED only)
// ---------------------------------------------------------------------------

/**
 * Configure `<workspaceDir>` for Git LFS: enable the per-repo filter with
 * smudge skipped (content is materialized explicitly via {@link lfsPull}),
 * and write the managed `.gitattributes`. Idempotent and best-effort — a
 * failure here must never crash the pod, just disable LFS for the session.
 */
export async function ensureLfsRepoSetup(
  workspaceDir: string,
  opts: { logger?: Logger } = {},
): Promise<boolean> {
  const logger = opts.logger ?? console
  if (!existsSync(join(workspaceDir, '.git'))) return false
  try {
    // `--local --skip-smudge` is belt-and-suspenders on top of the image's
    // `git lfs install --system --skip-smudge`; it makes local dev (no system
    // install) behave identically to production.
    await runGit(['lfs', 'install', '--local', '--skip-smudge'], workspaceDir)
    writeManagedGitAttributes(workspaceDir)
    return true
  } catch (err: any) {
    logger.warn(`[lfs] repo setup failed: ${err?.message ?? err}`)
    return false
  }
}

/**
 * Track any file larger than `thresholdBytes` that isn't already matched by
 * an LFS pattern, by appending a path-specific rule to `.gitattributes`.
 * Preserves the legacy "offload anything over the threshold" behavior for
 * extensions outside {@link DEFAULT_LFS_EXTENSIONS}. Best-effort.
 *
 * Returns the number of newly-tracked paths.
 */
export async function autoTrackLargeFiles(
  workspaceDir: string,
  thresholdBytes: number = largeFileThreshold(),
  opts: { logger?: Logger } = {},
): Promise<number> {
  const logger = opts.logger ?? console
  if (!existsSync(join(workspaceDir, '.git'))) return 0
  let tracked = 0
  const candidates = classifyLargeFiles(workspaceDir, thresholdBytes)
  for (const rel of candidates) {
    const relPosix = rel.split(/[\\/]/).join('/')
    try {
      const attr = await runGit(['check-attr', 'filter', '--', relPosix], workspaceDir)
      if (attr.stdout.includes(': filter: lfs')) continue // already LFS-tracked
      const res = await runGit(['lfs', 'track', '--', relPosix], workspaceDir)
      if (res.exitCode === 0) tracked++
    } catch (err: any) {
      logger.warn(`[lfs] auto-track failed for ${relPosix}: ${err?.message ?? err}`)
    }
  }
  if (tracked) logger.log(`[lfs] auto-tracked ${tracked} large file(s) over ${thresholdBytes}B`)
  return tracked
}

// ---------------------------------------------------------------------------
// Migration off the legacy size-based offload (`large-file-sync.ts`)
// ---------------------------------------------------------------------------

/**
 * One-time, idempotent migration of a project from the legacy `assets/`
 * offload to Git LFS. The managed block in `.git/info/exclude` marks a
 * not-yet-migrated project; once cleared, this is a no-op.
 *
 * Assumes the legacy assets have already been restored to disk (the boot
 * sequence calls `restoreLargeFiles` first). We simply un-exclude them and
 * LFS-track them; the next sync commits the pointers and {@link lfsPushAll}
 * uploads the bytes. The S3 `assets/` copies are left in place for safety —
 * a later GC pass can reclaim them.
 *
 * Best-effort: never throws.
 */
export async function migrateOffloadedAssetsToLfs(
  workspaceDir: string,
  opts: { thresholdBytes?: number; logger?: Logger } = {},
): Promise<{ migrated: boolean; tracked: number }> {
  const logger = opts.logger ?? console
  if (!existsSync(join(workspaceDir, '.git'))) return { migrated: false, tracked: 0 }
  if (!hasManagedExclude(workspaceDir)) return { migrated: false, tracked: 0 }
  try {
    clearManagedExclude(workspaceDir)
    const tracked = await autoTrackLargeFiles(
      workspaceDir,
      opts.thresholdBytes ?? largeFileThreshold(),
      { logger },
    )
    logger.log(`[lfs] migrated project off legacy asset offload (tracked=${tracked})`)
    return { migrated: true, tracked }
  } catch (err: any) {
    logger.warn(`[lfs] asset migration failed: ${err?.message ?? err}`)
    return { migrated: false, tracked: 0 }
  }
}

// ---------------------------------------------------------------------------
// Object transfer (push / pull) via the API LFS batch endpoint
// ---------------------------------------------------------------------------

export interface LfsRemoteConfig {
  workspaceDir: string
  cloudApiUrl: string
  runtimeAuthSecret: string
  projectId: string
  /** Remote name to (idempotently) point at the smart-HTTP URL. Default `cloud`. */
  remoteName?: string
  logger?: Logger
}

/** Build an {@link LfsRemoteConfig} from the runtime env, or null when unset. */
export function lfsRemoteConfigFromEnv(
  workspaceDir: string,
  logger?: Logger,
): LfsRemoteConfig | null {
  const cloudApiUrl = process.env.SHOGO_API_URL
  const runtimeAuthSecret = process.env.RUNTIME_AUTH_SECRET
  const projectId = process.env.PROJECT_ID
  if (!cloudApiUrl || !runtimeAuthSecret || !projectId) return null
  return { workspaceDir, cloudApiUrl, runtimeAuthSecret, projectId, logger }
}

/** Ensure a remote named `remoteName` points at the project's smart-HTTP URL. */
async function ensureCloudRemote(cfg: LfsRemoteConfig): Promise<string> {
  const remote = cfg.remoteName ?? 'cloud'
  const url = buildGitUrl(cfg.cloudApiUrl, cfg.projectId)
  const probe = await runGit(['remote', 'get-url', remote], cfg.workspaceDir)
  if (probe.exitCode === 0) {
    if (probe.stdout.trim() !== url) {
      await runGit(['remote', 'set-url', remote, url], cfg.workspaceDir)
    }
  } else {
    await runGit(['remote', 'add', remote, url], cfg.workspaceDir)
  }
  return remote
}

/** Per-invocation `-c` overrides: explicit LFS url + bearer auth (never persisted). */
function lfsConfigArgs(cfg: LfsRemoteConfig): string[] {
  const lfsUrl = buildLfsEndpointUrl(cfg.cloudApiUrl, cfg.projectId)
  const header = `http.extraHeader=Authorization: Bearer ${cfg.runtimeAuthSecret}`
  return ['-c', `lfs.url=${lfsUrl}`, '-c', header]
}

/**
 * Upload all local LFS objects to OCI via the batch endpoint. The server
 * dedups (objects it already has return no upload action), so re-running is
 * cheap. Returns true on success; never throws (durability falls back to the
 * `.git` tarball when this fails — see {@link persistRepoToStore}).
 */
export async function lfsPushAll(cfg: LfsRemoteConfig): Promise<boolean> {
  const logger = cfg.logger ?? console
  if (!existsSync(join(cfg.workspaceDir, '.git'))) return false
  try {
    const remote = await ensureCloudRemote(cfg)
    const res = await runGit(
      [...lfsConfigArgs(cfg), 'lfs', 'push', '--all', remote],
      cfg.workspaceDir,
    )
    if (res.exitCode !== 0) {
      logger.warn(`[lfs] push failed (${res.exitCode}): ${(res.stderr || '').slice(0, 400)}`)
      return false
    }
    return true
  } catch (err: any) {
    logger.warn(`[lfs] push threw: ${err?.message ?? err}`)
    return false
  }
}

/**
 * Fetch the LFS objects referenced by the current checkout and materialize
 * them into the working tree (`git lfs pull` = fetch + checkout). Used on
 * cold start after the `.git` tarball is restored. Best-effort.
 */
export async function lfsPull(cfg: LfsRemoteConfig): Promise<boolean> {
  const logger = cfg.logger ?? console
  if (!existsSync(join(cfg.workspaceDir, '.git'))) return false
  try {
    const remote = await ensureCloudRemote(cfg)
    const res = await runGit(
      [...lfsConfigArgs(cfg), 'lfs', 'pull', remote],
      cfg.workspaceDir,
    )
    if (res.exitCode !== 0) {
      logger.warn(`[lfs] pull failed (${res.exitCode}): ${(res.stderr || '').slice(0, 400)}`)
      return false
    }
    return true
  } catch (err: any) {
    logger.warn(`[lfs] pull threw: ${err?.message ?? err}`)
    return false
  }
}
