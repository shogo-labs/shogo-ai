// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * marketplace-snapshot-storage.service
 *
 * Object-store backing for `MarketplaceListingVersion.workspaceSnapshot*`.
 *
 * Workspace snapshots used to live in a Postgres `jsonb` column. That
 * worked for trivial templates but doesn't scale: every binary in a
 * listing is ~33% bloated by base64, jsonb has practical row-size
 * limits, and we'd be paying database I/O per install. This service
 * moves the bytes to S3 — the version row only carries the object
 * key, the compressed size, and a sha256 checksum.
 *
 * Object layout (under `S3_WORKSPACES_BUCKET`):
 *   marketplace/listings/<listingId>/<version>.tar.gz
 *
 * We deliberately reuse the same bucket the runtime workspace sync
 * uses (`packages/shared-runtime/src/s3-sync.ts`) — same auth, same
 * region, same lifecycle ops surface. The `marketplace/` prefix is
 * the only thing distinguishing tenant workspaces from shared
 * marketplace snapshots, so a future split into a dedicated
 * `S3_MARKETPLACE_BUCKET` is a one-line env change.
 *
 * Format is gzipped tar (system `tar` if available, falling back to
 * `node-tar`). This matches the runtime's existing pipeline so we
 * inherit its MacOS xattr handling and the BENIGN_TAR_STDERR_PATTERNS
 * allowlist when extracting cross-platform archives.
 *
 * Backward compatibility: we keep the legacy `workspaceSnapshot Json?`
 * column for one release as a read-fallback. Callers that previously
 * consumed `version.workspaceSnapshot` should now go through
 * `loadSnapshotFiles` below, which prefers S3 and falls back to the
 * JSON column when the row pre-dates the S3 columns. New writes
 * always populate the S3 columns; the JSON column is left null.
 */

import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import * as tar from 'tar'

// Inlined to avoid a circular import with `marketplace-install.service`,
// which itself depends on this module. The implementation matches
// `marketplace-install.service.getWorkspacesDir()` exactly — keep them
// in sync if the resolution rule ever changes.
const PROJECT_ROOT = resolve(import.meta.dir, '../../../..')
function getWorkspacesDir(): string {
  return process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
}

// ─── Env / client ───────────────────────────────────────────────────

let cachedClient: S3Client | null = null

/**
 * Lazily construct the S3 client. We don't error on missing config at
 * import time so the module is safe to load in environments that
 * never publish snapshots (local mode, tests). Operations that need a
 * client throw if config is missing.
 */
function getClient(): { client: S3Client; bucket: string } {
  const bucket = process.env.S3_WORKSPACES_BUCKET
  if (!bucket) {
    throw new Error(
      'marketplace-snapshot-storage requires S3_WORKSPACES_BUCKET to be set',
    )
  }
  if (cachedClient) return { client: cachedClient, bucket }
  cachedClient = new S3Client(resolveS3ClientConfig(process.env))
  return { client: cachedClient, bucket }
}

/**
 * Pure function that maps env vars to the S3Client constructor
 * config. Extracted so tests can pin the path-style behavior without
 * round-tripping through the real S3Client.
 *
 * Path-style URLs are REQUIRED for every non-AWS S3-compatible
 * backend we run on today (OCI Object Storage S3-compat, MinIO, R2).
 * OCI in particular parses virtual-hosted URLs incorrectly — it
 * interprets the bucket-name subdomain as its tenancy namespace and
 * the first path segment as the bucket, so a request for
 * `bucket=shogo-workspaces-staging, key=marketplace/listings/...`
 * surfaces as `NoSuchBucket: bucket 'marketplace' does not exist in
 * the namespace 'shogo-workspaces-staging'` (this is the staging
 * incident this helper exists to prevent). The endpoint being set is
 * the strongest available "this isn't real AWS" signal, so we force
 * path style whenever it's present. Mirrors the convention in
 * `packages/shared-runtime/src/s3-sync.ts` and
 * `packages/shared-runtime/src/postgres-backup.ts`.
 */
