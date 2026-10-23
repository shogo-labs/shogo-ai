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
import {
  bundleObjectName,
  parseRepoManifest,
  type RepoManifest,
  type RepoManifestBundle,
} from './vendor/repo-bundles'
import type { MetalConfig } from './config'
import {
  type DataLineage,
  type DataWriteOutcome,
  planDataWrite,
} from './project-data-archive'
import type { BunFile } from 'bun'
import { createHash } from 'crypto'
import { conditionalPutObject, copyObject, sha256HexFile, type ConditionalPutResult, type S3Target } from './s3-conditional'
import { workspaceS3 } from './workspace-archive'

export type RepoLineage = DataLineage
export type RepoWriteOutcome = DataWriteOutcome

/**
 * A `.git` archive to upload: in memory, or spooled to disk by the exporter.
 * Large repos must stay on disk — buffering a multi-GB archive in the agent's
 * heap stalls every other request the agent serves.
 */
export type RepoBody = Uint8Array | BunFile

export function repoBodySize(body: RepoBody): number {
  return body instanceof Uint8Array ? body.byteLength : body.size
}

export function repoBodySha256(body: RepoBody): Promise<string> {
  if (body instanceof Uint8Array) return Promise.resolve(createHash('sha256').update(body).digest('hex'))
  return sha256HexFile(body)
}

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

/**
 * Incremental repo format (see `@shogo/shared-runtime/repo-bundles`). Once a
 * project has a manifest it is the authority for the repo; the tarball above
 * becomes legacy and is never read in preference to it.
 */
export function repoManifestKey(projectId: string): string {
  return `${projectId}/repo/manifest.json`
}

export interface RepoManifestRead {
  manifest: RepoManifest
  etag: string | null
  lastModified: number | null
}

/**
 * The project's manifest, or null when it has none. A manifest that exists but
 * does not parse throws: falling back to the tarball would restore a stale repo.
 */
export async function fetchRepoManifest(projectId: string, cfg: MetalConfig): Promise<RepoManifestRead | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  const file = s3.client.file(repoManifestKey(projectId))
  if (!(await file.exists())) return null
  const meta = await statMeta(file)
  const text = await file.text()
  const manifest = parseRepoManifest(JSON.parse(text))
  return { manifest, etag: meta.etag, lastModified: await lastModifiedOf(file) }
}

