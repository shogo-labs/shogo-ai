// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host-side fetch + LINEAGE-GUARDED write of a project's durable workspace
 * source backup (`{projectId}/project-src.tar.gz`).
 *
 * On bare metal the *guest* VM must never hold S3 credentials — a compromised
 * guest would otherwise reach the shared workspace bucket. So the trusted
 * metal-agent (this process) is the only thing that talks to S3. On a cold
 * miss (a fresh warm VM booted from the template, no snapshot to resume) it
 * pulls the archive and hands the bytes to the guest over the control channel
 * (`POST /pool/hydrate`), which extracts + rebuilds. On suspend the guest packs
 * its latest source and hands it back to us to upload.
 *
 * Why the write is guarded (the data-loss incident this prevents):
 *   The old write was an UNCONDITIONAL last-writer-wins PUT. A guest that ever
 *   came up as the bare template (a cold boot whose hydrate silently failed, or
 *   a resume that restored a stale/template snapshot) would, on its next
 *   idle-suspend, pack ~337 KB of template and OVERWRITE a real multi-MB/GB
 *   backup permanently. Size heuristics misfire both ways, so instead we make
 *   the invariant STRUCTURAL: a workspace has a lineage (the ETag of the backup
 *   it was derived from), and we only overwrite the durable object we actually
 *   descend from. A writer whose lineage doesn't match the object currently in
 *   S3 (a template, a stale snapshot, a losing racer) is diverted to a
 *   quarantine key instead of clobbering — no data loss, no silent overwrite.
 *
 * Bun's S3Client.write does not expose conditional-PUT headers
 * (If-Match/If-None-Match), and OCI's S3-compat endpoint's support for them is
 * unverified, so the guard is implemented as application-level optimistic
 * concurrency: HEAD the current object for its ETag, compare against the
 * writer's lineage ETag, then write or quarantine. Concurrent same-project
 * suspends on one host are already serialized by the pool's per-project
 * singleflight; a cross-host race on the same project (rare — a project is
 * normally live on one host) has a small residual window that resolves to "one
 * writer wins, the other quarantines" rather than to loss.
 *
 * Key layout mirrors packages/shared-runtime/src/s3-sync.ts: the durable source
 * archive lives at the bucket root under `{projectId}/project-src.tar.gz`. The
 * bucket is the workspaces bucket (`S3_WORKSPACES_BUCKET`), which on our
 * deployments is the same OCI bucket as the snapshot store — we fall back to
 * the snapshot bucket when `S3_WORKSPACES_BUCKET` is unset.
 */

import type { MetalConfig } from './config'

/** A durable source archive plus the S3 ETag that anchors its lineage. */
export interface WorkspaceArchive {
  bytes: Uint8Array
  /** ETag of the fetched object; the lineage anchor a later write must match. */
  etag: string | null
}

/**
 * Outcome of a lineage-guarded backup write.
 *   created  — no backup existed; this is the project's first backup.
 *   written  — the writer's lineage matched the object in S3; safe overwrite.
 *   adopted  — a legacy resume with unknown lineage overwrote (migration only;
 *              see `adoptWhenUnknown`). Self-heals: the returned etag becomes
 *              the lineage for subsequent writes.
 *   conflict — the writer did NOT descend from the current object (template, a
 *              stale snapshot, or a losing racer), OR the write would have
 *              collapsed a real backup to a template-shaped one (`reason`). The
 *              bytes were diverted to `quarantineKey`; the backup was UNTOUCHED.
 *   skipped  — S3 is not configured (best-effort backups disabled).
 */
export type BackupWriteOutcome =
  | { status: 'created'; etag: string | null }
  | { status: 'written'; etag: string | null }
  | { status: 'adopted'; etag: string | null }
  | {
      status: 'conflict'
      quarantineKey: string
      currentEtag: string | null
      /** Why we quarantined: a lineage mismatch, or the size backstop tripping. */
      reason: 'lineage' | 'size-regression'
    }
  | { status: 'skipped' }

/** Bucket + credential resolution shared by fetch/upload. Null when S3 unusable. */
function workspaceS3(cfg: MetalConfig): { client: import('bun').S3Client } | null {
  const bucket = process.env.S3_WORKSPACES_BUCKET || cfg.snapStoreBucket
  if (!bucket) return null
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return null

  const { S3Client } = require('bun') as typeof import('bun')
  const client = new S3Client({
    bucket,
    endpoint: cfg.s3Endpoint || undefined,
    region: cfg.s3Region,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  })
  return { client }
}

