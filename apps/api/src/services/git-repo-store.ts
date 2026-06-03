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

import { spawn } from 'child_process'
import { existsSync, mkdirSync, createWriteStream, rmSync } from 'fs'
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

export interface GitRepoStoreResult {
  ok: boolean
  /** Whether an object existed and was downloaded. */
  changed: boolean
  reason?: string
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
