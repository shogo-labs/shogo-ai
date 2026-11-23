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
 * `-c http.<api-origin>/.extraHeader=...` and the LFS endpoint via `-c lfs.url=...`, so
 * neither the token nor an environment-specific URL is ever persisted into
 * `.git/config` (which rides along in the durable `.git` tarball).
 *
 * Smudge is skipped globally in the pod image (`git lfs install --system
 * --skip-smudge`): checkout/`reset --hard` leaves pointers (fast, no
 * network), and the runtime materializes content deterministically with an
 * explicit {@link lfsPull}.
 */

import { spawn } from './child-process'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { isObjectNotFound } from './s3-object'
import { parseByteRange } from './byte-range'

import {
  classifyLargeFiles,
  largeFileThreshold,
  hasManagedExclude,
  clearManagedExclude,
} from './large-file-sync'
import { directorySizeBytes, isShogoRuntimeState, resolveGitDir } from './shogo-state-paths'

type Logger = Pick<Console, 'log' | 'warn' | 'error'>

const GIT_TIMEOUT_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Storage layout (shared API <-> pod contract)
// ---------------------------------------------------------------------------

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

interface GitBufferResult {
  exitCode: number
  stdout: Buffer
  stderr: string
}

function runGitBuffer(
  args: string[],
  cwd: string,
  opts: { input?: Buffer; timeoutMs?: number } = {},
): Promise<GitBufferResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: string[] = []
    child.stdout?.on('data', (c: Buffer) => out.push(c))
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (c: string) => err.push(c))
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out), stderr: err.join('') })
    })
    if (opts.input && child.stdin) {
      // git can exit before it reads stdin — `fatal: not a git repository`, a
      // failed `cat-file`, a killed child. The pending write then fails with
      // EPIPE, and an unhandled 'error' on a stream is an *uncaught exception*:
      // on Linux it arrives as a next-tick throw that takes down whatever is
      // running (in CI: the publish-artifact test, right after its request). The
      // exit code already says what happened, so the failed write is expected
      // and carries no information the caller needs.
      child.stdin.on('error', () => {})
      child.stdin.end(opts.input)
    }
  })
}

