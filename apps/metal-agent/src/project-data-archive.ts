// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host-side fetch + GUARDED write of a project's durable WRITABLE STATE
 * (`{projectId}/project-data.tar.gz`) — the SQLite database and upload dirs.
 *
 * Why this exists separately from `workspace-archive.ts` (the incident):
 *   The source archive persists code. Runtime state — `prisma/dev.db` and
 *   uploaded media — lived only inside the VM snapshot. Any cold boot that
 *   bypassed the snapshot therefore restored source over an EMPTY database and
 *   silently destroyed the user's data. That is not hypothetical: a golden
 *   rootfs rebuild changes `rootfsIdentity`, which invalidates every existing
 *   snapshot, and the next open cold-boots from source alone. A user lost a
 *   generated song library this way — the audio was stored base64 inside
 *   `dev.db`, so it was unrecoverable from anywhere else.
 *
 * Keeping this a SEPARATE object from `project-src.tar.gz` is deliberate:
 *   - Source stays small and cacheable; a multi-hundred-MB database does not
 *     bloat every cold hydrate (oversized source archives were already causing
 *     hydrate failures).
 *   - The two have different write cadences (source on suspend; data also on a
 *     periodic timer, because a host that dies never suspends).
 *   - A corrupt or oversized database can be skipped without also losing the
 *     ability to restore the project's code.
 *
 * ── How the guard works ──────────────────────────────────────────────────
 *
 * Every write is a CONDITIONAL write, so the guard is enforced by the storage
 * layer rather than by a check we perform beforehand. The earlier design read
 * the object's ETag and then wrote if it looked right, which is a
 * time-of-check/time-of-use race: two writers could both read ETag `E`, both
 * conclude they were safe, and the loser would silently destroy the winner's
 * data. The periodic exporter and `suspend()` are exactly two such writers.
 *
 * A workspace is in one of three states, and each maps to a precondition the
 * server enforces atomically (see {@link planDataWrite}):
 *
 *   descends(etag) → `If-Match: etag`     — may replace the archive it came from
 *   create-only    → `If-None-Match: *`   — may create, can never overwrite
 *   untrusted      → no write at all      — provenance is known to be bad
 *
 * Sizing heuristics used to stand in for the `untrusted` state, guessing from
 * a shrink whether an empty database was about to erase a populated one. They
 * are no longer part of the decision: the case they approximated is now stated
 * outright by the caller, and a heuristic that can only produce false refusals
 * is worse than one that is not consulted. {@link isDataCollapse} survives
 * purely as an observability signal — see its doc comment.
 */

import { describeObject, type ArchiveRef } from './archive-ref'
import type { MetalConfig } from './config'
import { conditionalPutObject, type S3Target } from './s3-conditional'
import { workspaceS3 } from './workspace-archive'

/** A durable writable-state archive plus the ETag that anchors its lineage. */
export interface ProjectDataArchive {
  bytes: Uint8Array
  /** ETag of the fetched object; the lineage anchor a later write must match. */
  etag: string | null
}

/**
 * Where a workspace's database came from, stated by the caller rather than
 * inferred. This is the whole safety argument, so the states are deliberately
 * few and explicit.
 */
export type DataLineage =
  /** Hydrated from exactly this archive; entitled to replace it. */
  | { kind: 'descends'; etag: string }
  /**
   * Provenance is not known to be bad, but this workspace cannot prove it
   * descends from anything: a brand-new project, or a VM adopted across an
   * agent restart that predates lineage tracking. Allowed to CREATE the
   * archive (there is nothing to lose if none exists) and nothing more.
   */
  | { kind: 'create-only' }
  /**
   * Provenance is known to be bad — the writable-state hydrate failed, so this
   * VM booted on whatever database the source archive happened to contain.
   * Its export must never reach the durable archive; that is precisely the
   * empty-database-over-real-data shape of the original incident.
   */
  | { kind: 'untrusted'; reason: string }

/**
 * Outcome of a guarded writable-state write.
 *   created   — the archive did not exist and this write created it.
 *   written   — the writer's lineage matched; a safe compare-and-swap.
 *   conflict  — the precondition failed, so the archive was NOT what this
 *               writer descends from. The stored archive is UNTOUCHED. Bytes
 *               go to `quarantineKey` when the caller asked to preserve them.
 *   refused   — the caller declared the workspace untrusted; nothing written.
 *   too-large — exceeds {@link DATA_MAX_BYTES}; surfaced (not swallowed) so it
 *               alerts, because it means silent non-durability.
 *   skipped   — S3 is not configured.
 */