export function resolveS3ClientConfig(env: NodeJS.ProcessEnv): {
  region: string
  endpoint?: string
  forcePathStyle: boolean
} {
  const endpoint = env.S3_ENDPOINT
  const hasCustomEndpoint = !!endpoint
  return {
    region: env.S3_REGION || 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true' || hasCustomEndpoint,
  }
}

/** Visible for tests — drops the cached client so env var changes take effect. */
export function _resetClientForTests(): void {
  cachedClient = null
}

// ─── Exclusion list ────────────────────────────────────────────────
//
// This is the *snapshot* exclusion set (what gets tarballed for S3) —
// it INTENTIONALLY does NOT exclude `dist/` even though
// marketplace-manifest.service's drift-detection set does. The
// bundled first-party templates ship a pre-built `dist/index.html`
// for the canvas's first-paint preview; stripping it leaves the
// install on "Connected" with a blank iframe until Vite cold-starts.
// The post-install drift baseline (computed by
// `computeWorkspaceManifest`) excludes `dist/` separately, so Vite
// rebuilds in the runtime won't trip the drift gate.

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.expo',
  '.metro-cache',
])
const EXCLUDED_FILE_NAMES = new Set([
  '.DS_Store',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
])

function shouldIncludeRelPath(rel: string): boolean {
  if (!rel || rel === '.') return false
  for (const segment of rel.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (EXCLUDED_DIRS.has(segment)) return false
    if (segment.startsWith('.install-')) return false
  }
  const last = rel.split(/[/\\]/).pop() ?? ''
  if (EXCLUDED_FILE_NAMES.has(last)) return false
  return true
}

// ─── Object keys ────────────────────────────────────────────────────

export function snapshotObjectKey(listingId: string, version: string): string {
  // Path components are url-escaped in case a creator manages to land
  // a `/` in their version string (we don't formally restrict the
  // shape today). encodeURIComponent leaves `.` `-` `_` alone so
  // `1.2.3-rc.1` looks natural in the bucket.
  return `marketplace/listings/${encodeURIComponent(listingId)}/${encodeURIComponent(
    version,
  )}.tar.gz`
}

// ─── Tar helpers ────────────────────────────────────────────────────

/**
 * Create a `.tar.gz` of `srcDir` at `archivePath`. We prefer the
 * system `tar` binary because it's significantly faster for large
 * trees and its gzip is multi-threaded; node-tar is the fallback for
 * minimal containers without /usr/bin/tar.
 *
 * Files matching `EXCLUDED_DIRS` / `EXCLUDED_FILE_NAMES` are
 * filtered out via tar's `--exclude` flags; node-tar's filter
 * function handles the same when we fall back.
 */
async function createTarball(srcDir: string, archivePath: string): Promise<void> {
  const excludes = [
    ...[...EXCLUDED_DIRS].map((d) => `--exclude=${d}`),
    ...[...EXCLUDED_FILE_NAMES].map((f) => `--exclude=${f}`),
    '--exclude=.install-*',
  ]
  const sysTar = await trySystemTarCreate(srcDir, archivePath, excludes)
  if (sysTar) return
  await tar.create(
    {
      gzip: true,
      file: archivePath,
      cwd: srcDir,
      portable: true,
      filter: (path) => shouldIncludeRelPath(relative(srcDir, resolve(srcDir, path))),
    },
    ['.'],
  )
}