function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: string[] = []
    const err: string[] = []
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (c: string) => out.push(c))
    child.stderr?.on('data', (c: string) => err.push(c))
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
// Repo setup (pod side, git_only only)
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
 * Skips Shogo runtime state outright (SHO-105): LFS-tracking
 * `.shogo/sessions.db-wal` wrote a fresh, uncompressed object on every single
 * turn — 165 GB of `.git/lfs` in the reported bug — and skips anything git
 * already ignores, since tracking a path git will never stage only bloats
 * `.gitattributes`.
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
  if (lfsOverBudget(workspaceDir, { logger })) {
    await pruneLfsBudget(workspaceDir, logger)
    return 0
  }
  let tracked = 0
  const candidates = classifyLargeFiles(workspaceDir, thresholdBytes)
  for (const rel of candidates) {
    const relPosix = rel.split(/[\\/]/).join('/')
    if (isShogoRuntimeState(relPosix)) continue
    try {
      const ignored = await runGit(['check-ignore', '-q', '--', relPosix], workspaceDir)
      if (ignored.exitCode === 0) continue
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
// Local LFS budget
// ---------------------------------------------------------------------------

/** Default cap on a repo's local `.git/lfs` in gigabytes. */
export const DEFAULT_LFS_BUDGET_GB = 4

/** The local LFS budget in bytes (`SHOGO_LFS_BUDGET_GB`, default 4 GB). */
export function lfsBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseFloat(env.SHOGO_LFS_BUDGET_GB || '')
  const gb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LFS_BUDGET_GB
  return gb * 1024 * 1024 * 1024
}

/** True when `<workspaceDir>/.git/lfs` already exceeds {@link lfsBudgetBytes}. */
export function lfsOverBudget(
  workspaceDir: string,
  opts: { env?: NodeJS.ProcessEnv; logger?: Logger } = {},
): boolean {
  const logger = opts.logger ?? console
  const gitDir = resolveGitDir(workspaceDir)
  if (!gitDir) return false
  const lfsDir = join(gitDir, 'lfs')
  const bytes = directorySizeBytes(lfsDir)
  if (bytes <= lfsBudgetBytes(opts.env)) return false
  logger.warn(
    `[lfs] ${workspaceDir}: local LFS store is ${(bytes / 1e9).toFixed(1)}GB over the ` +
      `${(lfsBudgetBytes(opts.env) / 1e9).toFixed(1)}GB budget — tracking nothing new`,
  )
  return true
}

/**
 * Free what nothing references, for a repo already over budget. `--force` is
 * required: without it git-lfs keeps objects younger than its own grace period,
 * which is every object a runaway `.shogo/*` rule just wrote.
 */
export async function pruneLfsBudget(workspaceDir: string, logger: Logger = console): Promise<boolean> {
  if (!existsSync(join(workspaceDir, '.git'))) return false
  const res = await runGit(['lfs', 'prune', '--force'], workspaceDir)
  if (res.exitCode !== 0) {
    logger.warn(`[lfs] prune failed (${res.exitCode}): ${(res.stderr || '').slice(0, 400)}`)
    return false
  }
  return true
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

/**
 * Per-invocation `-c` overrides: explicit LFS url + bearer auth (never persisted).
 *
 * The bearer is scoped to the API origin. Unscoped, git-lfs also sends it on
 * the presigned object-storage transfers, which reject any `Authorization`
 * header that is not their own signature. The API has no locks endpoint.
 */
export function lfsConfigArgs(cfg: LfsRemoteConfig): string[] {
  const lfsUrl = buildLfsEndpointUrl(cfg.cloudApiUrl, cfg.projectId)
  const apiOrigin = `${new URL(cfg.cloudApiUrl).origin}/`
  const header = `http.${apiOrigin}.extraHeader=Authorization: Bearer ${cfg.runtimeAuthSecret}`
  return ['-c', `lfs.url=${lfsUrl}`, '-c', header, '-c', 'lfs.locksverify=false']
}

/**
 * Upload all local LFS objects to OCI via the batch endpoint. The server
 * dedups (objects it already has return no upload action), so re-running is
 * cheap. Returns true on success; never throws (durability falls back to the
 * `.git` tarball when this fails — see {@link persistRepoToStore}).
 *
 * Prefer {@link lfsPushIncremental} for a save: this walks every ref's whole
 * history, which is what made a media-heavy workspace time out on every save
 * (SHO-442).
 */
export async function lfsPushAll(cfg: LfsRemoteConfig): Promise<boolean> {
  const logger = cfg.logger ?? console
  try {
    await lfsPushIncremental(cfg, { tips: null, logger })
    return true
  } catch (err: any) {
    logger.warn(`[lfs] push failed (${err?.reason ?? 'other'}): ${String(err?.message ?? err).slice(0, 400)}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Incremental, resumable push (SHO-442)
// ---------------------------------------------------------------------------
//
// `git lfs push --all` re-walks every ref's whole history and batch-checks
// every object on every save. A media-heavy workspace takes minutes, the host
// gave up at 60 s, and the next save started again from zero — every save
// failed, forever. What we do instead:
//
//   1. find the LFS oids reachable from commits the durable repo does not
//      already have (`git rev-list --objects --all --not <tips>`),
//   2. push exactly those, in chunks, with `git lfs push --object-id`,
//   3. treat an object whose file is gone locally but that the server already
//      has as done (a cold boot only pulls HEAD's objects),
//   4. and never fail the export because an object is missing on both sides:
//      name its paths, record them, and export the history anyway. History
//      must never be held back for a lost blob.

/** Why an LFS push failed. Carried in the export's 503 body and in the logs. */
export type LfsFailureReason = 'auth' | 'timeout' | 'missing-objects' | 'network' | 'presign' | 'other'

/** A pointer the repo references whose bytes are on neither side. */
export interface LfsMissingObject {
  oid: string
  paths: string[]
}

/** A push that could not complete. `stderr` is the untruncated git-lfs output. */
export class LfsPushError extends Error {
  constructor(
    message: string,
    readonly reason: LfsFailureReason,
    readonly stderr: string = '',
    readonly missing: LfsMissingObject[] = [],
  ) {
    super(message)
  }
}

/**
 * Classify a `git lfs` / batch-API failure from its own output. The incident's
 * `lfs-push-failed` was opaque because only the code reached the host.
 */
export function classifyLfsFailure(stderr: string, status?: number): LfsFailureReason {
  const s = stderr || ''
  if (/Unable to (find source for object|stat local media path)|missing object|object does not exist|No such file or directory/i.test(s)) {
    return 'missing-objects'
  }
  if (/timed out|timeout|deadline exceeded|operation was canceled|i\/o timeout/i.test(s)) return 'timeout'
  if (/SignatureDoesNotMatch|Request has expired|ExpiredToken|presign|X-Amz-Signature/i.test(s)) return 'presign'
  if (status === 401 || status === 403 || /401|403|Unauthorized|Forbidden|Authentication|Bad credentials|Permission denied|access denied/i.test(s)) {
    return 'auth'
  }
  if (/Could not resolve|Connection refused|connection reset|ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket hang up|TLS|network|502|503|504/i.test(s)) {
    return 'network'
  }
  return 'other'
}

const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1'
/** Pointer blobs are tiny; anything bigger is a pre-LFS file that git will not filter. */
const LFS_POINTER_MAX_BYTES = 1024
/** Objects per `git lfs push --object-id` / batch request. */
export const LFS_PUSH_CHUNK = 100

export interface LfsObjectRef {
  oid: string
  size: number
  paths: string[]
}

/** Parse a git-lfs pointer blob. Null for anything else, so a pre-LFS binary file is never mistaken for one. */
export function parseLfsPointer(content: string): { oid: string; size: number } | null {
  if (!content.startsWith(LFS_POINTER_HEADER)) return null
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(content)
  const size = /^size (\d+)$/m.exec(content)
  if (!oid || !size) return null
  return { oid: oid[1], size: Number(size[1]) }
}

/** On-disk path of an LFS object inside the repo's local store. */
export function localLfsObjectPath(workspaceDir: string, oid: string): string | null {
  const gitDir = resolveGitDir(workspaceDir)
  if (!gitDir) return null
  return join(gitDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid)
}

/** Whether the object's bytes are in this repo's local LFS store. */
export function hasLocalLfsObject(workspaceDir: string, oid: string): boolean {
  const p = localLfsObjectPath(workspaceDir, oid)
  return !!p && existsSync(p)
}

/**
 * Keep only the paths `.gitattributes` marks `filter=lfs`.
 *
 * Exported for `S3Sync`, which writes those files into `project-src.tar.gz` as
 * pointer text instead of shipping the bytes a second time (SHO-478).
 */
export async function lfsTrackedPaths(workspaceDir: string, paths: string[]): Promise<Set<string>> {
  const tracked = new Set<string>()
  if (!paths.length) return tracked
  const input = Buffer.from(paths.join('\0') + '\0')
  const res = await runGitBuffer(['check-attr', '--stdin', '-z', 'filter'], workspaceDir, { input })
  if (res.exitCode !== 0) return tracked
  const parts = res.stdout.toString('utf-8').split('\0')
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 1] === 'filter' && parts[i + 2] === 'lfs') tracked.add(parts[i])
  }
  return tracked
}

/** Read every blob of `shas` in one `git cat-file --batch`. */
async function readBlobs(workspaceDir: string, shas: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  if (!shas.length) return out
  const res = await runGitBuffer(['cat-file', '--batch'], workspaceDir, {
    input: Buffer.from(shas.join('\n') + '\n'),
  })
  if (res.exitCode !== 0) throw new Error(`git cat-file --batch failed: ${res.stderr.slice(0, 200)}`)
  let buf = res.stdout
  let at = 0
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at)
    if (nl === -1) break
    const header = buf.toString('utf-8', at, nl).split(' ')
    at = nl + 1
    if (header.length < 3) continue // `<sha> missing`
    const size = Number(header[2])
    if (!Number.isFinite(size)) continue
    if (header[1] === 'blob') out.set(header[0], buf.subarray(at, at + size))
    at += size + 1
  }
  return out
}

/**
 * LFS objects referenced by the commits in `tips..HEAD`-equivalent: every
 * object reachable from a ref but not from the durable tips. `tips: null`
 * scans everything (base exports, compaction, {@link lfsPushAll}).
 *
 * One `rev-list`, one `check-attr`, one `cat-file`: no `git lfs` walk over
 * history, and we get the paths for free — which is what lets a missing object
 * be reported as files rather than a hash.
 */
export async function lfsObjectsInRange(
  workspaceDir: string,
  tips: string[] | null,
): Promise<LfsObjectRef[]> {
  if (!existsSync(join(workspaceDir, '.git'))) return []
  const args = ['rev-list', '--objects', '--all']
  if (tips?.length) args.push('--not', ...tips)
  const listed = await runGit(args, workspaceDir)
  if (listed.exitCode !== 0) {
    throw new LfsPushError(
      `git rev-list failed (${listed.exitCode})`,
      classifyLfsFailure(listed.stderr),
      listed.stderr,
    )
  }
  const blobPaths = new Map<string, Set<string>>()
  for (const line of listed.stdout.split('\n')) {
    if (!line) continue
    const sp = line.indexOf(' ')
    if (sp === -1) continue // a commit or tree without a path
    const sha = line.slice(0, sp)
    blobPaths.set(sha, (blobPaths.get(sha) ?? new Set()).add(line.slice(sp + 1)))
  }
  if (blobPaths.size === 0) return []

  const candidates = [...blobPaths.keys()]
  const tracked = await lfsTrackedPaths(workspaceDir, candidates.flatMap((sha) => [...(blobPaths.get(sha) ?? [])]))
  const wanted = candidates.filter((sha) => [...(blobPaths.get(sha) ?? [])].some((p) => tracked.has(p)))
  if (wanted.length === 0) return []

  const blobs = await readBlobs(workspaceDir, wanted)
  const byOid = new Map<string, LfsObjectRef>()
  for (const [sha, body] of blobs) {
    if (body.length > LFS_POINTER_MAX_BYTES) continue
    const pointer = parseLfsPointer(body.toString('utf-8'))
    if (!pointer) continue
    const paths = byOid.get(pointer.oid)?.paths ?? []
    for (const p of blobPaths.get(sha) ?? []) if (!paths.includes(p)) paths.push(p)
    byOid.set(pointer.oid, { oid: pointer.oid, size: pointer.size, paths })
  }
  return [...byOid.values()]
}

/**
 * Which of `objects` the server already holds. The batch API answers an upload
 * request for an object it has with no `actions`, which is exactly the question
 * "do you already have these bytes?" — one request for the chunk.
 */
export async function lfsRemoteHasObjects(
  cfg: LfsRemoteConfig,
  objects: Array<{ oid: string; size: number }>,
): Promise<Set<string>> {
  const present = new Set<string>()
  for (let i = 0; i < objects.length; i += LFS_PUSH_CHUNK) {
    const chunk = objects.slice(i, i + LFS_PUSH_CHUNK)
    const url = `${buildLfsEndpointUrl(cfg.cloudApiUrl, cfg.projectId)}/objects/batch`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.runtimeAuthSecret}`,
          Accept: 'application/vnd.git-lfs+json',
          'Content-Type': 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({
          operation: 'upload',
          transfers: ['basic'],
          objects: chunk.map((o) => ({ oid: o.oid, size: o.size })),
        }),
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      })
    } catch (err: any) {
      throw new LfsPushError(
        `lfs batch request failed: ${err?.message ?? err}`,
        /timeout|abort/i.test(String(err?.name ?? err?.message)) ? 'timeout' : 'network',
        String(err?.message ?? err),
      )
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 400)
      throw new LfsPushError(`lfs batch check failed (${res.status})`, classifyLfsFailure(text, res.status), text)
    }
    const body = (await res.json().catch(() => null)) as { objects?: Array<{ oid?: unknown; actions?: unknown }> } | null
    for (const o of body?.objects ?? []) {
      if (typeof o?.oid !== 'string') continue
      if (!o.actions || typeof o.actions !== 'object') present.add(o.oid)
    }
  }
  return present
}