export type DataWriteOutcome =
  | { status: 'created'; etag: string | null }
  | { status: 'written'; etag: string | null }
  | {
      status: 'conflict'
      quarantineKey: string | null
      reason: 'lineage' | 'raced-create'
    }
  | { status: 'refused'; reason: string; quarantineKey: string | null }
  | { status: 'too-large'; bytes: number; limit: number }
  | { status: 'skipped' }

/** Durable key for a project's writable-state archive. */
export function dataArchiveKey(projectId: string): string {
  return `${projectId}/project-data.tar.gz`
}

/**
 * Quarantine key for a writable-state export we refused to write.
 *
 * Shares the top-level `conflict/` prefix with source quarantines so one OCI
 * lifecycle rule TTLs both, with a `-data` suffix so an operator can tell the
 * two apart when recovering bytes.
 */
export function dataQuarantineKey(projectId: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `conflict/${projectId}/${Date.now()}-${rand}-data.tar.gz`
}

/**
 * Hard ceiling on a writable-state archive (4 GiB). Deliberately the same
 * number as the guest's `/pool/hydrate` request-body cap: storing an archive
 * larger than we can hand back is worse than not storing it, because the
 * project still cold-boots empty and now pays for the storage too. If that cap
 * moves, move this with it.
 *
 * Exceeding it is a loud, metered error rather than a silent skip: it means a
 * project has outgrown this durability mechanism and needs attention.
 */
export const DATA_MAX_BYTES = 4 * 1024 * 1024 * 1024

/** A current archive at or above this size holds enough state to be worth noting. */
export const DATA_REAL_MIN_BYTES = 1024 * 1024

/** Shrink ratio below which an update looks less like an edit than an erasure. */
export const COLLAPSE_RATIO = 0.25

/**
 * True when a write shrinks a populated archive to a small fraction of itself.
 *
 * This NO LONGER blocks anything. It once stood in for the `untrusted` state,
 * blocking unknown-lineage writes that looked like an empty database replacing
 * a populated one. Now that untrusted workspaces are refused outright, the only
 * writes that reach a populated archive are ones that provably descend from it
 * — where a shrink is the user deleting their own data, and refusing it would
 * strand their archive permanently.
 *
 * It is kept because the shape is still worth counting: a legitimate
 * descends-write that collapses an archive is either a user wiping their
 * database or a bug upstream of here, and we want to see which. Fails safe on
 * unknown sizes.
 */
export function isDataCollapse(
  currentSize: number | null,
  incomingSize: number | null,
): boolean {
  if (currentSize == null || incomingSize == null) return false
  if (currentSize < DATA_REAL_MIN_BYTES) return false
  return incomingSize <= currentSize * COLLAPSE_RATIO
}

/**
 * The precondition a given lineage earns. Pure, so the safety property is
 * unit-testable without S3.
 *
 * The invariant to check against this table: NO lineage yields an
 * unconditional write. A workspace may replace only the exact object it came
 * from, or create one where none exists.
 */
export type DataWritePlan =
  | { action: 'compare-and-swap'; ifMatch: string }
  | { action: 'create-only' }
  | { action: 'refuse'; reason: string }

export function planDataWrite(lineage: DataLineage): DataWritePlan {
  switch (lineage.kind) {
    case 'descends':
      return { action: 'compare-and-swap', ifMatch: lineage.etag }
    case 'create-only':
      return { action: 'create-only' }
    case 'untrusted':
      return { action: 'refuse', reason: lineage.reason }
  }
}

/**
 * Credentials/addressing for the workspaces bucket, or null when unconfigured.
 *
 * Mirrors exactly what `workspaceS3` treats as configured, so the read path and
 * the write path can never disagree about whether durability is on. An absent
 * endpoint falls back to AWS rather than disabling writes, because a silent
 * skip here reads as "backups are running" while nothing is being persisted.
 */