async function lastModifiedOf(file: import('bun').S3File): Promise<number | null> {
  try {
    const st = await file.stat()
    const ms = st.lastModified ? new Date(st.lastModified).getTime() : NaN
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

/** Presigned GETs for every bundle in the manifest, in chain order. */
export async function describeRepoBundles(
  projectId: string,
  manifest: RepoManifest,
  cfg: MetalConfig,
  expiresInSec: number,
): Promise<Array<RepoManifestBundle & { url: string }>> {
  const s3 = workspaceS3(cfg)
  if (!s3) throw new Error('object storage is not configured; cannot presign repo bundles')
  const out: Array<RepoManifestBundle & { url: string }> = []
  for (const entry of manifest.bundles) {
    const ref = await describeObject(s3.client, `${projectId}/${bundleObjectName(entry.sha256)}`, expiresInSec)
    if (!ref?.url) throw new Error(`repo bundle ${entry.sha256} for ${projectId} is missing from the store`)
    out.push({ ...entry, url: ref.url })
  }
  return out
}

/**
 * The object operations the incremental repo writer, bundle upload and GC
 * need. The real one is backed by the workspace bucket; tests pass a fake, so
 * the lineage and sweep rules run without touching the process-wide S3 modules.
 */
export interface RepoObjectStore {
  /** ETag and last-write time, or null when the key is absent. */
  head(key: string): Promise<{ etag: string | null; lastModified: number | null } | null>
  readText(key: string): Promise<string>
  write(key: string, body: string | BunFile, contentType: string): Promise<void>
  conditionalPut(
    key: string,
    body: string,
    precondition: { ifMatch: string } | { ifNoneMatch: '*' },
  ): Promise<ConditionalPutResult>
  list(prefix: string, token?: string): Promise<{ keys: Array<{ key: string; lastModified: number | null }>; nextToken?: string }>
  remove(key: string): Promise<void>
}

/** The workspace bucket as a {@link RepoObjectStore}, or null when unconfigured. */
export function workspaceRepoStore(cfg: MetalConfig): RepoObjectStore | null {
  const s3 = workspaceS3(cfg)
  const target = repoS3Target(cfg)
  if (!s3 || !target) return null
  const client = s3.client
  return {
    async head(key) {
      const file = client.file(key)
      if (!(await file.exists())) return null
      const meta = await statMeta(file)
      return { etag: meta.etag, lastModified: await lastModifiedOf(file) }
    },
    readText: (key) => client.file(key).text(),
    async write(key, body, contentType) {
      await client.write(key, typeof body === 'string' ? new TextEncoder().encode(body) : body, { type: contentType })
    },
    conditionalPut: (key, body, precondition) =>
      conditionalPutObject({
        target,
        key,
        body: new TextEncoder().encode(body),
        contentType: 'application/json',
        precondition,
      }),
    async list(prefix, token) {
      const page = await client.list({ prefix, continuationToken: token })
      return {
        keys: (page.contents ?? []).flatMap((o) =>
          o.key
            ? [{ key: o.key, lastModified: o.lastModified ? new Date(o.lastModified).getTime() : null }]
            : [],
        ),
        nextToken: page.isTruncated ? page.nextContinuationToken : undefined,
      }
    },
    async remove(key) {
      await client.file(key).delete()
    },
  }
}

/** ETag of the legacy tarball alone (ignoring any manifest), or null when absent. */
export async function statRepoTarball(projectId: string, cfg: MetalConfig): Promise<{ etag: string | null } | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  const file = s3.client.file(repoArchiveKey(projectId))
  if (!(await file.exists())) return null
  return { etag: (await statMeta(file)).etag }
}

/**
 * Upload one bundle under its digest. Content-addressed, so an object that is
 * already there is identical and needs no write.
 */
export async function uploadRepoBundle(
  projectId: string,
  entry: RepoManifestBundle,
  body: BunFile,
  cfg: MetalConfig,
  store: RepoObjectStore | null = workspaceRepoStore(cfg),
): Promise<'uploaded' | 'present' | 'skipped'> {
  if (!store) return 'skipped'
  const key = `${projectId}/${bundleObjectName(entry.sha256)}`
  if (await store.head(key)) return 'present'
  await store.write(key, body, 'application/octet-stream')
  return 'uploaded'
}

/**
 * Bundles younger than this are never deleted. A writer uploads a bundle
 * before the manifest that references it, and a hydrate may still be reading
 * a manifest that was replaced moments ago.
 */
export const REPO_BUNDLE_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Pure rule for the sweep: which listed bundles may be deleted. A bundle is
 * deleted only when nothing references it and it is older than the grace
 * period. Anything with an unknown age is kept.
 */
export function selectUnreferencedBundles(
  listed: Array<{ key: string; lastModified: number | null }>,
  referenced: ReadonlySet<string>,
  now: number,
  graceMs: number,
): { delete: string[]; kept: number } {
  const del: string[] = []
  let kept = 0
  for (const obj of listed) {
    const sha = obj.key.match(/([0-9a-f]{64})\.bundle$/)?.[1]
    if (!sha) continue
    if (referenced.has(sha) || obj.lastModified === null || !(now - obj.lastModified > graceMs)) {
      kept++
      continue
    }
    del.push(obj.key)
  }
  return { delete: del, kept }
}

/**
 * Delete bundles that nothing references: not the current manifest, not a
 * `conflict/` manifest, and older than the grace period. Returns null when
 * object storage is not configured. An unreadable conflict manifest aborts the
 * sweep, since that manifest may still reference bundles we would delete.
 */
export async function sweepRepoBundles(
  projectId: string,
  cfg: MetalConfig,
  now: number = Date.now(),
  graceMs: number = REPO_BUNDLE_GRACE_MS,
  store: RepoObjectStore | null = workspaceRepoStore(cfg),
): Promise<{ deleted: number; kept: number } | null> {
  if (!store) return null

  const referenced = new Set<string>()
  if (await store.head(repoManifestKey(projectId))) {
    const current = parseRepoManifest(JSON.parse(await store.readText(repoManifestKey(projectId))))
    for (const b of current.bundles) referenced.add(b.sha256)
  }

  let quarantineToken: string | undefined
  do {
    const page = await store.list(`conflict/${projectId}/`, quarantineToken)
    for (const obj of page.keys) {
      if (!obj.key.endsWith('-manifest.json')) continue
      const manifest = parseRepoManifest(JSON.parse(await store.readText(obj.key)))
      for (const b of manifest.bundles) referenced.add(b.sha256)
    }
    quarantineToken = page.nextToken
  } while (quarantineToken)

  let deleted = 0
  let kept = 0
  let token: string | undefined
  do {
    const page = await store.list(`${projectId}/repo/bundles/`, token)
    const verdict = selectUnreferencedBundles(page.keys, referenced, now, graceMs)
    for (const key of verdict.delete) {
      await store.remove(key)
      deleted++
    }
    kept += verdict.kept
    token = page.nextToken
  } while (token)
  return { deleted, kept }
}

/** Copy the manifest to a conflict key before a supersede replaces it. */
export async function preserveRepoManifest(projectId: string, cfg: MetalConfig): Promise<string | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  const target = repoS3Target(cfg)
  if (!target) return null
  const sourceKey = repoManifestKey(projectId)
  if (!(await s3.client.file(sourceKey).exists())) return null
  const rand = Math.random().toString(36).slice(2, 8)
  const key = `conflict/${projectId}/${Date.now()}-${rand}-superseded-manifest.json`
  await copyObject({ target, sourceKey, destKey: key, timeoutMs: 120_000 })
  return key
}