/** Upload exactly `oids` with `git lfs push --object-id`, in chunks. */
export async function pushLfsObjectIds(cfg: LfsRemoteConfig, oids: string[]): Promise<void> {
  if (!oids.length) return
  const remote = await ensureCloudRemote(cfg)
  for (let i = 0; i < oids.length; i += LFS_PUSH_CHUNK) {
    const chunk = oids.slice(i, i + LFS_PUSH_CHUNK)
    const res = await runGit([...lfsConfigArgs(cfg), 'lfs', 'push', '--object-id', remote, ...chunk], cfg.workspaceDir)
    if (res.exitCode !== 0) {
      const stderr = res.stderr || res.stdout || ''
      throw new LfsPushError(
        `git lfs push failed (${res.exitCode})`,
        classifyLfsFailure(stderr),
        stderr.slice(0, 16_000),
      )
    }
  }
}

export interface LfsPushProgress {
  total: number
  pushed: number
  skipped: number
  missing: LfsMissingObject[]
}

/** Same shape as the progress the job reports; a completed push is its own result. */
export type LfsPushResult = LfsPushProgress

/**
 * Push the LFS objects a repo needs for the commits since `tips`. Idempotent
 * and resumable: everything it does is keyed by content, so an interrupted run
 * picks up where it stopped instead of starting over.
 *
 * Never throws for a missing object — it records the paths instead, so the
 * history still exports.
 */