async function trySystemTarCreate(
  srcDir: string,
  archivePath: string,
  excludes: string[],
): Promise<boolean> {
  return new Promise((resolveDone) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('tar', ['-czf', archivePath, '-C', srcDir, ...excludes, '.'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch {
      resolveDone(false)
      return
    }
    let stderr = ''
    proc.stderr?.on('data', (chunk) => (stderr += chunk.toString()))
    proc.on('error', () => resolveDone(false))
    proc.on('exit', (code) => {
      if (code === 0) {
        resolveDone(true)
      } else {
        // Non-fatal MacOS xattr noise is the most common cause of
        // exit=2 in cross-platform builds — see s3-sync.ts for the
        // canonical allowlist. Here we just fall back to node-tar
        // rather than guess; node-tar always succeeds on archives
        // tar produced.
        if (process.env.MARKETPLACE_TAR_DEBUG) {
          console.warn(`[marketplace-tar] system tar exited ${code}: ${stderr.slice(0, 200)}`)
        }
        resolveDone(false)
      }
    })
  })
}

async function extractTarball(archivePath: string, destDir: string): Promise<void> {
  const sysOk = await trySystemTarExtract(archivePath, destDir)
  if (sysOk) return
  await tar.extract({ file: archivePath, cwd: destDir })
}

async function trySystemTarExtract(archivePath: string, destDir: string): Promise<boolean> {
  return new Promise((resolveDone) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('tar', ['-xzf', archivePath, '-C', destDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch {
      resolveDone(false)
      return
    }
    proc.on('error', () => resolveDone(false))
    proc.on('exit', (code) => resolveDone(code === 0))
  })
}

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// ─── Public API ─────────────────────────────────────────────────────

export interface UploadResult {
  key: string
  bytes: number
  checksum: string
}

/**
 * Tar the on-disk workspace for `projectId`, upload to S3, and return
 * the metadata we persist on the version row. The caller is
 * responsible for the DB write — this service is intentionally
 * storage-only.
 */
export async function uploadProjectSnapshot(
  projectId: string,
  listingId: string,
  version: string,
): Promise<UploadResult> {
  const srcDir = join(getWorkspacesDir(), projectId)
  if (!existsSync(srcDir)) {
    throw new Error(`workspace_missing: ${srcDir}`)
  }
  const work = mkdtempSync(join(tmpdir(), 'mkt-snap-'))
  const archivePath = join(work, 'snapshot.tar.gz')
  try {
    await createTarball(srcDir, archivePath)
    const buf = readFileSync(archivePath)
    const key = snapshotObjectKey(listingId, version)
    const { client, bucket } = getClient()
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buf,
        ContentType: 'application/gzip',
        // Object lock / immutability would go here once we wire the
        // bucket policy. Today we trust admin-only deletes.
        Metadata: { listing: listingId, version },
      }),
    )
    return { key, bytes: buf.byteLength, checksum: sha256Of(buf) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Download the snapshot for `key` and extract it into the project's
 * workspace directory (creating the directory if needed). Used by
 * `installAgent` (fresh install) and `applyUpdate` (force or
 * no-drift).
 *
 * Optional `expectedChecksum` — if provided, we verify the downloaded
 * tarball matches before extraction. Cheap insurance against bucket
 * tampering or partial downloads; the version row already carries
 * the checksum so callers can pass it through transparently.
 */
export async function extractSnapshotToProject(
  key: string,
  destProjectId: string,
  opts: { expectedChecksum?: string | null } = {},
): Promise<void> {
  const buf = await downloadSnapshotBuffer(key, opts.expectedChecksum ?? null)
  const work = mkdtempSync(join(tmpdir(), 'mkt-extract-'))
  const archivePath = join(work, 'snapshot.tar.gz')
  const destDir = join(getWorkspacesDir(), destProjectId)
  try {
    writeFileSync(archivePath, buf)
    mkdirSync(destDir, { recursive: true })
    await extractTarball(archivePath, destDir)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Pull the tarball into memory and return its bytes. Used by
 * `extractSnapshotToProject` and `loadSnapshotFiles`; exposed for
 * tests that want to inspect the raw archive.
 */
export async function downloadSnapshotBuffer(
  key: string,
  expectedChecksum: string | null,
): Promise<Buffer> {
  const { client, bucket } = getClient()
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const body = res.Body
  if (!body) {
    throw new Error(`snapshot_empty_body: ${key}`)
  }
  // The aws-sdk v3 Body is a Node Readable in our environment; convert
  // to a Buffer the obvious way.
  const chunks: Buffer[] = []
  const stream = body as NodeJS.ReadableStream
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  const buf = Buffer.concat(chunks)
  if (expectedChecksum && sha256Of(buf) !== expectedChecksum) {
    throw new Error(`snapshot_checksum_mismatch: ${key}`)
  }
  return buf
}

/**
 * Load a snapshot's file map for code that needs to read the contents
 * directly (the auditor). Internally extracts the tarball into a tmp
 * dir, reads each file once, then cleans up.
 *
 * Returns the same shape `applyWorkspaceSnapshot` consumes:
 *   - utf8 files as plain strings
 *   - binary files as `{ data: <base64>, encoding: 'base64' }`
 */
export async function loadSnapshotFiles(
  key: string,
  expectedChecksum?: string | null,
): Promise<Record<string, string | { data: string; encoding: 'base64' }>> {
  const buf = await downloadSnapshotBuffer(key, expectedChecksum ?? null)
  const work = mkdtempSync(join(tmpdir(), 'mkt-load-'))
  const archivePath = join(work, 'snapshot.tar.gz')
  const extractDir = join(work, 'extract')
  try {
    writeFileSync(archivePath, buf)
    mkdirSync(extractDir, { recursive: true })
    await extractTarball(archivePath, extractDir)
    const out: Record<string, string | { data: string; encoding: 'base64' }> = {}
    walkExtract(extractDir, extractDir, out)
    return out
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function walkExtract(
  absDir: string,
  root: string,
  out: Record<string, string | { data: string; encoding: 'base64' }>,
): void {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name)
    const rel = relative(root, abs)
    if (!shouldIncludeRelPath(rel)) continue
    if (entry.isDirectory()) {
      walkExtract(abs, root, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const stats = statSync(abs)
      // Same 5MB ceiling as snapshotProjectWorkspace — protects audit
      // calls from blowing the prompt budget on a rogue binary.
      if (stats.size > 5 * 1024 * 1024) continue
      const buf = readFileSync(abs)
      const key = rel.split('\\').join('/')
      if (looksBinary(buf)) {
        out[key] = { data: buf.toString('base64'), encoding: 'base64' }
      } else {
        out[key] = buf.toString('utf8')
      }
    } catch {
      // Unreadable files are skipped silently (broken symlinks, perms).
    }
  }
}

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, 4096))
  return probe.includes(0)
}

/**
 * Delete a snapshot from S3. Used when admin rejects a listing or a
 * version is permanently archived. By default we KEEP snapshots even
 * after listing unpublish — installers may still apply updates of
 * older versions — so callers must opt in explicitly.
 */
export async function deleteSnapshot(key: string): Promise<void> {
  const { client, bucket } = getClient()
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

// ─── Test seam ─────────────────────────────────────────────────────

/**
 * Visible for tests only — overrides the lazy client with a stub so
 * unit tests can mock `send()` without monkey-patching `@aws-sdk`.
 * Pass `null` to revert to the real construction path.
 */
export function _setClientForTests(client: S3Client | null): void {
  cachedClient = client
}

// ─── Local FS fallback (rarely useful) ──────────────────────────────

/**
 * Snapshot a project workspace into a local tarball without touching
 * S3 — used by the boot-time backfiller's dry-run mode and by tests
 * that exercise tar+extract without round-tripping through a bucket.
 * Not part of the canonical install/update path.
 */
export async function tarballProjectToFile(
  projectId: string,
  archivePath: string,
): Promise<{ bytes: number; checksum: string }> {
  const srcDir = join(getWorkspacesDir(), projectId)
  if (!existsSync(srcDir)) throw new Error(`workspace_missing: ${srcDir}`)
  await createTarball(srcDir, archivePath)
  const buf = readFileSync(archivePath)
  return { bytes: buf.byteLength, checksum: sha256Of(buf) }
}

/** Public for test parity with the install service's helpers. */
export function copyProjectWorkspace(srcProjectId: string, destProjectId: string): void {
  const root = getWorkspacesDir()
  const srcDir = join(root, srcProjectId)
  const destDir = join(root, destProjectId)
  mkdirSync(destDir, { recursive: true })
  if (!existsSync(srcDir)) return
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => shouldIncludeRelPath(relative(srcDir, src)),
  })
}
