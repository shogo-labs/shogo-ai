// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host-side fetch + LINEAGE-GUARDED write of a project's durable WRITABLE STATE
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
 * The guard mirrors `workspace-archive.ts`: a workspace has a lineage (the ETag
 * of the data archive it hydrated from) and may only overwrite the object it
 * descends from. Anything else is diverted to quarantine rather than clobbering.
 * See {@link decideDataWrite} for why unknown lineage is handled by size and not
 * refused outright.
 */

import type { MetalConfig } from './config'
import { etagEq, workspaceS3 } from './workspace-archive'

/** A durable writable-state archive plus the ETag that anchors its lineage. */
export interface ProjectDataArchive {
  bytes: Uint8Array
  /** ETag of the fetched object; the lineage anchor a later write must match. */
  etag: string | null
}

/**
 * Outcome of a lineage-guarded writable-state write.
 *   created   — no archive existed; this is the project's first data backup.
 *   written   — the writer's lineage matched the object in S3; safe overwrite.
 *   adopted   — unknown lineage, but the write is not a collapse; see
 *               {@link decideDataWrite}.
 *   conflict  — the writer did not descend from the current object, or the
 *               write would have collapsed a populated database. Bytes were
 *               diverted to `quarantineKey`; the archive was UNTOUCHED.
 *   too-large — the archive exceeds {@link DATA_MAX_BYTES}; nothing was
 *               written. Surfaced (not swallowed) so it alerts.
 *   skipped   — S3 is not configured.
 */
export type DataWriteOutcome =
  | { status: 'created'; etag: string | null }
  | { status: 'written'; etag: string | null }
  | { status: 'adopted'; etag: string | null }
  | {
      status: 'conflict'
      quarantineKey: string
      currentEtag: string | null
      reason: 'lineage' | 'collapse'
    }
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
 * Hard ceiling on a writable-state archive (1 GiB). Matches the guest's
 * `/pool/hydrate` request-body cap — an archive we cannot hydrate is worse than
 * useless, since it would consume storage while still cold-booting empty.
 * Exceeding it is a loud, metered error rather than a silent skip: it means a
 * project has outgrown this durability mechanism and needs attention.
 */
export const DATA_MAX_BYTES = 1024 * 1024 * 1024

/** A current archive at or above this size holds enough state to be worth protecting. */
export const DATA_REAL_MIN_BYTES = 1024 * 1024

/**
 * Fraction of the current archive below which an unknown-lineage write is
 * treated as a collapse rather than an update. A freshly-created schema-only
 * SQLite database is a small fraction of a populated one, so a 75%+ shrink from
 * a writer that cannot prove its lineage is the signature of "empty DB about to
 * overwrite real data".
 */
export const COLLAPSE_RATIO = 0.25

/**
 * True when an unknown-lineage write would collapse a populated archive down to
 * a near-empty one. Fails SAFE: unknown sizes return false and defer to the
 * lineage decision.
 */
export function isDataCollapse(
  currentSize: number | null,
  incomingSize: number | null,
): boolean {
  if (currentSize == null || incomingSize == null) return false
  if (currentSize < DATA_REAL_MIN_BYTES) return false
  return incomingSize <= currentSize * COLLAPSE_RATIO
}

/** The action the guard takes; the pure core of the write decision (S3-free). */
export type DataWriteAction = 'create' | 'overwrite' | 'adopt' | 'quarantine'

/**
 * Pure decision core of {@link uploadProjectDataGuarded}, factored out so the
 * invariant is unit-testable without S3.
 *
 *   - nothing in S3                 → 'create'
 *   - writer descends from current  → 'overwrite' (a shrink here is the user's
 *     own deletion — blocking it would strand their archive forever)
 *   - unknown lineage               → 'adopt', UNLESS the write collapses a
 *     populated archive → 'quarantine'
 *   - lineage mismatch              → 'quarantine' (NEVER clobber)
 *
 * Unknown lineage is adopted-when-not-a-collapse rather than always refused,
 * because refusing it outright has a worse failure mode during rollout: the
 * first VM to suspend after this ships has no lineage, and if an empty archive
 * were created first, the real workspace could never replace it. Sizing the
 * decision lets real data win over a small archive while still stopping an
 * empty database from erasing a populated one.
 */
export function decideDataWrite(input: {
  exists: boolean
  currentEtag: string | null
  parentEtag?: string | null
  currentSize?: number | null
  incomingSize?: number | null
}): DataWriteAction {
  if (!input.exists) return 'create'
  if (input.parentEtag && etagEq(input.parentEtag, input.currentEtag)) return 'overwrite'
  if (!input.parentEtag) {
    if (isDataCollapse(input.currentSize ?? null, input.incomingSize ?? null)) {
      return 'quarantine'
    }
    return 'adopt'
  }
  return 'quarantine'
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
 * Lineage-guarded upload of a project's writable state. See
 * {@link decideDataWrite} for the decision table and {@link DATA_MAX_BYTES} for
 * the size ceiling (checked before any S3 round-trip).
 */
export async function uploadProjectDataGuarded(
  projectId: string,
  bytes: Uint8Array,
  opts: { parentEtag?: string | null },
  cfg: MetalConfig,
): Promise<DataWriteOutcome> {
  if (bytes.byteLength > DATA_MAX_BYTES) {
    return { status: 'too-large', bytes: bytes.byteLength, limit: DATA_MAX_BYTES }
  }

  const s3 = workspaceS3(cfg)
  if (!s3) return { status: 'skipped' }

  const key = dataArchiveKey(projectId)
  const file = s3.client.file(key)

  const exists = await file.exists()
  const cur = exists ? await statMeta(file) : { etag: null, size: null }

  const action = decideDataWrite({
    exists,
    currentEtag: cur.etag,
    parentEtag: opts.parentEtag,
    currentSize: cur.size,
    incomingSize: bytes.byteLength,
  })

  switch (action) {
    case 'create':
    case 'overwrite':
    case 'adopt': {
      await s3.client.write(key, bytes, { type: 'application/gzip' })
      const etag = (await statMeta(file)).etag
      const status = action === 'create' ? 'created' : action === 'overwrite' ? 'written' : 'adopted'
      return { status, etag } as DataWriteOutcome
    }
    case 'quarantine': {
      const qkey = dataQuarantineKey(projectId)
      await s3.client.write(qkey, bytes, { type: 'application/gzip' })
      const reason: 'lineage' | 'collapse' = isDataCollapse(cur.size, bytes.byteLength)
        ? 'collapse'
        : 'lineage'
      return { status: 'conflict', quarantineKey: qkey, currentEtag: cur.etag, reason }
    }
  }
}