export async function lfsPushIncremental(
  cfg: LfsRemoteConfig,
  opts: { tips?: string[] | null; logger?: Logger; onProgress?: (p: LfsPushProgress) => void } = {},
): Promise<LfsPushResult> {
  const logger = opts.logger ?? cfg.logger ?? console
  if (!existsSync(join(cfg.workspaceDir, '.git'))) {
    return { total: 0, pushed: 0, skipped: 0, missing: [] }
  }
  // Never upload a runaway local store: if the repo is over budget, free the
  // unreferenced objects first and let the budget gate in
  // `autoTrackLargeFiles` keep it there.
  if (lfsOverBudget(cfg.workspaceDir, { logger })) await pruneLfsBudget(cfg.workspaceDir, logger)

  const objects = await lfsObjectsInRange(cfg.workspaceDir, opts.tips ?? null)
  const progress: LfsPushProgress = { total: objects.length, pushed: 0, skipped: 0, missing: [] }
  if (objects.length === 0) {
    opts.onProgress?.(progress)
    return progress
  }

  const local: LfsObjectRef[] = []
  const absentLocal: LfsObjectRef[] = []
  for (const o of objects) (hasLocalLfsObject(cfg.workspaceDir, o.oid) ? local : absentLocal).push(o)

  // A cold boot pulls only HEAD's objects, so history can reference oids this
  // VM never had. If the server has them, nothing is missing and nothing is
  // uploaded.
  const remoteHas = absentLocal.length ? await lfsRemoteHasObjects(cfg, absentLocal) : new Set<string>()
  for (const o of absentLocal) {
    if (remoteHas.has(o.oid)) progress.skipped++
    else progress.missing.push({ oid: o.oid, paths: o.paths })
  }
  if (progress.missing.length) {
    logger.error(
      `[lfs] ${progress.missing.length} object(s) referenced by history are missing on both sides ` +
        `(${progress.missing.flatMap((m) => m.paths).slice(0, 10).join(', ')}) — exporting the history anyway`,
    )
  }

  const pending = local.map((o) => o.oid)
  for (let i = 0; i < pending.length; i += LFS_PUSH_CHUNK) {
    const chunk = pending.slice(i, i + LFS_PUSH_CHUNK)
    await pushLfsObjectIds(cfg, chunk)
    progress.pushed += chunk.length
    opts.onProgress?.({ ...progress, missing: [...progress.missing] })
  }
  opts.onProgress?.({ ...progress, missing: [...progress.missing] })
  return progress
}

