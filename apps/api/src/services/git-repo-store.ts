// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Durable git repo store — API-side HYDRATE-ONLY.
 *
 * In the pod-owned `git_only` model the agent-runtime pod is the
 * authoritative owner of a project's git repo and persists its own `.git`
 * to OCI Object Storage (see packages/shared-runtime/src/repo-store.ts)
 * under
 *
 *   key: `<projectId>/repo.git.tar.gz`
 *
 * The API is stateless (no persistent workspace volume), so it has no repo
 * of its own. When it needs to serve a read — the checkpoint graph / diff /
 * commit / status endpoints (checkpoints.ts), or an external VPS `git clone`
 * via the smart-HTTP backend (git-http.ts) — it hydrates the pod-persisted
 * `.git` onto its ephemeral fs on demand and serves from that transient
 * copy. It NEVER persists: durability is owned entirely by the pod, and an
 * API-side write would clobber the authoritative object.
 *
 * Only `.git` is stored (text/source only — large/binary assets are
 * S3-offloaded separately, see packages/shared-runtime/src/large-file-sync.ts),
 * so the tarball stays small. On hydrate we extract `.git` and restore the
 * working tree (`git reset --hard`) so `git status` and the smart-HTTP
 * upload-pack work.
 */

import { spawn } from '@shogo/shared-runtime/child-process'
import {
  materializeRepoFromBundles,
  parseRepoManifest,
  type RepoManifest,
} from '@shogo/shared-runtime/repo-bundles'
import { existsSync, mkdirSync, createWriteStream, renameSync, rmSync } from 'fs'
import { unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

// =============================================================================
// S3 client (mirrors apps/api/src/routes/publish.ts + s3-sync env contract)
// =============================================================================

let _s3: S3Client | null = null
function getS3(): S3Client | null {
  if (!process.env.S3_WORKSPACES_BUCKET) return null
  if (_s3) return _s3
  _s3 = new S3Client({
    region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
    ...(process.env.S3_ENDPOINT && {
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    }),
  })
  return _s3
}

function repoKey(projectId: string): string {
  return `${projectId}/repo.git.tar.gz`
}

/**
 * Incremental format (packages/shared-runtime/src/repo-bundles.ts). Once the
 * manifest exists it is authoritative: the legacy tarball is never read in
 * preference to it.
 */
function manifestKey(projectId: string): string {
  return `${projectId}/repo/manifest.json`
}

/** Whether an S3 error means the key is simply absent (not a read failure). */
function isNotFound(err: any): boolean {
  return (
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.$metadata?.httpStatusCode === 404 ||
    /NoSuchKey|NotFound/.test(String(err?.message ?? ''))
  )
}

async function streamToString(body: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

function bundleKey(projectId: string, sha256: string): string {
  return `${projectId}/repo/bundles/${sha256}.bundle`
}

function bucket(): string | undefined {
  return process.env.S3_WORKSPACES_BUCKET
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`)),
    )
  })
}

/**
 * Hydrate from the manifest and its bundles. Returns null only when the project
 * has no manifest, so the caller can use the legacy tarball. A manifest that
 * exists but cannot be read or verified fails closed, never falling back.
 */
async function hydrateFromManifest(
  s3: S3Client,
  b: string,
  projectId: string,
  workspacePath: string,
  hasLocal: boolean,
): Promise<GitRepoStoreResult | null> {
  let manifest: RepoManifest
  let etag: string | undefined
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: b, Key: manifestKey(projectId) }))
    if (!res.Body) return { ok: false, changed: false, reason: 'manifest-empty-body' }
    manifest = parseRepoManifest(JSON.parse(await streamToString(res.Body as Readable)))
    etag = res.ETag
  } catch (err: any) {
    if (isNotFound(err)) return null
    return { ok: false, changed: false, reason: `manifest unreadable: ${err?.message ?? err}` }
  }

  if (hasLocal && etag && localRepoEtag.get(projectId) === etag) {
    return { ok: true, changed: false, reason: 'already-local-fresh' }
  }

  // Build the repo beside the workspace, so the final swap stays on one filesystem.
  const stage = `${workspacePath}-repo-stage-${randomUUID()}`
  const bundleDir = join(tmpdir(), `repo-bundles-${projectId}-${randomUUID()}`)
  try {
    mkdirSync(bundleDir, { recursive: true })
    await materializeRepoFromBundles(stage, manifest, async (entry) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: b, Key: bundleKey(projectId, entry.sha256) }))
      if (!res.Body) throw new Error(`bundle ${entry.sha256} has no body`)
      const file = join(bundleDir, `${entry.sha256}.bundle`)
      await pipeline(res.Body as Readable, createWriteStream(file))
      return file
    })
    if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true })
    rmSync(join(workspacePath, '.git'), { recursive: true, force: true })
    renameSync(join(stage, '.git'), join(workspacePath, '.git'))
    try {
      await run('git', ['reset', '--hard', 'HEAD'], { cwd: workspacePath })
    } catch {
      /* unborn HEAD or detached state — leave tree as-is */
    }
    if (etag) localRepoEtag.set(projectId, etag)
    return { ok: true, changed: true }
  } catch (err: any) {
    return { ok: false, changed: false, reason: err?.message ?? 'bundle-restore-failed' }
  } finally {
    rmSync(stage, { recursive: true, force: true })
    rmSync(bundleDir, { recursive: true, force: true })
  }
}

export interface GitRepoStoreResult {
  ok: boolean
  /** Whether an object existed and was downloaded. */
  changed: boolean
  reason?: string
}

/**
 * Whether the project has a durable git repo in object storage — the
 * authoritative copy the pod-owned backend persists (manifest or legacy
 * tarball, see the module doc). `false` when object storage isn't configured
 * (local dev) or nothing has been persisted yet.
 *
 * External (folder-linked) projects are excluded from the durable backend
 * (`git-http.ts`), so a caller flipping a project to external uses this to
 * refuse rather than silently detach its source of truth.
 */
export async function durableRepoExists(projectId: string): Promise<boolean> {
  const s3 = getS3()
  const b = bucket()
  if (!s3 || !b) return false
  for (const key of [manifestKey(projectId), repoKey(projectId)]) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: b, Key: key }))
      return true
    } catch (err: any) {
      if (isNotFound(err)) continue
      // A read failure is not "no repo": fail closed so a transient S3 error
      // cannot wave through a flip that would detach the repo.
      throw err
    }
  }
  return false
}

/**
 * Per-pod cache of the object ETag the local `.git` was last hydrated from.
 * In the pod-owned model the runtime updates the durable object out-of-band
 * on every turn, so a warm API pod's local copy goes stale. We can't just
 * keep the local `.git` "warm" forever (the old origin-push assumption) —
 * we re-hydrate whenever the object's ETag changes. A HEAD request per read
 * is cheap; a full download only happens when the repo actually advanced.
 */
const localRepoEtag = new Map<string, string>()

/**
 * Hydrate `<workspacePath>/.git` from the pod-persisted object, keeping it
 * fresh. Serves the warm local copy only when the durable object's ETag
 * matches what we last extracted; otherwise re-downloads. No-op
 * (changed=false) when object storage isn't configured or no object exists
 * yet (brand-new project — the pod seeds + persists it on first run).
 */
export async function hydrateRepo(
  projectId: string,
  workspacePath: string,
): Promise<GitRepoStoreResult> {
  const s3 = getS3()
  const b = bucket()
  const hasLocal = existsSync(join(workspacePath, '.git'))

  if (!s3 || !b) {
    // No object storage: serve whatever's on disk (e.g. local dev).
    return { ok: true, changed: false, reason: hasLocal ? 'already-local' : 'no-object-storage' }
  }

  const fromManifest = await hydrateFromManifest(s3, b, projectId, workspacePath, hasLocal)
  if (fromManifest) return fromManifest

  // Cheap freshness probe: if our warm local copy matches the durable
  // object's current ETag, serve it without re-downloading.
  let etag: string | undefined
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: b, Key: repoKey(projectId) }))
    etag = head.ETag
  } catch {
    // No durable repo yet — brand-new project. Serve local if present.
    return { ok: true, changed: false, reason: hasLocal ? 'already-local' : 'no-remote-repo' }
  }
  if (hasLocal && etag && localRepoEtag.get(projectId) === etag) {
    return { ok: true, changed: false, reason: 'already-local-fresh' }
  }

  let body: Readable
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: b, Key: repoKey(projectId) }))
    if (!res.Body) return { ok: true, changed: false, reason: 'empty-body' }
    body = res.Body as Readable
  } catch {
    return { ok: true, changed: false, reason: hasLocal ? 'already-local' : 'no-remote-repo' }
  }

  if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true })

  const tmpFile = join(tmpdir(), `repo-${projectId}-${randomUUID()}.tar.gz`)
  try {
    await pipeline(body, createWriteStream(tmpFile))
    // Drop the stale `.git` before extracting the newer one so deleted refs
    // (e.g. branches removed on the pod) don't linger.
    if (hasLocal) {
      try { rmSync(join(workspacePath, '.git'), { recursive: true, force: true }) } catch { /* ignore */ }
    }
    await run('tar', ['-xzf', tmpFile, '-C', workspacePath])
    // Reconstruct the working tree from HEAD so `git status` / upload-pack
    // work. Safe no-op if HEAD is unborn.
    try {
      await run('git', ['reset', '--hard', 'HEAD'], { cwd: workspacePath })
    } catch {
      /* unborn HEAD or detached state — leave tree as-is */
    }
    if (etag) localRepoEtag.set(projectId, etag)
    return { ok: true, changed: true }
  } catch (err: any) {
    return { ok: false, changed: false, reason: err?.message ?? 'extract-failed' }
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}