/**
 * Pure lineage rule for a manifest write. `exists` is whether the manifest is
 * present now; `tarballEtag` is the legacy tarball's ETag, or null when there is
 * none. Returns what to do, without touching the store.
 */
export function planManifestWrite(input: {
  lineage: RepoLineage
  exists: boolean
  tarballEtag: string | null
  tarballExists: boolean
}):
  | { action: 'put'; precondition: { ifMatch: string } | { ifNoneMatch: '*' } }
  | { action: 'conflict'; reason: 'lineage' | 'raced-create' }
  | { action: 'refuse'; reason: string } {
  const plan = planDataWrite(input.lineage)
  if (plan.action === 'refuse') return { action: 'refuse', reason: plan.reason }
  if (input.exists) {
    if (plan.action !== 'compare-and-swap') return { action: 'conflict', reason: 'raced-create' }
    return { action: 'put', precondition: { ifMatch: plan.ifMatch } }
  }
  if (input.tarballExists) {
    // Migration: only a lineage descending from that exact tarball may create the manifest.
    const descends =
      input.lineage.kind === 'descends' && input.tarballEtag !== null && input.lineage.etag === input.tarballEtag
    return descends ? { action: 'put', precondition: { ifNoneMatch: '*' } } : { action: 'conflict', reason: 'lineage' }
  }
  if (plan.action === 'compare-and-swap') return { action: 'conflict', reason: 'lineage' }
  return { action: 'put', precondition: { ifNoneMatch: '*' } }
}

/**
 * Write the manifest under the lineage guard. The lineage rule itself is
 * {@link planManifestWrite}; this supplies the store and quarantines refusals.
 */
export async function uploadRepoManifestGuarded(
  projectId: string,
  manifest: RepoManifest,
  opts: { lineage: RepoLineage; preserveOnRefusal?: boolean },
  cfg: MetalConfig,
  store: RepoObjectStore | null = workspaceRepoStore(cfg),
): Promise<RepoWriteOutcome> {
  if (!store) return { status: 'skipped' }
  const body = JSON.stringify(manifest)
  const key = repoManifestKey(projectId)
  const quarantine = async (): Promise<string | null> => {
    if (!opts.preserveOnRefusal) return null
    const qkey = `conflict/${projectId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-manifest.json`
    await store.write(qkey, body, 'application/json')
    return qkey
  }

  const existing = await store.head(key)
  const tarball = await store.head(repoArchiveKey(projectId))
  const verdict = planManifestWrite({
    lineage: opts.lineage,
    exists: existing !== null,
    tarballEtag: tarball?.etag ?? null,
    tarballExists: tarball !== null,
  })
  if (verdict.action === 'refuse') {
    return { status: 'refused', reason: verdict.reason, quarantineKey: await quarantine() }
  }
  if (verdict.action === 'conflict') {
    return { status: 'conflict', quarantineKey: await quarantine(), reason: verdict.reason }
  }

  const result = await store.conditionalPut(key, body, verdict.precondition)
  if (result.status === 'ok') {
    return existing ? { status: 'written', etag: result.etag } : { status: 'created', etag: result.etag }
  }
  return { status: 'conflict', quarantineKey: await quarantine(), reason: existing ? 'lineage' : 'raced-create' }
}

/** ETag and last-write time of the durable repo, or null when there is none. */
export async function statRepoArchive(
  projectId: string,
  cfg: MetalConfig,
): Promise<{ etag: string | null; lastModified: number | null } | null> {
  // The manifest, once it exists, is the repo's lineage object.
  const manifest = await fetchRepoManifest(projectId, cfg)
  if (manifest) return { etag: manifest.etag, lastModified: manifest.lastModified }
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  const file = s3.client.file(repoArchiveKey(projectId))
  if (!(await file.exists())) return null
  const st = await file.stat()
  const lastModified = st.lastModified ? new Date(st.lastModified).getTime() : NaN
  return { etag: st.etag ?? null, lastModified: Number.isFinite(lastModified) ? lastModified : null }
}

/** Copy the durable repo to a conflict key before it is replaced. */
export async function preserveRepoArchive(projectId: string, cfg: MetalConfig): Promise<string | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  const target = repoS3Target(cfg)
  if (!target) return null
  const sourceKey = repoArchiveKey(projectId)
  if (!(await s3.client.file(sourceKey).exists())) return null
  const rand = Math.random().toString(36).slice(2, 8)
  const key = `conflict/${projectId}/${Date.now()}-${rand}-superseded-repo.tar.gz`
  await copyObject({ target, sourceKey, destKey: key, timeoutMs: 120_000 })
  return key
}

async function quarantine(
  projectId: string,
  bytes: RepoBody,
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
  bytes: RepoBody,
  opts: { lineage: RepoLineage; preserveOnRefusal?: boolean },
  cfg: MetalConfig,
): Promise<RepoWriteOutcome> {
  const size = repoBodySize(bytes)
  if (size > REPO_MAX_BYTES) {
    return { status: 'too-large', bytes: size, limit: REPO_MAX_BYTES }
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