export interface LfsPushJob {
  /** `<tip-hash>@<HEAD>`: two saves with the same durable tips and HEAD share one push. */
  key: string
  startedAt: number
  state: LfsPushProgress & { done: boolean; error?: LfsPushError }
  settled: Promise<void>
}

/**
 * Runs the incremental push as a background job keyed by the export's target
 * tips and HEAD, so a slow push is joined by the next export request instead of
 * started again, and a host that stops waiting cannot make it restart.
 */
export class LfsPushRunner {
  private jobs = new Map<string, LfsPushJob>()
  private completed = new Map<string, string>()
  constructor(private readonly opts: { logger?: Logger; maxAgeMs?: number } = {}) {}

  private tipsKey(cfg: LfsRemoteConfig, tips: string[] | null): string {
    const tipHash = tips?.length ? createHash('sha1').update([...tips].sort().join(',')).digest('hex') : 'full'
    return `${cfg.workspaceDir}:${tipHash}`
  }

  /** Join the running job for these tips, or start one. Already-completed keys settle at once. */
  async run(cfg: LfsRemoteConfig, tips: string[] | null): Promise<LfsPushJob> {
    const logger = this.opts.logger ?? cfg.logger ?? console
    const head = (await runGit(['rev-parse', 'HEAD'], cfg.workspaceDir)).stdout.trim()
    const tipsKey = this.tipsKey(cfg, tips)
    const key = `${tipsKey}@${head}`
    this.prune()

    const running = this.jobs.get(key)
    if (running) return running
    if (this.completed.get(tipsKey) === key) {
      const done: LfsPushJob = {
        key,
        startedAt: Date.now(),
        state: { total: 0, pushed: 0, skipped: 0, missing: [], done: true },
        settled: Promise.resolve(),
      }
      return done
    }

    const state: LfsPushJob['state'] = { total: 0, pushed: 0, skipped: 0, missing: [], done: false }
    const job: LfsPushJob = { key, startedAt: Date.now(), state, settled: Promise.resolve() }
    job.settled = lfsPushIncremental(cfg, {
      tips,
      logger,
      onProgress: (p) => {
        state.total = p.total
        state.pushed = p.pushed
        state.skipped = p.skipped
        state.missing = p.missing
      },
    })
      .then(() => {
        state.done = true
        this.completed.set(tipsKey, key)
        logger.log(`[lfs] pushed ${state.pushed}/${state.total} object(s)${state.skipped ? `, ${state.skipped} already remote` : ''}${state.missing.length ? `, ${state.missing.length} missing` : ''}`)
      })
      .catch((err: unknown) => {
        const error = err instanceof LfsPushError ? err : new LfsPushError(String((err as any)?.message ?? err), 'other', String((err as any)?.stack ?? ''))
        state.error = error
        state.done = true
        logger.warn(`[lfs] push job failed (${error.reason}): ${error.message}`)
      })
    this.jobs.set(key, job)
    job.settled.finally(() => {
      if (this.jobs.get(key) === job) this.jobs.delete(key)
    })
    return job
  }