export function dataS3Target(cfg: MetalConfig): S3Target | null {
  const bucket = process.env.S3_WORKSPACES_BUCKET || cfg.snapStoreBucket
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (!bucket || !accessKeyId || !secretAccessKey) return null
  const endpoint = cfg.s3Endpoint || `https://s3.${cfg.s3Region}.amazonaws.com`
  return { bucket, accessKeyId, secretAccessKey, endpoint, region: cfg.s3Region }
}

/** Best-effort ETag + size of an object; nulls when absent or on any HEAD error. */
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

/**
 * Download `{projectId}/project-data.tar.gz` along with its ETag (the lineage
 * anchor). Returns `null` when the project has no durable writable state yet or
 * S3 is not configured. Transport errors propagate so the caller can tell "no
 * data" apart from "couldn't reach S3".
 */
export async function fetchProjectDataArchive(
  projectId: string,
  cfg: MetalConfig,
): Promise<ProjectDataArchive | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null

  const file = s3.client.file(dataArchiveKey(projectId))
  if (!(await file.exists())) return null
  const meta = await statMeta(file)
  const buf = await file.arrayBuffer()
  return { bytes: new Uint8Array(buf), etag: meta.etag }
}

/**
 * Describe `{projectId}/project-data.tar.gz` without downloading it, so the
 * writable-state overlay can be pulled by the guest. Uploads can be large in
 * their own right — this archive carries the database AND every user upload.
 */
export async function describeProjectDataArchive(
  projectId: string,
  cfg: MetalConfig,
  expiresInSec: number,
): Promise<ArchiveRef | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  return describeObject(s3.client, dataArchiveKey(projectId), expiresInSec)
}

/** Park bytes we would not write, so an operator can still recover them. */
async function quarantine(
  projectId: string,
  bytes: Uint8Array,
  cfg: MetalConfig,
): Promise<string | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  const key = dataQuarantineKey(projectId)
  await s3.client.write(key, bytes, { type: 'application/gzip' })
  return key
}

/**
 * Write a project's writable state under the lineage guard.
 *
 * `preserveOnRefusal` controls whether refused bytes are quarantined. Callers
 * should set it for a FINAL export (suspend) and leave it off for periodic
 * ones: an untrusted VM exports every cycle, and quarantining each one would
 * accumulate thousands of copies of the same database while the single useful
 * copy — the last one — is the only one anybody would ever restore.
 */
export async function uploadProjectDataGuarded(
  projectId: string,
  bytes: Uint8Array,
  opts: { lineage: DataLineage; preserveOnRefusal?: boolean },
  cfg: MetalConfig,
): Promise<DataWriteOutcome> {
  if (bytes.byteLength > DATA_MAX_BYTES) {
    return { status: 'too-large', bytes: bytes.byteLength, limit: DATA_MAX_BYTES }
  }

  const plan = planDataWrite(opts.lineage)
  if (plan.action === 'refuse') {
    const qkey = opts.preserveOnRefusal ? await quarantine(projectId, bytes, cfg) : null
    return { status: 'refused', reason: plan.reason, quarantineKey: qkey }
  }

  const target = dataS3Target(cfg)
  if (!target) return { status: 'skipped' }

  // Cheap pre-check, purely to avoid uploading a body we already know will be
  // rejected: a create-only writer whose archive exists would otherwise push
  // the whole database over the wire every cycle just to collect a 412. This
  // is NOT the safety check — `If-None-Match` below still is, so a race
  // between this HEAD and the PUT is harmless.
  if (plan.action === 'create-only') {
    const s3 = workspaceS3(cfg)
    if (s3 && (await s3.client.file(dataArchiveKey(projectId)).exists())) {
      const qkey = opts.preserveOnRefusal ? await quarantine(projectId, bytes, cfg) : null
      return { status: 'conflict', quarantineKey: qkey, reason: 'raced-create' }
    }
  }

  const result = await conditionalPutObject({
    target,
    key: dataArchiveKey(projectId),
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

  // The server rejected the precondition, so the archive is not the one this
  // writer descends from and was left alone. A create-only writer losing here
  // simply means the archive now exists — normal during rollout.
  const qkey = opts.preserveOnRefusal ? await quarantine(projectId, bytes, cfg) : null
  return {
    status: 'conflict',
    quarantineKey: qkey,
    reason: plan.action === 'create-only' ? 'raced-create' : 'lineage',
  }
}