/** Durable key for a project's source backup — mirrors the Knative s3-sync layout. */
function archiveKey(projectId: string): string {
  return `${projectId}/project-src.tar.gz`
}

/**
 * Quarantine key for an export we refused to write over the durable backup.
 *
 * Lives under a single top-level `conflict/` prefix (namespaced per-project +
 * timestamped so multiple conflicts never collide and an operator can recover
 * the bytes — they are a real, if orphaned, workspace). The top-level prefix
 * (rather than `{projectId}/conflict/`) is deliberate: it lets an OCI object
 * lifecycle rule TTL the whole quarantine area by prefix, so refused exports
 * don't accumulate unbounded storage cost. See terraform/modules/object-storage.
 */
export function quarantineKey(projectId: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `conflict/${projectId}/${Date.now()}-${rand}.tar.gz`
}

/**
 * Normalize an S3 ETag for comparison: strip the weak-validator prefix and the
 * surrounding quotes so `W/"abc"` and `"abc"` and `abc` all compare equal. OCI
 * and AWS quote ETags in headers; Bun may or may not preserve the quotes.
 */
export function etagEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const norm = (s: string): string => s.replace(/^W\//, '').replace(/^"|"$/g, '')
  return norm(a) === norm(b)
}

/** The action the guard takes; the pure core of the write decision (S3-free). */
export type BackupWriteAction = 'create' | 'overwrite' | 'adopt' | 'quarantine'

/**
 * Template exports (the "Project Ready" placeholder workspace) pack to ~337 KB;
 * real user source is materially larger. A write at or below this size is
 * "template-shaped". Generous ceiling so a slightly-heavier template variant
 * still counts, with a clear gap below {@link REAL_MIN_BYTES}.
 */
export const TEMPLATE_MAX_BYTES = 512 * 1024
/** A durable object at or above this size is unambiguously real user source. */
export const REAL_MIN_BYTES = 1024 * 1024

/**
 * True when replacing a `currentSize`-byte object with `incomingSize` bytes
 * would collapse a real backup down to a template-shaped one — the exact
 * signature of the clobber incident (multi-MB real → ~337 KB template). Used as
 * a size backstop on the `adopt` path so a mislabeled-lineage template can
 * never overwrite real source. Fails SAFE: when either size is unknown it
 * returns false (defer to the lineage decision).
 */
export function isTemplateRegression(
  currentSize: number | null,
  incomingSize: number | null,
): boolean {
  if (currentSize == null || incomingSize == null) return false
  return currentSize >= REAL_MIN_BYTES && incomingSize <= TEMPLATE_MAX_BYTES
}

/**
 * Pure decision core of {@link uploadWorkspaceArchiveGuarded}, factored out so
 * the anti-clobber invariant is unit-testable without S3. Given whether an
 * object exists, its current ETag, the writer's lineage ETag, whether an
 * unknown-lineage write may be trusted (migration), and the two sizes, returns
 * what to do:
 *   - nothing in S3                    → 'create'
 *   - writer descends from current     → 'overwrite'
 *   - unknown lineage + adopt allowed  → 'adopt' … UNLESS adopting would regress
 *     a real backup to a template-shaped one (size backstop) → 'quarantine'
 *   - otherwise (template / stale / racer) → 'quarantine' (NEVER clobber)
 */
export function decideBackupWrite(input: {
  exists: boolean
  currentEtag: string | null
  parentEtag?: string | null
  adoptWhenUnknown?: boolean
  currentSize?: number | null
  incomingSize?: number | null
}): BackupWriteAction {
  if (!input.exists) return 'create'
  if (input.parentEtag && etagEq(input.parentEtag, input.currentEtag)) return 'overwrite'
  if (!input.parentEtag && input.adoptWhenUnknown) {
    // SIZE BACKSTOP for the `adopt` escape hatch. `adoptWhenUnknown` trusts a
    // snapshot with unknown lineage (the pre-guard migration tail). But a
    // template snapshot that has been through one suspend→resume cycle ALSO
    // arrives here as origin 'snapshot' with no parent ETag — and adopting it
    // would collapse a real multi-MB backup down to a ~337 KB template (the
    // clobber incident's second vector, observed re-clobbering new projects
    // after a cross-host double-assign). Refuse when the adopt would regress a
    // real object to a template-shaped one; the bytes go to quarantine
    // (recoverable) and the real backup is left intact. A legitimate legacy
    // resume carries real content, so its adopt is never a regression.
    if (isTemplateRegression(input.currentSize ?? null, input.incomingSize ?? null)) {
      return 'quarantine'
    }
    return 'adopt'
  }
  return 'quarantine'
}