  /** 'pending' when the job is still running after `waitMs`. */
  async settle(job: LfsPushJob, waitMs: number): Promise<'done' | 'failed' | 'pending'> {
    if (!job.state.done && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        job.settled,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs) }),
      ])
      if (timer) clearTimeout(timer)
    }
    if (!job.state.done) return 'pending'
    return job.state.error ? 'failed' : 'done'
  }

  private prune(): void {
    const maxAge = this.opts.maxAgeMs ?? 30 * 60_000
    const now = Date.now()
    for (const [key, job] of this.jobs) if (job.state.done && now - job.startedAt > maxAge) this.jobs.delete(key)
    if (this.completed.size > 64) {
      // Only the newest key per tips key matters; the map itself is pruned by
      // replacement, so cap it rather than track timestamps per entry.
      const keep = [...this.completed.entries()].slice(-32)
      this.completed.clear()
      for (const [k, v] of keep) this.completed.set(k, v)
    }
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

// ---------------------------------------------------------------------------
// Materializing pointer files from the object store (SHO-478)
// ---------------------------------------------------------------------------
//
// `project-src.tar.gz` no longer carries LFS-tracked bytes — they are already
// stored once under `<projectId>/lfs/objects/…`, and shipping them again made
// a 1.76 GB archive of ~15 MB of real source. The archive therefore restores
// those paths as their pointer text, and the bytes are put back on hydrate.
//
// This runs in a published pod, which has no `.git` and never runs the agent,
// so it cannot use `git lfs pull`: it walks the tree, reads only files small
// enough to be a pointer, and streams each object straight from the store.

/**
 * The object-storage surface LFS materialization needs. Structural rather than
 * an `S3Client` so `S3Sync` can pass the client it already has, and a test can
 * pass a plain fake.
 */
export interface LfsObjectStore {
  bucket: string
  client: { send(command: any): Promise<any> }
  /**
   * The object as a **length-known** body the host can serve itself — Bun's
   * native S3 file, whose bytes stay in the store and whose size Bun knows.
   *
   * This is not an optimisation. `Bun.serve` replies to *any* `ReadableStream`
   * body with `Transfer-Encoding: chunked` and drops an explicitly-set
   * `Content-Length`, so piping a `GetObject` body loses the length the HTTP
   * contract (and `<video>` progress/seek) needs. A Blob it can measure is the
   * only body shape that keeps `Content-Length` on the wire; Bun also applies
   * `Range` to it itself and forwards the object's own `Content-Type` and
   * `ETag`. Absent on hosts without `Bun.S3Client` (the node test runner),
   * where the caller falls back to a piped body.
   */
  bodyFile?(key: string): Blob
}

/** One pointer blob found in the working tree. */
export interface LfsPointerFile {
  /** Absolute path of the file holding the pointer text. */
  path: string
  oid: string
  size: number
}

export interface LfsMaterializeResult {
  /** Pointer blobs found in the tree. */
  pointers: number
  /** Objects streamed into place (the file now holds its real bytes). */
  materialized: number
  /** Objects the store does not have, or could not be read (boot continues). */
  missing: number
  /** Objects whose real length disagrees with the pointer's `size`. */
  mismatched: number
}

/** Directories the pointer walk never descends into. */
const LFS_WALK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.shogo',
  '.expo',
  '.metro-cache',
  '.expo-shared',
  '.tmp',
  'chat-files',
])

/** The pointer text git-lfs itself writes for an object. */
export function lfsPointerText(oid: string, size: number): string {
  return `${LFS_POINTER_HEADER}\noid sha256:${oid}\nsize ${size}\n`
}

/**
 * Whether this repo has any `filter=lfs` attribute. The pointer walk is not
 * free on a large tree, and a project that never used LFS can skip it.
 */
export function repoUsesLfs(workspaceDir: string): boolean {
  try {
    return readFileSync(join(workspaceDir, '.gitattributes'), 'utf-8').includes('filter=lfs')
  } catch {
    return false
  }
}

/**
 * Every file under `workspaceDir` whose content is an LFS pointer. Only files
 * at or below {@link LFS_POINTER_MAX_BYTES} are read, so a media-heavy tree
 * costs a `stat` per file and nothing more.
 */
export function findLfsPointerFiles(workspaceDir: string): LfsPointerFile[] {
  const found: LfsPointerFile[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!LFS_WALK_SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        if (statSync(full).size > LFS_POINTER_MAX_BYTES) continue
      } catch {
        continue
      }
      let text: string
      try {
        text = readFileSync(full, 'utf-8')
      } catch {
        continue
      }
      const ptr = parseLfsPointer(text)
      if (ptr) found.push({ path: full, oid: ptr.oid, size: ptr.size })
    }
  }
  walk(workspaceDir)
  return found
}

/**
 * Put the real bytes back for every LFS pointer in `workspaceDir`, streaming
 * each object from `<projectId>/lfs/objects/…` to its path.
 *
 * Best-effort by design: a missing or unreadable object is logged and the boot
 * continues, exactly like a failed `git lfs pull` would. Uses an atomic
 * `.lfs-tmp` rename so a failed transfer never leaves a truncated media file
 * where a pointer used to be.
 */
