// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host-side fetch + GUARDED write of a project's durable git repo
 * (`{projectId}/repo.git.tar.gz`) — the pod-owned `.git` that `git_only`
 * treats as the per-turn durable artifact.
 *
 * Why this exists separately from the guest's `persistRepoToStore`:
 *   Metal guests deliberately hold no S3 credentials. `build-project-env`
 *   injects the bucket name but not AWS keys, so the guest's direct persist
 *   always fails and `persistAndRecordCheckpoint` throws before recording a
 *   checkpoint. The same shape is already solved for source (`workspace-archive`)
 *   and writable state (`project-data-archive`): the guest packs, the host
 *   uploads with its cloud-init credentials. This is that third archive.
 *
 * The key name matches `packages/shared-runtime/src/repo-store.ts` so the
 * existing restore path hydrates it without learning a new name.
 *
 * Lineage reuses the writable-state model: a writer may replace only the object
 * it descends from, or create one where none exists. Concurrent writers
 * (activity-poll export vs suspend) are adjudicated by the store, not by a
 * read-then-write race.
 */

import { describeObject, type ArchiveRef } from './archive-ref'
import type { MetalConfig } from './config'
import {
  type DataLineage,
  type DataWriteOutcome,
  planDataWrite,
} from './project-data-archive'
import { conditionalPutObject, type S3Target } from './s3-conditional'
import { workspaceS3 } from './workspace-archive'

export type RepoLineage = DataLineage
export type RepoWriteOutcome = DataWriteOutcome

/** A durable `.git` archive plus the ETag that anchors its lineage. */
export interface RepoArchive {
  bytes: Uint8Array
  etag: string | null
}

/** Durable key for a project's git repo archive. Same as repo-store.ts. */
export function repoArchiveKey(projectId: string): string {
  return `${projectId}/repo.git.tar.gz`
}

export function repoQuarantineKey(projectId: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `conflict/${projectId}/${Date.now()}-${rand}-repo.tar.gz`
}

/**
 * Hard ceiling on a `.git` archive (4 GiB) — same as the guest hydrate cap
 * and the writable-state archive. A repo that large has outgrown this path.
 */
export const REPO_MAX_BYTES = 4 * 1024 * 1024 * 1024

export function repoS3Target(cfg: MetalConfig): S3Target | null {
  const bucket = process.env.S3_WORKSPACES_BUCKET || cfg.snapStoreBucket
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (!bucket || !accessKeyId || !secretAccessKey) return null
  const endpoint = cfg.s3Endpoint || `https://s3.${cfg.s3Region}.amazonaws.com`
  return { bucket, accessKeyId, secretAccessKey, endpoint, region: cfg.s3Region }
}

async function statMeta(
  file: import('bun').S3File,
): Promise<{ etag: string | null; size: number | null }> {
  try {
    const st = await file.stat()
    return { etag: st.etag ?? null, size: typeof st.size === 'number' ? st.size : null }
  } catch {
    return { etag: null, size: null }
  }
}

export async function fetchRepoArchive(
  projectId: string,
  cfg: MetalConfig,
): Promise<RepoArchive | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null

  const file = s3.client.file(repoArchiveKey(projectId))
  if (!(await file.exists())) return null
  const meta = await statMeta(file)
  const buf = await file.arrayBuffer()
  return { bytes: new Uint8Array(buf), etag: meta.etag }
}

export async function describeRepoArchive(
  projectId: string,
  cfg: MetalConfig,
  expiresInSec: number,
): Promise<ArchiveRef | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  return describeObject(s3.client, repoArchiveKey(projectId), expiresInSec)
}

async function quarantine(
  projectId: string,
  bytes: Uint8Array,
  cfg: MetalConfig,
): Promise<string | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  const key = repoQuarantineKey(projectId)
  await s3.client.write(key, bytes, { type: 'application/gzip' })
  return key
}

export async function uploadRepoArchiveGuarded(
  projectId: string,
  bytes: Uint8Array,
  opts: { lineage: RepoLineage; preserveOnRefusal?: boolean },
  cfg: MetalConfig,
): Promise<RepoWriteOutcome> {
  if (bytes.byteLength > REPO_MAX_BYTES) {
    return { status: 'too-large', bytes: bytes.byteLength, limit: REPO_MAX_BYTES }
  }

  const plan = planDataWrite(opts.lineage)
  if (plan.action === 'refuse') {
    const qkey = opts.preserveOnRefusal ? await quarantine(projectId, bytes, cfg) : null
    return { status: 'refused', reason: plan.reason, quarantineKey: qkey }
  }

  const target = repoS3Target(cfg)
  if (!target) return { status: 'skipped' }

  if (plan.action === 'create-only') {
    const s3 = workspaceS3(cfg)
    if (s3 && (await s3.client.file(repoArchiveKey(projectId)).exists())) {
      const qkey = opts.preserveOnRefusal ? await quarantine(projectId, bytes, cfg) : null
      return { status: 'conflict', quarantineKey: qkey, reason: 'raced-create' }
    }
  }

  const result = await conditionalPutObject({
    target,
    key: repoArchiveKey(projectId),
    body: bytes,
    contentType: 'application/gzip',
    precondition:
      plan.action === 'compare-and-swap' ? { ifMatch: plan.ifMatch } : { ifNoneMatch: '*' },
  })

  if (result.status === 'ok') {
    return plan.action === 'create-only'
      ? { status: 'created', etag: result.etag }
      : { status: 'written', etag: result.etag }
  }

  const qkey = opts.preserveOnRefusal ? await quarantine(projectId, bytes, cfg) : null
  return {
    status: 'conflict',
    quarantineKey: qkey,
    reason: plan.action === 'create-only' ? 'raced-create' : 'lineage',
  }
}