/** Best-effort ETag of an object; null when absent or on any HEAD error. */
async function statEtag(file: import('bun').S3File): Promise<string | null> {
  try {
    const st = await file.stat()
    return st.etag ?? null
  } catch {
    return null
  }
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
 * Download `{projectId}/project-src.tar.gz` from the durable workspace bucket
 * along with its ETag (the lineage anchor). Returns `null` when there is no
 * durable backup (a genuinely new project) or S3 is not configured. Throws only
 * on unexpected transport errors so the caller can distinguish "no backup"
 * (serve the template) from "couldn't reach S3" (fail closed, don't serve a
 * template over real source).
 */
export async function fetchWorkspaceArchive(
  projectId: string,
  cfg: MetalConfig,
): Promise<WorkspaceArchive | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null

  const file = s3.client.file(archiveKey(projectId))
  // `exists()` is the documented HEAD existence check and cleanly distinguishes
  // "no durable backup yet" (new project → serve template) from a real
  // transport error (which propagates, so the caller can FAIL CLOSED rather
  // than mistake an outage for "new" and clobber real source with a template).
  if (!(await file.exists())) return null
  const etag = await statEtag(file)
  const buf = await file.arrayBuffer()
  return { bytes: new Uint8Array(buf), etag }
}

/**
 * Lineage-guarded upload of a project's source backup.
 *
 * Compares the writer's lineage (`opts.parentEtag` — the ETag of the backup its
 * workspace was derived from, or undefined for a template/unknown origin)
 * against the object currently in S3, and:
 *   - no object in S3            → write it (first backup): `created`
 *   - lineage matches current    → overwrite (safe): `written`
 *   - lineage unknown + adopt    → overwrite, trust a legacy resume: `adopted`
 *   - otherwise                  → quarantine, never clobber: `conflict`
 *
 * `opts.adoptWhenUnknown` exists ONLY for the migration tail: a snapshot taken
 * before lineage stamping shipped carries no parent ETag, so a resume of it has
 * unknown (not mismatched) lineage. Trusting it preserves the pre-change
 * behavior for legitimate legacy workspaces while a genuine template origin
 * (which passes `adoptWhenUnknown:false`) is always quarantined. It is NOT a
 * bypass for a KNOWN mismatch (a stale ETag) — that always quarantines.
 */
export async function uploadWorkspaceArchiveGuarded(
  projectId: string,
  bytes: Uint8Array,
  opts: { parentEtag?: string | null; adoptWhenUnknown?: boolean },
  cfg: MetalConfig,
): Promise<BackupWriteOutcome> {
  const s3 = workspaceS3(cfg)
  if (!s3) return { status: 'skipped' }

  const key = archiveKey(projectId)
  const file = s3.client.file(key)

  // `exists()` decides the branch; `stat()` reads the ETag (lineage anchor) AND
  // the size (the backstop input) we compare against. A transport error here
  // propagates (the write is best-effort and the caller logs it) rather than
  // risk a wrong overwrite/quarantine decision.
  const exists = await file.exists()
  const cur = exists ? await statMeta(file) : { etag: null, size: null }
  const currentEtag = cur.etag

  const action = decideBackupWrite({
    exists,
    currentEtag,
    parentEtag: opts.parentEtag,
    adoptWhenUnknown: opts.adoptWhenUnknown,
    currentSize: cur.size,
    incomingSize: bytes.byteLength,
  })

  switch (action) {
    case 'create':
      await s3.client.write(key, bytes, { type: 'application/gzip' })
      return { status: 'created', etag: await statEtag(file) }
    case 'overwrite':
      await s3.client.write(key, bytes, { type: 'application/gzip' })
      return { status: 'written', etag: await statEtag(file) }
    case 'adopt':
      await s3.client.write(key, bytes, { type: 'application/gzip' })
      return { status: 'adopted', etag: await statEtag(file) }
    case 'quarantine': {
      // The writer either does NOT descend from the current backup, or its
      // export would collapse a real backup to a template (size backstop).
      // NEVER clobber: divert to a quarantine key so the bytes are recoverable
      // + investigable. `reason` distinguishes the two so ops can tell a benign
      // lineage race from the backstop catching a real clobber attempt.
      const qkey = quarantineKey(projectId)
      await s3.client.write(qkey, bytes, { type: 'application/gzip' })
      const reason: 'lineage' | 'size-regression' = isTemplateRegression(cur.size, bytes.byteLength)
        ? 'size-regression'
        : 'lineage'
      return { status: 'conflict', quarantineKey: qkey, currentEtag, reason }
    }
  }
}