export async function materializeLfsPointersFromStore(
  workspaceDir: string,
  projectId: string,
  opts: { store?: LfsObjectStore | null; logger?: Logger; concurrency?: number } = {},
): Promise<LfsMaterializeResult> {
  const logger = opts.logger ?? console
  const result: LfsMaterializeResult = { pointers: 0, materialized: 0, missing: 0, mismatched: 0 }
  const store = opts.store ?? null
  if (!store) {
    logger.warn('[lfs] materialize: no object store configured — LFS files stay pointers')
    return result
  }
  if (!repoUsesLfs(workspaceDir)) return result

  const queue = findLfsPointerFiles(workspaceDir)
  result.pointers = queue.length
  if (!queue.length) return result

  const started = Date.now()
  const restore = async (ptr: LfsPointerFile): Promise<void> => {
    const tmp = `${ptr.path}.lfs-tmp`
    try {
      const res = await store.client.send(
        new GetObjectCommand({ Bucket: store.bucket, Key: lfsObjectKey(projectId, ptr.oid) }),
      )
      if (!res?.Body) {
        result.missing++
        logger.warn(`[lfs] materialize: empty body for ${ptr.oid} (${ptr.path})`)
        return
      }
      await pipeline(res.Body as any, createWriteStream(tmp))
      const got = statSync(tmp).size
      if (got !== ptr.size) {
        result.mismatched++
        logger.warn(`[lfs] materialize: ${ptr.path} expected ${ptr.size} bytes, store returned ${got}`)
        rmSync(tmp, { force: true })
        return
      }
      renameSync(tmp, ptr.path)
      result.materialized++
    } catch (err: any) {
      result.missing++
      rmSync(tmp, { force: true })
      logger.warn(`[lfs] materialize: ${ptr.path} not restored (${err?.name ?? 'error'}): ${String(err?.message ?? err).slice(0, 200)}`)
    }
  }

  const workers = Math.max(1, Math.min(opts.concurrency ?? 4, queue.length))
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await restore(next)
    }),
  )

  logger.log(
    `[lfs] materialize: ${result.materialized}/${result.pointers} object(s) restored in ${Date.now() - started}ms` +
      (result.missing || result.mismatched ? ` (missing=${result.missing}, mismatched=${result.mismatched})` : ''),
  )
  return result
}

/**
 * The object store LFS objects live in, from env — the read-side twin of the
 * store `S3Sync` passes to {@link materializeLfsPointersFromStore}.
 *
 * Null when the runtime has no object store configured, so a caller can fall
 * back to serving what it has instead of throwing.
 */
export function lfsObjectStoreFromEnv(env: NodeJS.ProcessEnv = process.env): LfsObjectStore | null {
  const bucket = (env.S3_LFS_BUCKET || env.S3_WORKSPACES_BUCKET || '').trim()
  if (!bucket) return null
  const client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    credentials: env.AWS_ACCESS_KEY_ID
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY || '' }
      : undefined,
  })
  const bodyFile = bunS3BodyFile(bucket, env)
  return { bucket, client, ...(bodyFile ? { bodyFile } : {}) }
}

/**
 * Bun's native S3 file for a key, or `null` on a host without `Bun.S3Client`.
 *
 * A piped `GetObject` body becomes `Transfer-Encoding: chunked` and loses its
 * `Content-Length` under `Bun.serve`, so this is the read shape that keeps the
 * header on the wire (SHO-485, QA round 1). Bun also answers `Range` against it
 * itself and forwards the object's `Content-Type`/`ETag`/`Last-Modified`, which
 * is why the publish path stamps the object's metadata.
 */
function bunS3BodyFile(bucket: string, env: NodeJS.ProcessEnv): ((key: string) => Blob) | null {
  const S3ClientCtor = (globalThis as any).Bun?.S3Client
  if (typeof S3ClientCtor !== 'function') return null
  const client = new S3ClientCtor({
    bucket,
    ...(env.S3_REGION ? { region: env.S3_REGION } : {}),
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    ...(env.AWS_ACCESS_KEY_ID
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY || '' }
      : {}),
  })
  return (key: string) => client.file(key) as Blob
}

/** Whether an `If-None-Match` header names this ETag (weak comparison, list form, `*`). */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  const raw = (ifNoneMatch || '').trim()
  if (!raw) return false
  const bare = etag.replace(/^W\//, '')
  return raw
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .some((part) => part === '*' || part === bare)
}

export type LfsObjectReadResult =
  | {
      status: 'ok'
      /** The object's body — `null` for a `HEAD`, which only needs the headers. */
      body: unknown | null
      /**
       * `true` when `body` is a Blob the host serves with its own
       * `Content-Length` (Bun's S3 file), so the caller must **not** set
       * `Content-Length`/`Content-Type`/`Range` headers over it — Bun answers
       * those from the object and ignores overrides on this body type.
       */
      lengthKnown: boolean
      totalSize: number
      contentLength: number
      contentRange?: string
      etag: string
    }
  | { status: 'not-modified'; etag: string; totalSize: number }
  | { status: 'missing'; etag: string }
  | { status: 'unsatisfiable'; etag: string; totalSize: number }

/**
 * Open an LFS object, optionally ranged, straight from the store.
 *
 * This is what lets a published pod serve media it never wrote to disk
 * (SHO-485): the pointer file under `dist/` names the object, and the bytes
 * come from `<projectId>/lfs/objects/…` one request at a time.
 *
 * The body is a **length-known Blob** (`Bun.s3` file) wherever the host has
 * one, because that is the only body `Bun.serve` answers with a real
 * `Content-Length` — a piped stream becomes chunked and loses the header
 * (QA round 1). The piped `GetObject` remains as the fallback for a host
 * without `Bun.S3Client`, and `lengthKnown` tells the caller which it got.
 *
 * One `HEAD` (or `GetObject` on the fallback) precedes a ranged read: it
 * answers existence (404), the store's own `ETag` — which is what a
 * length-known body serves, so a `304` compares like with like — and the real
 * size the range math and `416` need.
 */
export async function openLfsObjectStream(opts: {
  projectId: string
  oid: string
  /** The pointer's declared size — used before the store answers, and for a `HEAD`-less fallback. */
  size: number
  store: LfsObjectStore
  /** Raw `Range` request header. */
  range?: string | null
  /** Raw `If-None-Match` request header. */
  ifNoneMatch?: string | null
  /** `HEAD`: confirm the object is there, return no body. */
  head?: boolean
}): Promise<LfsObjectReadResult> {
  const declaredEtag = `"${opts.oid}"`
  const key = lfsObjectKey(opts.projectId, opts.oid)

  let etag = declaredEtag
  let totalSize = opts.size
  let exists = true
  try {
    const head = await opts.store.client.send(new HeadObjectCommand({ Bucket: opts.store.bucket, Key: key }))
    etag = typeof head?.ETag === 'string' && head.ETag ? head.ETag : declaredEtag
    const stored = Number(head?.ContentLength)
    if (Number.isFinite(stored)) totalSize = stored
  } catch (err) {
    if (isObjectNotFound(err)) {
      exists = false
    } else {
      throw err
    }
  }
  if (!exists) return { status: 'missing', etag }

  if (etagMatches(opts.ifNoneMatch, etag)) return { status: 'not-modified', etag, totalSize }

  // The same `Range` parser every file-serving route uses (byte-range.ts), so a
  // `<video>` seeks the same way against a stored object as against a disk file.
  const parsedRange = parseByteRange(opts.range, totalSize)
  if (parsedRange.kind === 'unsatisfiable') return { status: 'unsatisfiable', etag, totalSize }
  const range = parsedRange.kind === 'range' ? parsedRange : null
  const contentRange = range ? `bytes ${range.start}-${range.end}/${totalSize}` : undefined
  const contentLength = range ? range.end - range.start + 1 : totalSize

  // A `HEAD` needs no body from either path; the caller answers it with the
  // headers alone. (Bun also handles HEAD on a length-known body itself, but
  // then it would have to talk to the store to learn the length.)
  if (opts.head) {
    return { status: 'ok', body: null, lengthKnown: true, totalSize, contentLength, contentRange, etag }
  }

  // Length-known body: the whole object, and Bun applies the request's Range
  // itself (slice-free) so the 206 and its Content-Range come out of the store
  // the same way they do for a file on disk.
  const bodyFile = opts.store.bodyFile?.(key)
  if (bodyFile) {
    return { status: 'ok', body: bodyFile, lengthKnown: true, totalSize, contentLength, contentRange, etag }
  }

  try {
    const res = await opts.store.client.send(
      new GetObjectCommand({
        Bucket: opts.store.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    )
    if (!res?.Body) return { status: 'missing', etag }
    const stored = Number(res.ContentLength ?? contentLength)
    return {
      status: 'ok',
      body: res.Body,
      lengthKnown: false,
      // The store's length wins over the pointer's for the body we are handing
      // back; a mismatch means a corrupt object, and it must not become a
      // truncated response.
      totalSize: range ? totalSize : stored,
      contentLength: stored,
      contentRange,
      etag,
    }
  } catch (err: any) {
    if (isObjectNotFound(err)) return { status: 'missing', etag }
    throw err
  }
}
