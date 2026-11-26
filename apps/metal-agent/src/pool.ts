// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * MetalWarmPool — the bare-metal analog of the cloud WarmPoolController.
 * Maintains a pool of pre-booted Firecracker
 * microVMs (pool-agent in PROJECT_ID=__POOL__ mode), claims + assigns them via
 * the same POST /pool/assign contract, and adds the substrate's headline
 * capability: suspend-to-snapshot on idle / restore-from-snapshot on open.
 *
 * Phase 5 turns local NVMe into a bounded LRU cache of suspended snapshots
 * backed by the durable store:
 *   - a persistent cache index survives restarts (deploys keep locality);
 *   - a watermark+LRU GC sweep reclaims disk, evicting the least-recently-used
 *     durably-backed suspended projects (they still resume, via a store pull);
 *   - orphan reclaim recovers files no running VM or cache entry references;
 *   - singleflight + a heavy-op semaphore keep concurrent opens/suspends from
 *     stampeding the snapshot path;
 *   - real user traffic (which reaches the guest via DNAT, bypassing the agent)
 *     is folded into idle tracking via an activity poll, so the reaper/GC never
 *     suspend or evict a project that is actively serving.
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CacheIndex, type CacheEntry } from './cache-index'
import { KeyedMutex, Semaphore, Singleflight } from './concurrency'
import { PhaseTimer, type StaleReason } from './phase-timer'
import { HydrateProxy } from './hydrate-proxy'
import { classConfig, config, isVmClassSupported, VM_CLASSES, type VmClass } from './config'
import { allocatedBytes, diskUsage, type DiskUsage } from './disk'
import { DataDriveProvisioner, WORKSPACE_DRIVE_SUFFIX } from './data-drive'
import { hostFullness, resolveMemReserveMiB, selectEvictionVictim } from './evict'
import { FcApi } from './fc-api'
import { FirecrackerVMManager, readSerialTail, serialLastLine, type FcVmHandle, type FcSnapshot } from './firecracker-vm-manager'
import { planEvictions, type EvictionCandidate } from './gc-policy'
import { hostMemory } from './host-memory'
import { hostKsm, type KsmCounters } from './host-ksm'
import { LiveRegistry, pidAlive, type MemberDataState } from './live-registry'
import { BodyTooLargeError, ByteBudget, readBoundedBody } from './byte-budget'
import { memProbe } from './mem-probe'
import { M, metrics } from './metrics'
import { tapIndex, existingTapIndices, TAP_NET_CAPACITY, type VmNet } from './net'
import {
  assertArtifacts,
  computeRootfsIdentity,
  createSnapshotStore,
  type SnapshotMeta,
  type SnapshotStore,
} from './snapshot-store'
import {
  describeWorkspaceArchive,
  uploadWorkspaceArchiveGuarded,
  type BackupWriteOutcome,
} from './workspace-archive'
import {
  describePublishedDataArchive,
  publishedDataConfigured,
  uploadPublishedDataArchive,
} from './published-data-archive'
import {
  copyProjectDataToDaily,
  describeProjectDataArchive,
  uploadProjectDataGuarded,
  utcDate,
  type DailyCopyResult,
  type DataLineage,
  type DataWriteOutcome,
} from './project-data-archive'
import {
  describeRepoArchive,
  describeRepoBundles,
  fetchRepoManifest,
  preserveRepoArchive,
  preserveRepoManifest,
  REPO_BUNDLE_GRACE_MS,
  REPO_MAX_BYTES,
  repoBodySha256,
  repoBodySize,
  statRepoArchive,
  sweepRepoBundles,
  uploadRepoArchiveGuarded,
  uploadRepoBundle,
  uploadRepoManifestGuarded,
  type RepoBody,
  type RepoLineage,
  type RepoManifestRead,
  type RepoWriteOutcome,
} from './repo-archive'
import {
  needsCompaction,
  nextBundleChain,
  parseRepoManifest,
  type RepoManifest,
  type RepoManifestBundle,
  type RepoManifestLfsMissing,
} from './vendor/repo-bundles'
import { getRootfsPrev, getRootfsWatch, keptRootfsImage, reportColdBoot, stagedRootfsPath, type KeptImageName } from './self-update'
import type { ArchiveRef } from './archive-ref'
import { describeHomeStateArchive, uploadHomeStateGuarded } from './home-state-archive'
import type { QuarantineBookkeeping, QuarantineState } from './quarantine'

/**
 * How long a presigned hydrate URL stays valid.
 *
 * Matches the guest's own ceiling on a pull, so a URL never outlives the
 * transfer it was minted for. It is a bearer capability for one object handed
 * to guest code, so the bound matters more than the convenience.
 */
const PRESIGN_TTL_SEC = 30 * 60

/**
 * Workspace-relative dir the durable `.git` is extracted into before the guest
 * swaps it in. Under `.shogo/local`, which the guest's committer never stages.
 */
export const REPO_STAGING_DIR = '.shogo/local/repo-staging'

/**
 * Side dir the durable history is materialized into before an UNTRUSTED VM is
 * reconciled with it (SHO-442). Never the live `.git`: the reconcile only reads
 * it, and a failure must leave the workspace exactly as it was.
 */
export const REPO_RECONCILE_DIR = '.shogo/local/repo-reconcile'

/** Backoff between reconcile attempts for an untrusted VM. */
const REPO_HEAL_MIN_BACKOFF_MS = 60_000
const REPO_HEAL_MAX_BACKOFF_MS = 30 * 60_000

/** Outcome of one bundle-format persist. `unchanged` means durable already. */
type RepoPersist = 'written' | 'unchanged' | 'quarantined' | 'lost' | 'empty'

/** What `/pool/export-repo-bundle` answers with. `bundle` is null when nothing new needs sending. */
interface RepoBundleExport {
  bundle: RepoManifestBundle | null
  head: RepoManifest['head']
  refs: Record<string, string>
  config: string
  rootCommitAt: number | null
  /** Pointers whose bytes are on neither side; the history still exported. */
  lfsMissing?: RepoManifestLfsMissing[]
}

/** The guest refused a bundle export because its LFS objects could not be pushed. */
export class RepoBundleLfsPushError extends Error {}

/**
 * The guest's LFS push is still running (202). Not a failure: the next export
 * joins the same job, so a slow push finishes once instead of restarting
 * (SHO-442). Never a reason to fall back to the tarball.
 */
export class RepoBundleLfsPendingError extends Error {}

/**
 * The guest's `.git` is CORRUPT (`bad object` / `missing blob` on the export's
 * rev-list). Distinct from a transient LFS/network failure because no retry
 * repairs it: the same objects are still missing next time. Retrying it every
 * ten minutes re-exported and re-quarantined 525 MB for six days (SHO-584), so
 * the pool blocks rotation on it instead (see `noteRepoCorrupt`).
 */
export class RepoCorruptError extends Error {}

/** The guest's own code for that state, in the export's 503 body. */
export const REPO_CORRUPT_CODE = 'repo-corrupt'

/** The guest's `code`/`reason` from a failed export body, best-effort. */
function exportFailureCode(body: string): { code?: string; reason?: string } {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; reason?: unknown }
    return {
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    }
  } catch {
    return {}
  }
}

/** True when a failed export body says the repository itself is corrupt. */
function isRepoCorrupt(body: string): boolean {
  const { code, reason } = exportFailureCode(body)
  if (code === REPO_CORRUPT_CODE || reason === REPO_CORRUPT_CODE) return true
  // A guest too old to send the code still names the damage in the message.
  return /\bbad object\b|\bmissing blob\b|\bcorrupt\b/i.test(body)
}

/**
 * A stop was refused because the VM's current HEAD is not in the durable repo
 * (SHO-442). The VM keeps running; the next sweep retries. Never a reason to
 * drop the VM.
 */
export class RepoNotDurableError extends Error {}

/** Guests before `code` was added only send the message. */
function isLfsPushFailure(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown }
    return parsed.code === 'lfs-push-failed' || (typeof parsed.error === 'string' && parsed.error.startsWith('lfs push failed'))
  } catch {
    return false
  }
}

/** How often a project's unreferenced bundles are swept, at most. */
const REPO_BUNDLE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Same ref state, bundles and config: writing it again would change nothing. */
function sameManifestState(a: RepoManifest, b: RepoManifest): boolean {
  const canon = (m: RepoManifest) => JSON.stringify([m.head, m.refs, m.config, m.rootCommitAt, m.bundles])
  return canon(a) === canon(b)
}

/**
 * How long past its own deadline the host waits on `/pool/repo-hydrated`. The
 * guest gives up at `timeoutMs` and says so; this slack lets that answer
 * arrive, so a host timeout means the guest went silent, not that it was slow.
 */
const REPO_HYDRATED_SLACK_MS = 15_000

/** Header on `/pool/export-repo`: epoch ms of the repo's earliest root commit. */
const REPO_ROOT_COMMIT_AT_HEADER = 'x-shogo-repo-root-commit-at'

/**
 * A root commit this close to (or after) the VM's state start was made on this
 * boot. The slack absorbs guest/host clock skew.
 */
const REPO_BORN_ON_BOOT_SLACK_MS = 10 * 60_000

/** A guest's packed `.git` and when its history began (null if not reported). */
export interface RepoExport {
  bytes: RepoBody
  rootCommitAt: number | null
  /** sha256 of `bytes`, when the exporter computed it while reading. */
  sha256?: string
  /** Removes the export's spool file, if it has one. Idempotent. */
  dispose?: () => void
}

/** The guest's export exceeded the cap, so the host stopped reading it. */
export class ExportTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`export exceeds ${limit} bytes (read ${bytes})`)
  }
}

/**
 * A fetch deadline that can also be tripped by hand.
 *
 * `AbortSignal.timeout` only fires on its own schedule. When a body read stops
 * for any other reason — over the size cap, a full disk, a failed write — the
 * guest is still uploading an archive nobody will read, and closing the socket
 * is the only way to tell it to stop. Without that the guest's runtime keeps a
 * multi-gigabyte spool descriptor open for exports that are long abandoned
 * (SHO-352).
 */
function exportDeadline(ms: number): { signal: AbortSignal; abort: (reason?: unknown) => void; dispose: () => void } {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`export timed out after ${ms}ms`)), ms)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return {
    signal: ac.signal,
    abort: (reason?: unknown) => {
      if (!ac.signal.aborted) ac.abort(reason)
    },
    dispose: () => clearTimeout(timer),
  }
}

/**
 * Result of growing a workspace drive (SHO-349).
 *   - `{ fromMiB, toMiB }` — the drive grew (host mirror; the guest's own ext4
 *      size is what `df` reports after the following resize2fs).
 *   - `'unchanged'` — already at least that big, nothing to do.
 *   - `'unsupported'` — this host/guest has no workspace drive to grow.
 */
export type DriveResizeResult = { fromMiB: number; toMiB: number } | 'unchanged' | 'unsupported'

/** How long a rollout rotation that aborted waits before trying again. */
export const ROTATE_RETRY_MS = 10 * 60_000

/**
 * How long a rotation that is BLOCKED on an un-snapshottable database waits
 * before trying again.
 *
 * Retrying every {@link ROTATE_RETRY_MS} is how one broken database re-exported
 * and re-uploaded its 1.7 GB source bundle every ten minutes for four days
 * (SHO-541). A database that cannot be snapshotted does not heal on its own —
 * it needs a fixed guest or a human to recover it — so this retry is a slow
 * safety net, not a repair loop. Blocked is reported on `/status` and alerted
 * once, so it does not depend on anyone reading these retries.
 */
export const ROTATE_BLOCKED_RETRY_MS = 6 * 60 * 60_000

const REPO_EXPORT_MAX_BACKOFF_MS = 30 * 60_000
const REPO_EXPORT_MIN_BACKOFF_MS = 60_000

/**
 * Write a response body to `path`, failing once it passes `maxBytes`. Chunks
 * go straight to disk so a large export never sits whole in the heap, and are
 * hashed on the way through so the caller never has to re-read the file.
 */
export async function spoolResponse(
  res: Response,
  path: string,
  maxBytes: number,
): Promise<{ size: number; sha256: string }> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new ExportTooLargeError(declared, maxBytes)
  }
  const writer = Bun.file(path).writer()
  const hash = createHash('sha256')
  let size = 0
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength
        if (size > maxBytes) throw new ExportTooLargeError(size, maxBytes)
        hash.update(chunk)
        writer.write(chunk)
        await writer.flush()
      }
    }
  } finally {
    await writer.end()
    // Done early (over the cap, a failed write) the guest is still sending:
    // cancelling the reader closes the connection so it stops, instead of
    // streaming the rest of a multi-gigabyte archive into a socket we abandon.
    await res.body?.cancel().catch(() => {})
  }
  return { size, sha256: hash.digest('hex') }
}

/** The guest answered `/pool/repo-hydrated` with an error, so it did not adopt. */
export class RepoHydrateRefusedError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`/pool/repo-hydrated failed (${status}): ${body}`)
  }
}

/** The guest may have swapped `.git` and reset the tree, but the host never heard. */
export class RepoAdoptUncertainError extends Error {}

/**
 * `repoUntrustedReason` while an assign-time repo restore finishes behind an
 * open that already returned (see `hydrateRepoAtAssign`).
 */
/** How long a finished open waits for the retry that reports it (see reportOpen). */
const LATE_WAKE_TTL_MS = 15 * 60_000

export const REPO_DEFERRED_REASON = 'repo hydrate still downloading in the background'

/** The assign-time repo restore, as reported to the control plane. */
export interface RepoRestoreInfo {
  /** `deferred`: the open returned on the source's `.git`; the history swaps in later. */
  mode: 'foreground' | 'deferred' | 'none' | 'failed'
  bytes: number
  bundles: number
  /** How long the open itself waited on it. */
  foregroundMs: number
}

/** A repo restore up to (not including) the swap into the live tree. */
type RepoStage =
  | { kind: 'none' }
  /** Legacy guest: overlaid in place, nothing left to swap. */
  | { kind: 'applied'; parentEtag?: string; bytes: number }
  | {
      kind: 'staging'
      parentEtag?: string
      keepPaths: string[]
      bytes: number
      bundles: number
      /** The guest can refuse a late swap once the workspace is in use. */
      canDefer: boolean
      /** For logs: what is being restored. */
      describe: string
      /** The download into the staging dir, already running. */
      download: Promise<void>
    }

/** True if `p` settles (either way) within `ms`. Never throws. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The top-level paths whose durable source is not older than the durable repo.
 * When the repo's age is unknown, nothing is kept (the legacy full reset).
 *
 * A tie keeps the source: S3 `Last-Modified` has one-second resolution, and
 * the disk rescue writes the repo and then the source within the same second.
 * The source may hold edits that were never committed (a dead VM cannot flush
 * git), while keeping it still lands on top of the repo's full history.
 */
export function repoKeepPaths(sourceTimes: Record<string, number | null>, repoLastModified: number | null): string[] {
  if (repoLastModified === null) return []
  return Object.entries(sourceTimes)
    .filter(([, t]) => t !== null && t >= repoLastModified)
    .map(([path]) => path)
    .sort()
}

/**
 * Members a snapshot was stamped with that its runtime may not hold. Such a
 * snapshot is from before the single-runtime rule and would bring them back
 * online, so it is never resumed.
 */
function foreignStampedMembers(
  runtimeKey: string,
  s: Pick<SuspendedVm, 'memberDataEtags' | 'memberSourceEtags'>,
): string[] {
  const own = ownMemberIds(runtimeKey)
  const ids = new Set([...Object.keys(s.memberDataEtags ?? {}), ...Object.keys(s.memberSourceEtags ?? {})])
  return [...ids].filter((id) => !own.includes(id)).sort()
}

/** Rebuild per-member lineage from the ETags a snapshot was stamped with. */
function resumedMemberData(s: Pick<SuspendedVm, 'memberDataEtags' | 'memberSourceEtags'>): Record<string, MemberDataState> | undefined {
  const ids = new Set([...Object.keys(s.memberDataEtags ?? {}), ...Object.keys(s.memberSourceEtags ?? {})])
  if (ids.size === 0) return undefined
  const out: Record<string, MemberDataState> = {}
  for (const id of ids) {
    const data = s.memberDataEtags?.[id]
    const source = s.memberSourceEtags?.[id]
    out[id] = {
      ...(data ? { parentEtag: data } : {}),
      ...(source ? { sourceParentEtag: source, sourceLinked: true } : {}),
    }
  }
  return out
}

/**
 * After this long without a successful `/pool/activity`, a leftover
 * `activeStreams > 0` is a frozen turn, not a live one. Expire it so the
 * reaper and `/stop` can actually act. 3 minutes is comfortably longer than
 * a poll hiccup and far shorter than the hours mute guests sat pinned.
 */
const STALE_STREAM_TTL_MS = 3 * 60_000
/** Poll-fail + this long since last agent turn → treat as not busy. */
const MUTE_AGENT_IDLE_MS = 5 * 60_000
// A guest under memory pressure can take seconds to answer; failing this gate
// now costs a rescue, not just a reboot, so give it room before giving up.
const HEALTH_GATE_TIMEOUT_MS = 2000
const HEALTH_GATE_RETRIES = 4
/**
 * One longer probe before a running guest is discarded. A docker build can
 * pin every vCPU for minutes; that guest is slow, not wedged.
 */
const HEALTH_GATE_PATIENT_TIMEOUT_MS = 15_000
/**
 * Guest clock skew after a restore that is worth a warning + a metric. The
 * `Date` header has one-second resolution and a resumed guest is measured
 * mid-boot, so a few hundred ms is normal; five seconds means the clock really
 * did freeze (or the guest has no working time source), not that we were late.
 */
const GUEST_CLOCK_SKEW_ALERT_MS = 5000
/**
 * How long background activity polls must have been failing before open()
 * discards a running guest. Shorter than this, open() reports "busy" and the
 * caller retries.
 */
const MUTE_DISCARD_AFTER_MS = 10 * 60_000

export interface PooledVm {
  handle: FcVmHandle
  ready: boolean
  createdAt: number
  /** How long the guest took to answer /health after boot, for a probe's report. */
  healthMs?: number
}

/** What a rootfs boot probe saw. `POST /admin/probe-rootfs` returns this shape. */
export interface RootfsProbeResult {
  ok: boolean
  /** Why the probe failed, with the firecracker exit and the guest's last line. */
  error: string | null
  /** Time to the first healthy `/health`, or null when it never answered. */
  healthyAfterMs: number | null
  /** How the firecracker process ended, when it did. */
  fcExit: { code: number | null; signal: string | null } | null
  /** Last 20 serial lines of the probe VM. */
  serialTail: string
  /** How long the probe held the VM up after it answered /health. */
  heldMs: number
}

export interface RootfsProbeOptions {
  /** Override the hold window (METAL_ROOTFS_PROBE_HOLD_MS). */
  holdMs?: number
  /** Force the dm-snapshot boot path on or off (defaults per class, see probeBoot). */
  dmBase?: boolean
}

/** `POST /status` body: the substrate contract fields plus what re-warm needs. */
export interface ProjectStatus {
  exists: boolean
  ready: boolean
  replicas: number
  url?: string
  state: 'assigned' | 'suspended' | 'none'
  /** Whether the running guest / local snapshot is on the host's current rootfs. */
  rootfsFresh?: boolean
  assignedAt?: number
  lastRealActivityAt?: number
  realIdleMs?: number
  /** Wall-clock of the last real user request, and how long ago that was. */
  lastUserActivityAt?: number
  userIdleMs?: number
  activeStreams?: number
  /** The guest's own verdict on whether real agent work is running. */
  busy?: boolean
  /** Reports busy, but no user activity for longer than the busy-idle ceiling. */
  busyIdle?: boolean
  /** Rootfs the running guest booted from (assigned) or the local snapshot was taken on (suspended). */
  snapshotRootfsIdentity?: string
  /** A pre-warmed snapshot on the staged rootfs is held for this key (see `stagedSuspended`). */
  stagedSnapshotIdentity?: string
  /**
   * Whether a cold boot would restore this VM's latest work (SHO-442). The UI
   * shows a banner for anything but `ok`, and the alert fires on `untrusted` or
   * on `saving-failing` for more than 30 minutes.
   */
  durability?: ProjectDurability
  /**
   * The project database this VM is running cannot be snapshotted, so its
   * writable state is not being backed up (SHO-541). Present only while the
   * failure streak is live; `attempts` says how many consecutive exports
   * failed and `since` when the streak began.
   */
  dataSnapshot?: DataSnapshotFailure
  /**
   * The VM is on a superseded rootfs that rotation refuses to take, with the
   * reason. `stale_rootfs_blocked` means it will stay on the old runtime until
   * someone acts — the state Samsara's VM sat in for four days (SHO-541).
   */
  rotationBlocked?: RotationBlocked
}

/** Git durability of a running VM, as the API and the UI see it. */
export interface ProjectDurability {
  state: 'ok' | 'saving-failing' | 'untrusted'
  /** When the current state began: the last good save, or the VM's start. */
  since: number
  /** When this VM's HEAD last reached the durable repo, if it ever did. */
  lastSavedAt?: number
  reason?: string
}

/**
 * A VM whose database could not be snapshotted (SHO-541).
 *
 * `attempts` counts consecutive failures, so `since` is when the current
 * streak began and not when the VM was assigned — an alert needs to know how
 * long the project has had no writable-state backup.
 */
export interface DataSnapshotFailure {
  code: string
  message: string
  since: number
  attempts: number
}

/**
 * Why a VM on a superseded rootfs is still running, when rotation has given up
 * on its own. `stale_rootfs_blocked` is the state Samsara's VM sat in for four
 * days: rotation needs a final backup, the backup could not be taken, and
 * nothing reported it (SHO-541).
 */
export interface RotationBlocked {
  code: 'stale_rootfs_blocked'
  reason: string
  since: number
}

/** How a suspend request ended (see `suspendOrRetire`). */
export type SuspendOutcome =
  | { kind: 'suspended'; s: SuspendedVm; staged: boolean }
  /** Booted from a superseded rootfs: backed up and stopped without a snapshot. */
  | { kind: 'retired' }
  /**
   * Refused: the VM's current HEAD is not in the durable repo, so stopping it
   * would cold-start over unsaved work (SHO-442). It keeps running.
   */
  | { kind: 'refused'; reason: string }

/**
 * Whether an assigned VM is holding a slot someone needs (`active`) or is only
 * warm (`evictable`). See `MetalWarmPool.vmResidency`.
 */
export type VmResidency = 'active' | 'evictable'

/**
 * Liveness class of one assigned VM. `agent` = a streamed turn in flight or a
 * recent agent request, `app` = recent end-user app traffic, `idle` = neither —
 * including a guest that is busy with work no person asked for. See
 * `vmLiveness`, the ONE classifier the gauges, the bill and the reaper share.
 */
export type VmLiveness = 'agent' | 'app' | 'idle'

/**
 * Why the idle reaper is leaving an assigned VM resident right now.
 *
 *   alwaysOn  — paid, never idle-suspended
 *   refused   — its HEAD is not durable yet, so a suspend would lose work (backed off)
 *   busy      — a turn or task is in flight (`vmBusy`), retried at the next quiet poll
 *   window    — inside the idle window the reaper is applying
 *   legacy    — no per-class activity: its clock is the catch-all, which our own exports move
 *   evictable — past the window and idle: the next reaper pass suspends it
 *
 * `window`/`evictable` use the window the reaper ACTUALLY applied (the control
 * plane's relaxed directive when it has one), not `METAL_IDLE_SUSPEND_MS`.
 */
export type VmHoldReason = 'window' | 'busy' | 'refused' | 'alwaysOn' | 'legacy' | 'evictable'

/**
 * Why a VM was suspended. `idle` is the reaper's window; `evicted` is an
 * on-demand suspend to make room for an assign/resume on the same host (see
 * `makeRoom`). Carried on the snapshot so a resume can label its wake latency
 * with what it is paying for.
 */
export type SuspendReason = 'idle' | 'evicted'

/** `open({ rootfs: 'staged' })` on a host that holds no staged rootfs for the class. */
export class StagedRootfsUnavailableError extends Error {
  readonly code = 'no_staged_rootfs'
}

/**
 * Why a VM was started, as told by the control plane on `/assign`. Billing
 * reads this: most causes are billable running time, but `rewarm`/`prewarm`/
 * `published` are platform overhead (see `config/vm-pricing.ts` in apps/api).
 * `user_open` is the default so an older caller that sends nothing is still
 * metered rather than lost.
 */
export type VmCause = 'user_open' | 'agent_wake' | 'schedule' | 'published' | 'rewarm' | 'prewarm'

export const VM_CAUSES: readonly VmCause[] = [
  'user_open',
  'agent_wake',
  'schedule',
  'published',
  'rewarm',
  'prewarm',
]

export function isVmCause(v: unknown): v is VmCause {
  return typeof v === 'string' && (VM_CAUSES as readonly string[]).includes(v)
}

/**
 * Cumulative running time of ONE VM since it was assigned, in milliseconds, by
 * why it was running. Advanced on each heartbeat/reaper tick from the same
 * classification `classifyAssigned` buckets the fleet by, and never reset for
 * the life of the VM — so a heartbeat the control plane never receives costs
 * nothing, the next one carries the full total.
 */
export interface VmMeter {
  agentMs: number
  appMs: number
  idleMs: number
  /** Wall-clock of the last advance. Elapsed since here is what the next tick charges. */
  advancedAt: number
}

/** One VM's meter as reported to the control plane (see `meterReport`). */
export interface VmMeterReport {
  runtimeKey: string
  vmId: string
  assignedAt: number
  /** CPU count the host actually booted (the handler's), never the env accounting. */
  vcpus: number
  /** MiB the host actually booted. */
  memMiB: number
  vmClass: string
  cause: VmCause
  alwaysOn: boolean
  agentMs: number
  appMs: number
  idleMs: number
  /** Set once the VM stopped being assigned; the row is held until the control plane acks it. */
  endedAt?: number
}

export interface AssignedVm {
  projectId: string
  handle: FcVmHandle
  assignedAt: number
  lastTouchedAt: number
  /** Why this VM was started (billing). Undefined on an adopted VM = `user_open`. */
  cause?: VmCause
  /** Billing counters (see {@link VmMeter}); created on the first tick. */
  meter?: VmMeter
  /** Snapshot files this VM was restored from; protected from orphan reclaim. */
  restoredFrom?: { vmstate: string; mem: string }
  /**
   * Identity of the golden rootfs this VM's guest actually booted from. It can
   * differ from the host's current identity: a VM adopted across a rootfs
   * rebuild keeps running the old image. Its snapshot must carry THIS identity
   * so it is recognised as stale, not the host's current one. Undefined for
   * VMs adopted from a registry entry that predates the field.
   */
  bootRootfsIdentity?: string
  /** Last activity counter seen from the guest (for the activity poll). */
  lastActivityAt?: number
  /**
   * Wall-clock (ms) of the last thing a USER did on this VM — an app request, an
   * agent turn, or a live stream. This is what `reapIdle` gates on, deliberately
   * NOT `lastTouchedAt` and NOT the guest's catch-all `lastRequestAt`.
   *
   * Both of those measure our own machinery, not a user:
   *   - `lastTouchedAt` answers "did anything ask about this VM", which a
   *     control-plane routing/status poll satisfies and which the activity poll
   *     also sets whenever it fails open. Both fire on the reaper's interval, so
   *     its idle age can never grow past one poll cycle.
   *   - the guest's `lastRequestAt` counts every request it served, including
   *     the writable-state and published-data export sweeps that call
   *     `/pool/export-data` on EVERY assigned VM every 120s. Gating on it was
   *     the same bug one layer down: production held 202 VMs resident, 67 of
   *     them sharing `realIdleMs` to the millisecond because one sweep stamped
   *     them all, while 93 had never served a single app or agent request.
   *
   * So this advances only on the guest's own per-class user signals
   * (`lastAppRequestAt`, `lastAgentRequestAt`, `activeStreams`). Seeded at
   * assign/resume/adopt so a freshly-placed VM gets a full window before its
   * first request.
   */
  lastRealActivityAt?: number
  /**
   * MiB the balloon is currently holding, i.e. RAM this idle VM has handed back
   * to the host (SHO-534). `undefined` = nothing reclaimed. Set by
   * `reclaimIdleVms`, cleared by the first sign of activity (`deflateReclaimed`),
   * which is fire-and-forget so it never sits on a request's path.
   */
  balloonedMiB?: number
  /**
   * This VM's agent does not expose balloon statistics (it booted before reclaim
   * asked for them), so its RAM cannot be sized safely. `reclaimIdleVms` skips it
   * from then on instead of re-probing every tick, and never blind-inflates it.
   */
  balloonUnsupported?: boolean
  /**
   * Wall-clock (ms) of the last time this VM's balloon was touched — handed back
   * on activity, or probed by the idle pass and found to have nothing above the
   * floor. The hysteresis for `reclaimIdleVms`: a VM is not reclaimed again until
   * a full window passes, so a VM woken every few seconds cannot flap between
   * inflated and deflated, and a guest that is already at its floor is not
   * re-probed on every tick.
   */
  lastBalloonAt?: number
  /**
   * Wall-clock (ms) of the last time a PERSON used this VM, on a clock that only
   * real user requests move. `lastRealActivityAt` cannot serve this purpose: it
   * is stamped on every poll where the guest reports busy, so a guest stuck
   * reporting `busy: true` always looks freshly active and a ceiling on it would
   * never fire.
   *
   * Advances only where the guest's per-class signals advance — an app request,
   * an agent turn, or (for a legacy guest) the catch-all. It does NOT move on
   * `vmBusy`, `lastTouchedAt`, `touch()`, or a failed poll. Seeded to `now` at
   * assign/resume, and corrected from the guest's own report on the first
   * baselining poll so a host restart does not hand a 47h-idle VM another
   * ceiling (see `reapIdle`).
   */
  lastUserActivityAt?: number
  /**
   * Set only by `adopt()`: this VM's real-activity history did not survive the
   * host restart, so `lastUserActivityAt` was seeded to `now` and the first
   * per-class report must correct it from the guest's own clock.
   *
   * Deliberately NOT set by assign or resume. Both are a user action happening
   * right now, so `now` is the truth; correcting a resume from the snapshot's
   * frozen `lastAppRequestAt`/`lastAgentRequestAt` would suspend a VM the
   * moment it came back, because the reaper polls and reaps in the same tick
   * and the page load that triggered the resume only bumps `lastAppRequestAt`
   * for `/api/*` (SHO-420 QA round 1).
   */
  needsUserActivityBaseline?: boolean
  /**
   * Wall-clock (ms) the current unbroken busy streak started: set by the first
   * successful poll that reports busy, cleared by any successful poll that does
   * not. A failed poll leaves it alone. The busy-idle ceiling requires this to
   * be past the ceiling too, so a real turn driven by something other than an
   * app request or `/agent/chat` (a project call, a trigger hook, a webchat or
   * channel message) is not frozen mid-stream just because no person has used
   * the VM for hours. A stuck guest never reports not-busy, so its streak only
   * grows. On adopt it is seeded from the baselined `lastUserActivityAt`, so a
   * deploy does not hand a stuck guest another full ceiling.
   */
  busySince?: number
  /** Wall-clock of the last periodic source backup (in memory only; see exportAllSource). */
  lastPeriodicSourceBackupAt?: number
  /**
   * Active agent message streams the guest reported at the last activity poll.
   * `> 0` means a live generation is in flight, so the idle reaper must not
   * snapshot the VM away (it would kill the turn). Refreshed each pollActivity.
   */
  activeStreams?: number
  /**
   * What the guest itself says about being busy: real agent work is running
   * (`activeTurns + activeTasks + live` streams). Set by `/pool/activity` when
   * the guest reports it; `undefined` for older guests, in which case the raw
   * `activeStreams` counter is used.
   *
   * This is what the idle reaper, the recycler and `isBusy` gate on. Trusting
   * `activeStreams` alone is how a stream whose turn was stopped or frozen
   * pinned a guest busy for hours: it was never suspended, never resumed, and
   * so never got a fresh AI_PROXY_TOKEN — the Odin incident (SHO-348).
   */
  busy?: boolean
  /**
   * The guest's breakdown behind `busy`, from `/pool/activity`. `activeTurns` is
   * agent turns in flight; `liveStreams` is streams that still hold their turn.
   *
   * Past `rolloutDeadlineMs` these are the only thing that blocks a rootfs
   * rotation (`vmInTurn`): a background task or a card-watch mirror can keep
   * `busy` true forever, but a turn is a person waiting on an answer (SHO-399).
   * Undefined on a guest too old to report them, where `busy` is all we have.
   */
  activeTurns?: number
  liveStreams?: number
  /**
   * Wall-clock (ms) of the last request the guest classified as *app usage* —
   * an end-user hitting the built app's `/api/*` sidecar. Together with
   * `lastAgentRequestAt` this GATES the idle reaper (see `lastRealActivityAt`):
   * unlike the guest's catch-all `lastRequestAt`, it excludes the host's own
   * export/activity sweeps, so it means a person actually used the app.
   * Undefined until the first app request. Refreshed each poll.
   */
  lastAppRequestAt?: number
  /** Guest-reported count of app-usage requests (monotonic). */
  appRequestCount?: number
  /**
   * Wall-clock (ms) of the last *agent chat* turn the guest served (someone
   * talking to Shogo). Gates the reaper alongside `lastAppRequestAt`, and is the
   * companion to `activeStreams` for a turn that is still in flight.
   */
  lastAgentRequestAt?: number
  /**
   * Whether a PERSON has used this VM since it was placed. `false` on a VM the
   * platform started on its own initiative (a schedule tick, an agent wake, a
   * `rewarm`/`prewarm`), `true` for a `user_open`/`published` one, and flipped
   * to `true` by the first app/agent request that arrives afterwards.
   *
   * It narrows the idle window for such a VM to the aggressive one even under a
   * relaxed directive: nobody asked for those 4 hours, so a scheduled wake must
   * not buy them (SHO-533). `undefined` (an adopted VM, cause unknown) is never
   * narrowed.
   */
  userSeenSinceAssign?: boolean
  /**
   * Consecutive idle-suspend refusals and when the streak started. A refusal
   * means the guest's HEAD is not in the durable repo yet (SHO-442), so the VM
   * cannot be suspended — but every attempt pays a full repo export, so retrying
   * one every scan starves the reaper of the passes every OTHER idle VM needs.
   * The streak backs the retry off (see `refuseBackoffMs`) and is cleared by the
   * first suspend that succeeds.
   */
  refuseCount?: number
  refusedSince?: number
  /** Don't attempt this VM again before this wall-clock (refusal backoff). */
  refuseRetryAt?: number
  /** The once-per-VM refusal warning has been logged. */
  refusalLogged?: boolean
  /**
   * Whether the guest reports the per-class fields at all. An older runtime
   * image omits them entirely (as opposed to sending `null`, which means
   * "supported, but it has never happened"). For such a guest the only signal
   * available is the catch-all `lastRequestAt`, so we fall back to it rather
   * than suspend a VM that may well be serving real users invisibly.
   */
  perClassActivity?: boolean
  /**
   * Always-on (paid instance tier): the idle-suspend reaper must never suspend
   * this VM. Set from the control-plane's `SHOGO_ALWAYS_ON` assign env on every
   * open and persisted so it survives adopt-on-restart.
   */
  alwaysOn?: boolean
  /**
   * The guest's `RUNTIME_AUTH_SECRET` (from the assign env). Needed to call the
   * guest's authenticated `/pool/export` when saving the source backup on
   * suspend. Persisted so it survives adopt-on-restart. Host-local only.
   */
  runtimeToken?: string
  /** Mounted member ids for a merged-root workspace runtime. */
  workspaceMemberIds?: string[]
  /**
   * Set for a SERVER-BACKED published microVM (assign env `SHOGO_PUBLISHED_MODE`
   * + `PUBLISHED_SUBDOMAIN`). Marks this VM as owning a live site's writable
   * state, so the pool hydrates `{subdomain}/data.tar.gz` into it on cold boot
   * and exports it back to S3 periodically / on suspend (host-side, since the
   * guest holds no S3 creds). Absent on ordinary dev/preview VMs.
   */
  publishedSubdomain?: string
  /**
   * The guest's database descends from `{subdomain}/data.tar.gz`: the pool
   * hydrated it at boot, or confirmed the bucket held none. Only such a VM may
   * export, because every export overwrites the live site's data.
   */
  publishedDataLoaded?: boolean
  /** sha256 of the last published-data archive this VM uploaded (memory only). */
  publishedExportSha?: string
  /**
   * Lineage of this VM's workspace — where its current source came from, so the
   * write side can tell whether it may overwrite the durable backup:
   *   'template' → a warm VM's pristine template (new project, or a cold boot
   *                that found no durable backup). MUST NOT overwrite an existing
   *                backup (that is the data-loss incident): a template export
   *                over a real backup is quarantined, never written.
   *   'backup'   → cold-hydrated from the durable backup at assign time.
   *   'snapshot' → restored from a local/durable snapshot (which itself
   *                descends from a backup, carried via SnapshotMeta.backupEtag).
   * Undefined only transiently before assign/resume stamps it.
   */
  workspaceOrigin?: 'template' | 'backup' | 'snapshot'
  /**
   * ETag of the durable backup this workspace descends from. `saveBackupToStore`
   * only overwrites the durable object when this still matches what's in S3;
   * otherwise it quarantines rather than clobber. Undefined = template/unknown
   * lineage (see workspace-archive's guard). Refreshed after every successful
   * backup write and persisted for adopt-on-restart.
   */
  backupParentEtag?: string
  /**
   * ETag of the durable WRITABLE-STATE archive (`project-data.tar.gz`) this
   * workspace's database descends from. Sent as the `If-Match` precondition,
   * so the storage layer — not a check we perform first — enforces that this
   * VM can only replace the exact archive it came from.
   * Undefined = no proven descent; see `dataUntrustedReason`.
   */
  dataParentEtag?: string
  /**
   * Set when this workspace's database provenance is known to be BAD: the
   * writable-state hydrate failed, so the VM is running on whatever database
   * the source archive happened to contain (usually an empty one). Its exports
   * are refused outright rather than being sized up and guessed about — an
   * empty database overwriting a populated archive is the exact shape of the
   * incident this subsystem exists to prevent.
   *
   * Takes precedence over `dataParentEtag`. Holds the human-readable reason so
   * the refusal log says what actually went wrong.
   */
  dataUntrustedReason?: string
  /** Epoch ms of the last successful `project-data.tar.gz` upload (large-DB cadence limit). */
  dataLastUploadAt?: number
  /** Size of the last exported writable-state archive (large-DB cadence limit). */
  dataLastBytes?: number
  /** UTC date (YYYY-MM-DD) of the last daily restore point copied for this project. */
  dataLastDailyCopyDate?: string
  /**
   * Workspace runtimes (`ws:` keys): writable-state lineage per MEMBER project,
   * keyed by member id. Each member's database lives in its own subfolder and
   * is backed up to `{memberId}/project-data.tar.gz`, so each needs its own
   * lineage — the top-level `dataParentEtag` is unused for these VMs.
   */
  memberData?: Record<string, MemberDataState>
  /**
   * The guest predates `/pool/export-data` and answers 404. A running VM never
   * gains the endpoint — only a reboot onto a newer rootfs does, and that
   * produces a different AssignedVm — so this is permanent for this VM's life
   * and the periodic exporter skips it entirely. Without this, every VM alive
   * at rollout re-requests (and re-logs) a 404 on every cycle until it is
   * recycled, which on a full fleet buries real failures in noise.
   */
  dataExportUnsupported?: boolean
  /** Consecutive transient export failures, for backoff. */
  dataExportFailures?: number
  /** Epoch ms before which the periodic exporter should not retry. */
  dataExportRetryAfter?: number
  /**
   * The guest answered `/pool/export-data` with `sqlite_snapshot_failed`: it
   * cannot produce a snapshot of the project database. Set from the guest's
   * named code rather than the message, because the message is SQLite's and
   * changes with the shape of the damage.
   *
   * Until this exists a failing snapshot looked exactly like a slow guest: it
   * logged a 500 line every cycle and nothing else (SHO-541 — Samsara's VM went
   * four days and 336 failures with no alert, and could never rotate because
   * rotation needs a final backup first).
   */
  dataSnapshotFailure?: DataSnapshotFailure
  /**
   * ETag of the encrypted home-directory archive (`home-state.enc`) this VM's
   * `~/.ssh`, `~/.oci`, ... descend from. Same role as `dataParentEtag`.
   */
  homeParentEtag?: string
  /**
   * Sticky: the home hydrate failed, so this VM is running on an empty home
   * while a real archive may still exist. Its exports are refused outright.
   */
  homeUntrustedReason?: string
  /**
   * The guest answered 404: an older runtime, or no `HOME_STATE_KEY` was
   * assigned. Permanent for this VM's life, so it is never asked again.
   */
  homeExportUnsupported?: boolean
  /** Consecutive transient home-export failures, for log throttling. */
  homeExportFailures?: number
  /**
   * ETag of the durable `.git` archive (`repo.git.tar.gz`) this VM's repo
   * descends from. Same role as `dataParentEtag`. Host-mediated: the guest
   * has no S3 creds, so this is what authorizes the next host upload.
   */
  repoParentEtag?: string
  /** Sticky: repo hydrate failed, so exports must not clobber the durable `.git`. */
  repoUntrustedReason?: string
  /**
   * Sticky: the guest may have rewritten this VM's source tree without the
   * host knowing (a repo adopt that outlived the host's deadline), so its
   * source export is quarantined and its snapshot is never kept. Workspace
   * runtimes record this per member in `memberData`.
   */
  sourceUntrustedReason?: string
  /**
   * Epoch ms from which this VM's workspace is its own: the assign for a cold
   * boot, the snapshot's suspend for a resume. A durable write after this came
   * from some other VM.
   */
  stateSince?: number
  /**
   * The assign-time repo hydrate is still running. The guest's `.git` is the
   * template seed until it lands, so it must not be exported yet.
   */
  repoHydratePending?: boolean
  /**
   * This VM hydrated `.git` against the durable archive at assign. With no
   * parent etag that means no archive existed then, so a later conflict is
   * another VM's write and never grounds for promotion.
   */
  repoLinked?: boolean
  /** How the assign-time repo restore went, reported once with the open. Memory only. */
  repoRestore?: RepoRestoreInfo
  /** Last `repoHeadSha` the guest reported; export when it changes. */
  repoHeadSha?: string
  /**
   * The guest reported that its root holds no git repo at all (a merged
   * workspace runtime keeps its projects' repos in subfolders). There is
   * nothing to export and nothing that can be undurable, so the sweep must not
   * ask — and a HEAD cached before that report must not pin it (SHO-540).
   */
  repoAbsent?: boolean
  /**
   * The `repoHeadSha` whose `.git` is already durable (written or
   * quarantined). The periodic sweep skips the VM while HEAD still matches.
   */
  repoExportedHeadSha?: string
  /**
   * sha256 of the last `.git` archive this VM made durable (written or
   * quarantined). An export with the same bytes is skipped. Memory only.
   */
  repoExportSha?: string
  /** Periodic `.git` export failed; the sweep leaves it alone until then. */
  repoExportRetryAt?: number
  /** Consecutive periodic `.git` export failures, for backoff. */
  repoExportFailures?: number
  /** HEAD whose `.git` was last copied to `conflict/` while untrusted (SHO-442). */
  repoQuarantinedHeadSha?: string
  /** Key of the last quarantine copy written for this VM (SHO-442). */
  repoQuarantineKey?: string
  /** Consecutive failed reconcile attempts, and when to try again (SHO-442). */
  repoHealFailures?: number
  repoHealRetryAt?: number
  /** When this VM's HEAD last reached the durable repo (for the unsaved-age gauge). */
  repoLastSavedAt?: number
  /** First consecutive `/pool/activity` failure (undefined while polls succeed). */
  activityPollFailedAt?: number
  /** Last health/activity poll outcome. `false` = assigned-but-unhealthy. */
  lastHealthOk?: boolean
  /** When a project API sidecar in this VM was first seen unhealthy (cleared once healthy). */
  apiUnhealthySince?: number
  /** `projectId:phase` of each unhealthy sidecar, for logs. */
  apiUnhealthyProjects?: string[]
  /** Observe-mode watchdog already logged this unhealthy episode. */
  apiWatchdogObserved?: boolean
  /**
   * `conflict/` bookkeeping: the last copy per archive kind (for dedupe) and the
   * number written today against this project's daily cap. Persisted so an agent
   * restart does not reset the cap — twelve restarts a day would otherwise mean
   * twelve fresh caps and the same unbounded loop (SHO-584).
   */
  quarantine?: QuarantineState
  /**
   * Whether the open that created this VM ever finished hydrating (SHO-584).
   * `'opening'` is written BEFORE any hydrate runs, so an entry still carrying
   * it was cut off — its source/data/home/repo are a partial tree, never a
   * workspace to back up over the durable one.
   */
  openState?: 'opening' | 'ready'
  /**
   * The guest reported its `.git` as corrupt (`bad object` / `missing blob` on
   * the export's rev-list). Permanent for this VM: no retry repairs it, so
   * rotation is blocked instead of re-exporting 525 MB every ten minutes
   * (SHO-584). Persisted so an adopt does not reset the retry clock.
   */
  repoCorruptFailure?: { code: string; message: string; since: number; attempts: number; retryAt: number }
  /** Rollout rotation waits until then after an aborted attempt. Persisted (SHO-584). */
  rotateRetryAt?: number
  /** Rotation has given up on this VM's rootfs, and why. Persisted (SHO-584). */
  rotationBlocked?: { reason: string; since: number }
}

/**
 * `final` marks the last export before a VM goes away (suspend, recycle): it
 * bypasses the large-database cadence limit and quarantines refused bytes.
 * `reason` only labels the upload metric.
 */
type SourceSaveResult = 'written' | 'empty' | 'quarantined' | 'lost'

export interface RecycleStep {
  step: string
  ok: boolean
  detail?: string
}

/** One foreign member `drainForeignMembers()` took off a workspace VM. */
export interface ForeignMemberDrainResult {
  runtimeKey: string
  projectId: string
  /** `conflict`: the export was quarantined; `failed`: the member is still mounted. */
  outcome: 'exported' | 'conflict' | 'empty' | 'failed'
  detail?: string
}

/** What `recycle()` did. `aborted` means nothing was removed. */
export interface RecycleReport {
  runtimeKey: string
  state: 'assigned' | 'suspended' | 'none'
  resumed: boolean
  forced: boolean
  aborted: boolean
  steps: RecycleStep[]
  destroyed?: { stoppedVm: boolean; removedLocal: boolean; removedDurable: boolean }
  /**
   * Things that happened because this recycle ran and that the caller should
   * pass on — today, what `.tmp/` held that the backup does not carry (SHO-399).
   */
  notices?: string[]
  /**
   * What `.tmp/` held when the recycle looked (SHO-399). `.tmp/` is excluded
   * from the backup, so this is the list of what will not come back.
   */
  tmp?: DroppedTmpReport
}

/** What the guest measured in `.tmp/` before this VM was replaced (SHO-399). */
export interface DroppedTmpReport {
  files: number
  bytes: number
  /** Top-level entry names, capped by the guest — what the owner chat is told. */
  entries?: string[]
}

/** Parse the guest's `.tmp/` measurement, if it reported one (SHO-399). */
function readTmpReport(raw: Partial<DroppedTmpReport> | null | undefined): DroppedTmpReport | undefined {
  const files = Number(raw?.files) || 0
  if (files <= 0) return undefined
  const entries = Array.isArray(raw?.entries)
    ? raw.entries.filter((e): e is string => typeof e === 'string').slice(0, 10)
    : []
  return { files, bytes: Number(raw?.bytes) || 0, ...(entries.length ? { entries } : {}) }
}

interface DataSaveOpts {
  final?: boolean
  reason?: 'periodic' | 'final' | 'recycle'
}

/** What `recycle()` may be asked to do. */
export interface RecycleOpts {
  reason?: string
  env?: Record<string, string>
  /** Remove the VM even if a backup failed (the caller knows it is gone). */
  force?: boolean
  /** Release rotation: settle background tasks before the source backup. */
  stopBackgroundTasks?: boolean
}

/**
 * The guest's named code for "I cannot snapshot the project database"
 * (`packages/agent-runtime/src/writable-state.ts`). A string the two sides
 * share, so a rename on one side fails loudly instead of quietly matching
 * nothing.
 */
export const SQLITE_SNAPSHOT_FAILED = 'sqlite_snapshot_failed'

/** An error from the guest's export endpoint, carrying the code it sent. */
export interface GuestExportError extends Error {
  code?: string
}

/** What `/pool/export-data` gave back: bytes, or why it gave none. */
type DataExportResult = { bytes: Uint8Array; tag: string | null } | 'unchanged' | 'unsupported' | null

/**
 * Turn a failed `/pool/export-data` reply into an error, keeping the guest's
 * own `code`. The body is JSON (`{ error, code }`) for a named failure and may
 * be anything at all for an unhandled one, so the raw text is kept for the log
 * and the guest's own message is used when there is one — that message ends up
 * on the VM's status, where `{"error":…}` JSON is unreadable.
 */
async function exportError(res: Response): Promise<GuestExportError> {
  const text = await res.text()
  let code: string | undefined
  let message = text
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.code === 'string') code = parsed.code
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) message = parsed.error.trim()
  } catch {}
  const err = new Error(`/pool/export-data failed (${res.status}): ${message}`) as GuestExportError
  if (code) err.code = code
  return err
}

/**
 * One writable-state backup target: a single-project VM (the top-level
 * `dataParentEtag` fields) or one member of a workspace runtime. `commit`
 * persists `state` back to wherever it lives.
 */
interface DataSlot {
  /** Id the archive is stored under: `{storageId}/project-data.tar.gz`. */
  storageId: string
  /** Serialization + change-tag key; unique per target. */
  flightKey: string
  /** Guest workspace dir to export; undefined = the runtime root. */
  dir?: string
  label: string
  state: MemberDataState
  commit(): void
}

export interface SuspendedVm {
  projectId: string
  snapshot: FcSnapshot
  suspendedAt: number
  lastAccessAt: number
  /**
   * ETag of the durable backup that was current when this snapshot was taken —
   * the workspace frozen in the snapshot descends from it. Carried back into
   * AssignedVm.backupParentEtag on resume so a resumed VM's next suspend can
   * safely overwrite the backup it actually derives from. Undefined for a
   * legacy snapshot taken before lineage stamping shipped.
   */
  backupEtag?: string
  /**
   * ETag of the durable writable-state archive current when this snapshot was
   * taken. Carried back into AssignedVm.dataParentEtag on resume, so a resumed
   * VM's next export can overwrite the data archive its database derives from.
   */
  dataEtag?: string
  /** ETag of the encrypted home archive when this snapshot was taken. Carried into AssignedVm.homeParentEtag. */
  homeEtag?: string
  /** Carried back into AssignedVm.publishedDataLoaded on resume. */
  publishedDataLoaded?: boolean
  /** Workspace runtimes: per-member `dataEtag`. Carried back into AssignedVm.memberData. */
  memberDataEtags?: Record<string, string>
  /** Workspace runtimes: per-member source backup ETag. Carried back into AssignedVm.memberData. */
  memberSourceEtags?: Record<string, string>
  /**
   * ETag of the durable `.git` archive current when this snapshot was taken.
   * Carried back into AssignedVm.repoParentEtag on resume.
   */
  repoEtag?: string
  /**
   * Golden-rootfs identity this snapshot was taken against. A Firecracker
   * resume restores the frozen guest RAM verbatim, so it only makes sense on a
   * byte-compatible rootfs; after a rootfs rebuild (new guest code / deps) a
   * mismatch must cold-boot instead so the project picks up the new userspace —
   * the same gate the durable store's pull() already enforces. Optional so a
   * legacy index entry written before identities were stamped is treated as
   * compatible (never mass-cold-boots the fleet on the first deploy of this).
   */
  rootfsIdentity?: string
  /** See CacheEntry.workspaceOrigin. */
  workspaceOrigin?: 'template' | 'backup' | 'snapshot'
  /** See CacheEntry.durablePending. */
  durablePending?: boolean
  /**
   * Why this VM was suspended: the reaper's idle window (`idle`) or an
   * on-demand eviction to make room for another assign on this host
   * (`evicted`). A resume reports it back so wake latency can be split by what
   * the user is paying for — an evicted VM's resume is the cost of the bucket.
   * Absent on snapshots taken before this shipped.
   */
  suspendReason?: SuspendReason
}

export interface GcReport {
  triggered: boolean
  evicted: string[]
  durableRemoved: string[]
  /**
   * Projects whose local snapshot was dropped because it was taken against a
   * different golden rootfs and can therefore never be restored here. Reported
   * separately from `evicted` because it is not a capacity decision — these
   * were already dead, whatever the disk looked like.
   */
  staleReclaimed: string[]
  orphansRemoved: number
  bytesReclaimed: number
  disk: DiskUsage
}

/**
 * Orphan reclaim never touches artifacts younger than this — the window in
 * which a VM's files exist on disk but aren't yet recorded in a live map (mid
 * cold-boot, mid-assign, mid-snapshot). Comfortably longer than the slowest
 * boot+assign under heavy-op queueing, short enough that superseded files from
 * a re-suspend are still reclaimed promptly.
 */
const ORPHAN_GRACE_MS = 180_000

/**
 * How many unresumable (wrong-rootfs) snapshots one GC sweep may unlink. Lower
 * than the orphan-device bound because each of these is gigabytes of memory
 * file rather than a device node.
 */
const STALE_RECLAIM_PER_SWEEP = 100

/**
 * Hand the event loop back so the agent can serve requests between two pieces
 * of blocking filesystem work. `setImmediate` runs after pending I/O callbacks,
 * which is what makes it a real yield rather than a busy tick.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * How recently a VM must have served a request of a given class — an end-user
 * app request, or an agent turn — to still count as live in that class.
 * Generous enough to bridge the gaps between a real user's requests (page
 * loads, API calls) without flapping the bucket, short enough that a
 * genuinely-abandoned VM falls into the idle tail.
 *
 * One window for both classes, and one consumer: `vmLiveness` decides the
 * fleet gauges, the bill AND (through `lastRealActivityAt`) whether the idle
 * reaper may suspend the VM. A VM the reaper has to leave resident because
 * someone just used it is the same VM the meter must not call idle — the two
 * disagreeing is what billed 96% idle VM-hours on boxes that never idled
 * (SHO-533).
 */
const ACTIVITY_WINDOW_MS = 120_000

/**
 * How long a stopped VM's final meter is retried before it is dropped, and how
 * many of them are held at once. The counters are cumulative, so the control
 * plane normally ingests a closed VM on the very first heartbeat that carries
 * it; these bounds only matter for a control plane that is unreachable for an
 * hour or a busy host that churns more than 2,000 VMs inside one.
 */
const CLOSED_METER_TTL_MS = 60 * 60_000
const MAX_CLOSED_METERS = 2_000

/**
 * How many VMs one reaper tick will hand RAM back for (SHO-534). Each reclaim is
 * a stats read plus one PATCH (the inflate itself lands later, guest-paced), so
 * a pass costs a few milliseconds per VM — but a host that suddenly goes quiet
 * saw 150 VMs idle at once, and a tick that touched all of them at once would
 * still be a burst of FC control traffic. The rest wait for the next tick.
 */
const MAX_IDLE_RECLAIMS_PER_PASS = 8

/**
 * Hard ceiling on a hydrate deadline, whatever the per-MiB budget works out to.
 *
 * The guest clamps its own pull at 30 minutes (PULL_MAX_SECONDS in
 * agent-runtime's hydrate-url handler), so a host budget beyond that buys
 * nothing: the guest gives up first and the host spends the difference waiting
 * for an answer it has already been told. Matching the two keeps the failure
 * attributable to the side that actually decided it.
 */
const HYDRATE_BUDGET_CEILING_MS = 30 * 60_000

/**
 * Extract the published subdomain from an assign env when the control plane
 * flagged this as a server-backed published microVM. Returns undefined for an
 * ordinary dev/preview VM (no PUBLISHED_SUBDOMAIN / SHOGO_PUBLISHED_MODE).
 */
/**
 * The project whose durable source a `published:{id}` runtime serves, or null
 * for any other key.
 *
 * A published microVM is a read-only copy of its project: it boots from the
 * project's own `{id}/project-src.tar.gz` and never writes source, `.git` or
 * project-data archives (its live data is `{subdomain}/data.tar.gz`). Keyed by
 * the runtime key instead, it restored `published:{id}/…` — archives only its
 * own earlier boots ever wrote, from the template — so every cold boot served
 * the starter app and backed it up again.
 */
export function publishedSourceId(runtimeKey: string): string | null {
  return runtimeKey.startsWith('published:') ? runtimeKey.slice('published:'.length) || null : null
}

function publishedSubdomainFromEnv(env: Record<string, string>): string | undefined {
  const published = env.SHOGO_PUBLISHED_MODE === 'true' || env.SHOGO_PUBLISHED_MODE === '1'
  const subdomain = env.PUBLISHED_SUBDOMAIN
  return published && subdomain ? subdomain : undefined
}

/**
 * Home-directory persistence is per runtime key. A `ws:` runtime holds at most
 * its own anchor project (see {@link ownMemberIds}), so its home belongs to it
 * alone. A published site never carries the agent's home.
 */
function homeStateEligible(publishedSubdomain: string | undefined): boolean {
  return !publishedSubdomain
}

/** A workspace runtime's member project ids from its assign env; undefined when not given. */
function workspaceMemberIdsFromEnv(env: Record<string, string>): string[] | undefined {
  return typeof env.WORKSPACE_PROJECT_IDS === 'string'
    ? env.WORKSPACE_PROJECT_IDS.split(',').map((id) => id.trim()).filter(Boolean)
    : undefined
}

/**
 * The only projects a runtime may hold online. A project is live in exactly
 * one VM — its own `ws:proj:<id>` — so that VM's single member is itself, and a
 * workspace session runtime (`ws:<workspaceId>`) holds none; other runtimes
 * reach a project through the remote tool channel. Two VMs holding one project
 * both wrote its backups, and each write made the other's snapshot stale.
 */
export function ownMemberIds(runtimeKey: string): string[] {
  if (runtimeKey.startsWith('ws:proj:')) {
    const id = runtimeKey.slice('ws:proj:'.length)
    return id ? [id] : []
  }
  return []
}

/** A mount that would put a project online in a runtime other than its own. */
export class ForeignMemberError extends Error {
  constructor(
    readonly runtimeKey: string,
    readonly projectId: string,
  ) {
    super(
      `refusing to mount ${projectId} into ${runtimeKey}: a project is only online in its own runtime ` +
        `(ws:proj:${projectId})`,
    )
  }
}

/** Assign-env keys holding member id lists the pool or guest acts on. */
const MEMBER_ID_ENV_KEYS = ['WORKSPACE_PROJECT_IDS', 'WORKSPACE_NEW_PROJECT_IDS', 'WORKSPACE_READONLY_PROJECT_IDS'] as const

/**
 * Drop every member id a `ws:` runtime may not hold from its assign env and
 * bind. Strips rather than fails so an API replica still sending the old
 * member lists keeps opening runtimes during a rollout.
 */
export function restrictToOwnMembers<B extends { attachedProjectIds?: string[] } | undefined>(
  runtimeKey: string,
  env: Record<string, string>,
  bind?: B,
): { env: Record<string, string>; bind?: B; foreign: string[] } {
  if (!runtimeKey.startsWith('ws:')) return { env, bind, foreign: [] }
  const own = ownMemberIds(runtimeKey)
  const foreign = new Set<string>()
  const keep = (ids: string[]) =>
    ids.filter((id) => {
      if (own.includes(id)) return true
      foreign.add(id)
      return false
    })
  let out = env
  for (const key of MEMBER_ID_ENV_KEYS) {
    if (typeof env[key] !== 'string') continue
    const ids = env[key].split(',').map((id) => id.trim()).filter(Boolean)
    const kept = keep(ids)
    if (kept.length !== ids.length) out = { ...out, [key]: kept.join(',') }
  }
  let outBind = bind
  if (bind?.attachedProjectIds) {
    const kept = keep(bind.attachedProjectIds)
    if (kept.length !== bind.attachedProjectIds.length) outBind = { ...bind, attachedProjectIds: kept }
  }
  return { env: out, bind: outBind, foreign: [...foreign] }
}

/**
 * Which VM class an assign/resume env is requesting (Phase 1 docker project
 * class). Mirrors the same `SHOGO_RUNTIME_CLASS` key the API's
 * build-project-env.ts injects (gated by the runtime.docker_class_enabled
 * platform setting) and permission-engine.ts reads in-guest. Missing/unknown
 * env → 'standard', so every existing caller that never heard of VM classes
 * keeps getting exactly the VM it always got.
 */
function vmClassFromEnv(env: Record<string, string> | undefined): VmClass {
  return env?.SHOGO_RUNTIME_CLASS === 'docker' ? 'docker' : 'standard'
}

/**
 * The workspace-drive size (MiB) the control plane asked for on this
 * assignment (`SHOGO_VM_DISK_MIB`, built from `Project.workspaceDiskGiB` —
 * see apps/api/src/lib/runtime/build-project-env.ts). Absent for a host or
 * caller that doesn't set it: leave the drive at the fleet size.
 */
function workspaceDriveMiBFromEnv(env: Record<string, string> | undefined): number | undefined {
  const raw = env?.SHOGO_VM_DISK_MIB
  if (!raw) return undefined
  const mib = parseInt(raw, 10)
  return Number.isFinite(mib) && mib > 0 ? mib : undefined
}

/** Largest guest memory an assignment may ask for (see vmMemMiBFromEnv). */
const MAX_REQUESTED_VM_MEM_MIB = 32 * 1024

/**
 * Guest memory (MiB) the control plane asked for on this assignment
 * (`SHOGO_VM_BOOT_MEM_MIB`, from `Project.vmMemoryMiB`). Undefined = the
 * class's own size. Only ever raises it: a request at or below the pool size
 * is served by a pooled VM.
 */
export function vmMemMiBFromEnv(env: Record<string, string> | undefined): number | undefined {
  const raw = env?.SHOGO_VM_BOOT_MEM_MIB
  if (!raw) return undefined
  const mib = parseInt(raw, 10)
  return Number.isFinite(mib) && mib > 0 ? Math.min(mib, MAX_REQUESTED_VM_MEM_MIB) : undefined
}

/** Most vCPUs an assignment may ask for (see vmVcpusFromEnv). */
const MAX_REQUESTED_VM_VCPUS = 16

/**
 * vCPUs the control plane asked for on this assignment (`SHOGO_VM_BOOT_VCPUS`,
 * from `Project.vmVcpus`). Undefined = the class's own count. Like memory, it
 * only ever raises it.
 */
export function vmVcpusFromEnv(env: Record<string, string> | undefined): number | undefined {
  const raw = env?.SHOGO_VM_BOOT_VCPUS
  if (!raw) return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_REQUESTED_VM_VCPUS) : undefined
}

/**
 * The size to boot for an assignment, or undefined when a pooled VM of the
 * class fits. Each half only ever raises the class's size, so asking for less
 * (or nothing, after a downgrade) gets the standard pooled VM.
 */
export function vmBootSize(
  env: Record<string, string> | undefined,
  cc: { vcpus: number; memMiB: number },
): { memoryMB?: number; cpus?: number } | undefined {
  const wantMiB = vmMemMiBFromEnv(env)
  const wantCpus = vmVcpusFromEnv(env)
  const mem = wantMiB !== undefined && wantMiB > cc.memMiB ? { memoryMB: wantMiB } : {}
  const cpus = wantCpus !== undefined && wantCpus > cc.vcpus ? { cpus: wantCpus } : {}
  return 'memoryMB' in mem || 'cpus' in cpus ? { ...mem, ...cpus } : undefined
}

async function probeHealth(url: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * How far the guest's wall clock is from the host's, in ms (guest - host),
 * read from the `Date` header the guest's own Bun.serve stamps on /health.
 * Returns null when the guest does not answer or sends no parseable Date — a
 * missing header is not a skew of zero, so callers must not treat it as one.
 *
 * The header has one-second resolution, so the comparison is against the
 * midpoint of the request; anything inside a second is noise.
 */
async function probeGuestClockSkew(url: string, timeoutMs = 2000): Promise<number | null> {
  try {
    const hostBefore = Date.now()
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    const hostAfter = Date.now()
    if (!res.ok) return null
    const date = res.headers.get('date')
    if (!date) return null
    const guest = Date.parse(date)
    if (!Number.isFinite(guest)) return null
    return guest - Math.round((hostBefore + hostAfter) / 2)
  } catch {
    return null
  }
}

export class MetalWarmPool {
  private available: PooledVm[] = []
  private assigned = new Map<string, AssignedVm>()
  private suspended = new Map<string, SuspendedVm>()
  /**
   * Projects a concurrent assign/resume has already picked to evict (SHO-444).
   * Two opens on a full host must evict two DIFFERENT VMs, not race for the
   * same longest-idle one and leave the host still full.
   */
  private evicting = new Set<string>()
  /**
   * Snapshots taken on the STAGED rootfs (pre-warm before a switch), kept apart
   * from `suspended` so the project's current snapshot keeps serving opens
   * until activation promotes these. Local only: never pushed durably while
   * staged, never resumed before activation.
   */
  private stagedSuspended = new Map<string, SuspendedVm>()
  private stagedIndex: CacheIndex
  /** One stale-snapshot drain at a time (see reclaimStaleSnapshots). */
  private staleReclaimRunning = false
  protected repoHydratedSlackMs = REPO_HYDRATED_SLACK_MS
  private store: SnapshotStore
  private rootfsId: string
  private index: CacheIndex
  /** Durable registry of assigned/live VMs, for adopt-on-restart (rolling deploy). */
  private live: LiveRegistry
  /** Handle ids in a boot/restore/assign window: off the pool + not yet in a
   * map, but legitimately live. Kept out of the orphan reaper's sights. */
  private inFlight = new Set<string>()
  /** Collapses concurrent open (assign|resume) calls for the same project. */
  private openFlight = new Singleflight<OpenResult | PrewarmedResult | null>()
  /** Last finished non-reused open per runtime key, for `lateWake`. */
  private lastOpen = new Map<string, LateWake>()
  /** Why the most recent resume attempt for a project declined its snapshot; read by open(). */
  private lastStaleReason = new Map<string, StaleReason>()
  /** Collapses concurrent suspend calls for the same project. */
  private suspendFlight = new Singleflight<SuspendedVm>()
  private recycleFlight = new Singleflight<RecycleReport>()
  /**
   * Billing meters: the seq of the newest report the control plane has seen, the
   * VM rows that stopped being assigned but which no heartbeat has acked yet
   * (their final counters live only here), and the seq each was last sent with.
   */
  private meterSeq = 0
  private closedMeters: Array<VmMeterReport & { lastSentSeq?: number }> = []
  private autoRecycleHistory = new Map<string, number[]>()
  /**
   * Serializes writable-state exports per project. The periodic exporter and
   * `suspend()` both export, and two concurrent exports carry the SAME lineage,
   * so the one that lands second fails its precondition and throws away what is
   * usually the fresher database.
   */
  private dataFlight = new Singleflight<boolean>()
  /** Same serialization for host-mediated `.git` exports (poll vs suspend). */
  private repoFlight = new Singleflight<boolean>()
  /**
   * Source backups (periodic vs suspend/rescue/recycle), one at a time per
   * runtime. Every caller exports its own bytes: the suspend-time export must
   * run after a periodic one, not race it to the same lineage precondition.
   */
  private sourceLock = new KeyedMutex()
  /**
   * Last writable-state change tag the guest reported, per project. Echoed back
   * on the next export so an unchanged project answers 304 without snapshotting
   * or packing. In-memory only — a restart just costs one redundant export.
   */
  private dataTags = new Map<string, string>()
  /** Home-state exports, serialized per project for the same reason as `dataFlight`. */
  private homeFlight = new Singleflight<boolean>()
  /** Last home-state change tag per project; the `dataTags` counterpart. */
  private homeTags = new Map<string, string>()
  /** Invalidated CoW stores at the last gauge publish, so we log each new one once. */
  private lastCowInvalid = 0
  /** Caps concurrent heavy NVMe ops (snapshot / restore / store pull|push). */
  private heavy: Semaphore
  /**
   * Total bytes of guest exports in memory at once (SHO-593). Every whole-object
   * export read reserves here first, so a slow 33 GiB workspace member cannot
   * pile up behind three small backups and take the host's control plane with
   * it. See `readBoundedBody`.
   */
  readonly exportBudget: ByteBudget
  /** Single-flight guard for pool fills (see reconcile). */
  private reconciling: Promise<void> | null = null
  /**
   * Serves durable archives to guests over the tap link, fetched several parts
   * at a time. Public because the HTTP server routes redemptions to it.
   */
  readonly hydrateProxy: HydrateProxy

  /**
   * Per-VM-class golden-rootfs identity, computed once at startup. Every
   * class validates snapshot/resume freshness against ITS OWN identity, not
   * the standard one — a docker-class snapshot compared against
   * `rootfsIds.standard` would either always look stale (different image,
   * different size/mtime) or, worse, coincidentally look fresh and thaw the
   * wrong guest userspace. `rootfsId` (singular) is kept as an alias for
   * `rootfsIds.standard` — every pre-existing call site that only ever knew
   * about one rootfs still gets the exact same value.
   */
  private rootfsIds: Record<VmClass, string>
  /**
   * Serializes workspace-drive grows per VM (SHO-349). Two concurrent grows of
   * one drive would interleave freeze/thaw and the host-side ftruncate.
   */
  private driveLock = new KeyedMutex()
  /** Resolves a VM's workspace-drive backing file (grow / size / existence). */
  private driveProvisioner: DataDriveProvisioner

  constructor(
    private mgr = new FirecrackerVMManager(),
    private cfg = config,
    store?: SnapshotStore,
  ) {
    this.store = store ?? createSnapshotStore(cfg)
    this.driveProvisioner = new DataDriveProvisioner(cfg)
    this.rootfsIds = this.readRootfsIds()
    this.rootfsId = this.rootfsIds.standard
    this.index = new CacheIndex(cfg.snapDir)
    this.stagedIndex = new CacheIndex(join(cfg.snapDir, 'staged'))
    this.live = new LiveRegistry(cfg.runDir)
    rmSync(this.exportSpoolDir, { recursive: true, force: true })
    this.heavy = new Semaphore(parseInt(process.env.METAL_HEAVY_CONCURRENCY ?? '2', 10))
    this.exportBudget = new ByteBudget(cfg.exportBudgetBytes)
    this.hydrateProxy = new HydrateProxy({
      partBytes: cfg.hydrateProxyPartBytes,
      concurrency: cfg.s3GetConcurrency,
      maxConcurrent: cfg.hydrateProxyMaxConcurrent,
      // Only the window to REDEEM, which the guest does within a second of
      // being handed the URL; the transfer itself is unbounded by this because
      // redeeming consumes the grant. Deliberately far shorter than the
      // presign TTL: an assign that dies before the guest pulls leaves the
      // grant holding a slot, and at 30 minutes a dozen such failures would
      // retire the proxy for the rest of the hour.
      ttlSec: 120,
      port: cfg.listenPort,
    })
  }

  /**
   * Best-effort guest lifecycle hook. On `quiesce` the guest stops its project
   * API sidecars and frees their ports before we freeze RAM; on `rehydrate`
   * after wake it restarts them. Without this a snapshot resumes a sidecar
   * mid-flight — and a wedged one keeps holding its port, so every restart
   * fails with EADDRINUSE. A 404 (guest opted out) or timeout is tolerated so
   * the substrate works with any guest.
   *
   * `rehydrate` also carries the host's clock, and the guest corrects its own
   * wall clock from it before restarting the sidecars. A restored guest can
   * come back with the clock frozen at snapshot time (see guestBootArgs), and
   * that clock decides whether every outbound TLS handshake in the guest is
   * valid. Snapshots taken before `clocksource=kvm-clock` was pinned stay on
   * TSC until they cold-boot, so this sync is the backstop that fixes them —
   * and it is harmless for a guest that is already right (the guest ignores a
   * skew under 2 s). An old guest ignores the extra field.
   */
  protected async callGuestHook(
    url: string,
    hook: 'quiesce' | 'rehydrate',
    timeoutMs: number,
    token?: string,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${url}/pool/${hook}`, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(hook === 'rehydrate' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: hook === 'rehydrate' ? JSON.stringify({ hostNowMs: Date.now() }) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 404) return false
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Re-apply the injected env to an already-restored guest via
   * `POST /pool/refresh-env`. Snapshots freeze the env at first assign, so a
   * later change (AI-proxy URL/token, SHOGO_API_URL, rotated secrets) never
   * reaches a resumed VM without this. The guest diffs against its live env and
   * only bounces its API sidecar when something actually changed. Authenticated
   * with the runtime token (the endpoint sits under the auth-gated `/pool`
   * prefix once assigned). A 404 (guest predates the endpoint) is tolerated.
   */
  private async refreshGuestEnv(
    handle: FcVmHandle,
    projectId: string,
    env: Record<string, string>,
  ): Promise<void> {
    if (!env || Object.keys(env).length === 0) return
    const token = env.RUNTIME_AUTH_SECRET
    const res = await fetch(`${handle.agentUrl}/pool/refresh-env`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ projectId, env }),
      signal: AbortSignal.timeout(this.cfg.rehydrateTimeoutMs),
    })
    if (res.status === 404) return // guest predates /pool/refresh-env
    if (!res.ok) {
      throw new Error(`/pool/refresh-env ${res.status}: ${await res.text().catch(() => '')}`)
    }
  }

  async waitForHealth(handle: FcVmHandle, isAlive: () => boolean): Promise<number> {
    const start = performance.now()
    for (let i = 0; i < this.cfg.healthRetries; i++) {
      if (!isAlive()) throw this.diedError(handle)
      if (await probeHealth(handle.agentUrl, 500)) return performance.now() - start
      await Bun.sleep(this.cfg.healthIntervalMs)
    }
    throw new Error(`VM ${handle.id} never became healthy`)
  }

  /**
   * The error for a VM whose firecracker process went away before it answered
   * /health. It carries the FC exit code or signal (the host killed it, or the
   * guest shut down) and the guest's own last serial line (the kernel or PID 1
   * died), because "exited before healthy" alone cannot tell those apart — and
   * telling them apart is the difference between a host bug and a bad image
   * (SHO-563). The 20-line tail rides along on the error for the caller.
   */
  private diedError(handle: FcVmHandle): Error & { serialTail?: string } {
    const last = serialLastLine(handle.serialLog)
    const how = this.mgr.exitSummary(handle.id)
    const err = new Error(
      `VM ${handle.id} exited before healthy (${how}${last ? `, last: ${last}` : ''})`,
    ) as Error & { serialTail?: string }
    err.serialTail = readSerialTail(handle.serialLog, 20)
    return err
  }

  /**
   * Boot one VM, reporting every cold boot from the LIVE image to the rootfs
   * watch (SHO-552). `rootfsBase` given means it is not a boot of the image
   * currently serving: an assignment pinned to another class image, the
   * activation boot-probe, or a rollout rotation — none of those say anything
   * about whether the image we just activated works.
   */
  private async bootOne(
    pool = true,
    vmClass: VmClass = 'standard',
    rootfsBase?: string,
    size?: { memoryMB?: number; cpus?: number },
    opts: { dmBase?: boolean } = {},
  ): Promise<PooledVm> {
    // startVM resolves memory and vCPUs from the class's own config
    // (classConfig in config.ts) unless an assignment asked for a bigger VM.
    const fromLiveImage = !rootfsBase
    let handle: FcVmHandle
    try {
      handle = await this.mgr.startVM({
        vmClass,
        ...(rootfsBase ? { rootfsBase } : {}),
        ...(opts.dmBase ? { rootfsBaseBecomesClassBase: true } : {}),
        ...(size?.memoryMB ? { memoryMB: size.memoryMB } : {}),
        ...(size?.cpus ? { cpus: size.cpus } : {}),
      })
    } catch (err: any) {
      if (fromLiveImage) reportColdBoot(false, err?.message ?? String(err))
      throw err
    }
    // startVM self-cleans a partial boot; a VM that boots but never becomes
    // healthy is our responsibility to stop, or its FC process leaks (never
    // enters `available`/`assigned`, so nothing else would ever kill it).
    this.inFlight.add(handle.id)
    let healthMs: number | undefined
    try {
      healthMs = await this.waitForHealth(handle, () => this.mgr.isRunning(handle))
    } catch (err: any) {
      await this.mgr.stopVM(handle).catch(() => {})
      if (fromLiveImage) reportColdBoot(false, err?.message ?? String(err), handle.serialLog)
      throw err
    } finally {
      this.inFlight.delete(handle.id)
    }
    if (fromLiveImage) reportColdBoot(true)
    return { handle, ready: true, createdAt: Date.now(), healthMs: Math.round(healthMs ?? 0) }
  }

  /**
   * Boot VMs from `rootfsBase` and hold them: the activation gate (SHO-552,
   * SHO-563). Returns why the image could not serve a VM, or null when every
   * probe VM became healthy AND was still answering `/health` at the end of the
   * hold window.
   *
   * This is the only check that proves an image works — the static probe only
   * proves `/usr/local/bin/fc-init` is inside it. Three things make it boot the
   * way production boots:
   *
   *   1. `dmBase` provisions the rootfs through the same dm snapshot live will
   *      use once the staged file is renamed into place. Before SHO-563 this
   *      booted a full COPY of the staged image, which is a different boot path
   *      from every live VM (provisionDm → a loop of the base) and could pass
   *      while live failed.
   *   2. `min(2, poolBootConcurrency)` VMs boot in parallel, the way the
   *      post-restart fill boots them, so a race that only shows up in a group
   *      is exercised.
   *   3. The hold window (`METAL_ROOTFS_PROBE_HOLD_MS`): an image that answers
   *      /health and then dies is a bad image, and a probe that stops at the
   *      first 200 OK scores it healthy. The VM must still be alive and
   *      answering at the end of the hold.
   *
   * A probe never enters `available`/`assigned` and is never reported to the
   * watch: a probe that fails is already fatal on its own, and counting it twice
   * would roll a good image back on its first activation. Never throws.
   */
  async probeBoot(vmClass: VmClass, rootfsBase: string, opts: RootfsProbeOptions = {}): Promise<RootfsProbeResult> {
    const parallelism = Math.max(1, Math.min(2, this.cfg.poolBootConcurrency))
    const holdMs = opts.holdMs ?? this.cfg.rootfsProbeHoldMs
    // dm mode snapshots the standard golden base and copies the docker one, so a
    // probe must use the same strategy per class to be a probe of the live path.
    const dmBase = opts.dmBase ?? vmClass === 'standard'
    const results = await Promise.all(
      Array.from({ length: parallelism }, () => this.probeOne(vmClass, rootfsBase, holdMs, dmBase)),
    )
    const failed = results.find((r) => !r.ok)
    if (failed) return failed
    const healthy = results
      .map((r) => r.healthyAfterMs ?? 0)
      .sort((a, b) => b - a)[0] ?? 0
    return { ok: true, error: null, healthyAfterMs: healthy, fcExit: null, serialTail: '', heldMs: holdMs }
  }

  /** One probe VM: boot → healthy → hold → still healthy → stop. Never throws. */
  private async probeOne(
    vmClass: VmClass,
    rootfsBase: string,
    holdMs: number,
    dmBase: boolean,
  ): Promise<RootfsProbeResult> {
    let vm: PooledVm | null = null
    try {
      vm = await this.bootOne(false, vmClass, rootfsBase, undefined, { dmBase })
      const handle = vm.handle
      const healthyAfterMs = vm.healthMs ?? 0
      // The hold: the whole point. An image that answers once and dies is a bad
      // image, and a user's next cold boot is the one that finds out.
      const deadline = Date.now() + holdMs
      while (Date.now() < deadline) {
        await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())))
        if (!this.mgr.isRunning(handle)) {
          return this.probeFailure(handle, healthyAfterMs, holdMs, `died inside the ${holdMs}ms hold window`)
        }
        if (!(await probeHealth(handle.agentUrl, 2000))) {
          return this.probeFailure(handle, healthyAfterMs, holdMs, `stopped answering /health inside the ${holdMs}ms hold window`)
        }
      }
      return { ok: true, error: null, healthyAfterMs, fcExit: null, serialTail: '', heldMs: holdMs }
    } catch (err: any) {
      const handle = vm?.handle
      if (!handle) {
        return { ok: false, error: err?.message ?? String(err), healthyAfterMs: null, fcExit: null, serialTail: '', heldMs: holdMs }
      }
      return this.probeFailure(handle, null, holdMs, err?.message ?? String(err))
    } finally {
      if (vm) await this.mgr.stopVM(vm.handle).catch(() => {})
    }
  }

  private probeFailure(handle: FcVmHandle, healthyAfterMs: number | null, heldMs: number, why: string): RootfsProbeResult {
    const exit = this.mgr.procExit(handle.id)
    console.error(`[pool] rootfs probe VM ${handle.id} failed: ${why} (${this.mgr.exitSummary(handle.id)})`)
    return {
      ok: false,
      error: `${why} (${this.mgr.exitSummary(handle.id)})`,
      healthyAfterMs,
      fcExit: exit ? { code: exit.code, signal: exit.signal } : null,
      serialTail: readSerialTail(handle.serialLog, 20),
      heldMs,
    }
  }

  /**
   * Probe one kept image on demand: `live`, `prev`, `staged` or `failed` (see
   * `keptRootfsImage`). Reuses the activation probe, never touches the live
   * image, the pool or the watch ledger — the operator route behind it is
   * `POST /admin/probe-rootfs`.
   */
  async probeKeptRootfs(name: KeptImageName, vmClass: VmClass, holdMs?: number): Promise<RootfsProbeResult & { image: string | null }> {
    const image = keptRootfsImage(name, vmClass)
    if (!image) {
      return {
        ok: false,
        error: `no ${name} image for the ${vmClass} class on this host`,
        healthyAfterMs: null,
        fcExit: null,
        serialTail: '',
        heldMs: holdMs ?? this.cfg.rootfsProbeHoldMs,
        image: null,
      }
    }
    const res = await this.probeBoot(vmClass, image, { holdMs })
    return { ...res, image }
  }

  /**
   * Fill the pool to target size. SINGLE-FLIGHTED: `claim()` schedules a
   * reconcile after every claim, so under load dozens overlap — each computing a
   * large deficit and spawning its own fill batch. That is a boot storm that
   * saturates TAP setup + CPU, trips the FC API-socket timeout, and never
   * converges (the leak that piled up ~900 processes). Coalescing to one active
   * fill at a time bounds the spawn rate; a fill left short is topped up by the
   * next trigger.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling
    this.reconciling = this.fillPool().finally(() => {
      this.reconciling = null
    })
    return this.reconciling
  }

  /**
   * One bounded-parallelism fill pass. Runs `poolBootConcurrency` workers that
   * each boot until the target is met, swallowing individual failures (a single
   * bad boot must not abort warm-up; the deficit is retried on the next
   * reconcile). Only ever invoked via the single-flight guard in reconcile().
   *
   * Fills EVERY supported class to its own target independently (the standard
   * pool at `cfg.poolSize`, plus the docker pool at `cfg.dockerClass.poolSize`
   * when this host is configured for it). A host that hasn't opted into the
   * docker class (no METAL_DOCKER_ROOTFS) fills exactly the one pool it always
   * did — this loop is a no-op superset of the old single-class behavior.
   */
  private async fillPool(): Promise<void> {
    await Promise.all(VM_CLASSES.map((vmClass) => this.fillClassPool(vmClass)))
  }

  private async fillClassPool(vmClass: VmClass): Promise<void> {
    if (!isVmClassSupported(this.cfg, vmClass)) return
    const target = classConfig(this.cfg, vmClass).poolSize
    const current = this.available.filter((v) => v.handle.vmClass === vmClass).length
    let remaining = target - current
    if (remaining <= 0) return
    const workers = Math.min(remaining, Math.max(1, this.cfg.poolBootConcurrency))
    const worker = async (): Promise<void> => {
      // `remaining--` is atomic between awaits on the single JS event loop, so
      // workers never over- or under-boot the deficit.
      while (remaining > 0) {
        remaining--
        try {
          const vm = await this.bootOne(true, vmClass)
          this.available.push(vm)
        } catch (err: any) {
          console.error(`[pool] warm boot failed (class=${vmClass}, retry on demand):`, err?.message ?? err)
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()))
  }

  async start(): Promise<{ adopted: string[]; reaped: number }> {
    await this.rehydrate()
    // Adopt live VMs that survived the restart BEFORE filling the pool (fillPool
    // spawns new FCs; adopt must first claim survivors + reap non-adopted ones
    // so the host-scan reaper can't race a freshly-booted warm VM).
    const adoption = await this.adopt()
    // Seed the tap-index allocator past every persisted (adopted + suspended)
    // tap BEFORE reconcile() fills the warm pool — otherwise a fresh warm VM
    // would reuse a device name still held by an adopted VM (or reclaimed on a
    // suspended project's resume) and setupTap would tear down that live tap.
    await this.seedVmIndexAllocator()
    await this.reconcile()
    return adoption
  }

  /**
   * Advance the FC manager's tap-index counter past the highest `fctap<n>` index
   * recorded in the durable registries — live (adopted, still running) and cache
   * (suspended, whose exact device is recreated on resume). Without this the
   * counter reset to 0 on every restart and warm VMs collided with survivors.
   */
  private async seedVmIndexAllocator(): Promise<void> {
    let maxIdx = -1
    for (const e of this.live.all()) {
      const n = tapIndex(e.net)
      if (n != null && n > maxIdx) maxIdx = n
    }
    for (const e of this.index.all()) {
      const n = tapIndex(e.net)
      if (n != null && n > maxIdx) maxIdx = n
    }
    // Also seed past every tap device that PHYSICALLY exists on the host. The
    // durable registries (live + cache) can be wiped out-of-band — a
    // runtime.ext4 rebuild resets them — while the adopted Firecracker VMs keep
    // their fctap<n> devices via systemd KillMode=process. Without this the
    // counter resets to 0 and a fresh warm VM reuses a live survivor's device;
    // setupTap deletes-then-recreates it and blackholes the running guest (the
    // prod incident: duplicate 172.16.0.x mesh IPs, dead guests, 502s). `ip
    // link` is the ground truth that survives the registry wipe.
    for (const n of await this.hostTapIndices()) {
      if (n > maxIdx) maxIdx = n
    }
    if (maxIdx >= 0) this.mgr.seedVmSeq(maxIdx + 1)
  }

  /** Live host tap indices (`ip link`). Overridable seam for tests. */
  protected hostTapIndices(): Promise<Set<number>> {
    return existingTapIndices()
  }

  /** Current golden-rootfs identity for `vmClass` (see `rootfsIds`). */
  private readRootfsIds(): Record<VmClass, string> {
    return {
      standard: computeRootfsIdentity(this.cfg),
      docker: computeRootfsIdentity(this.cfg, classConfig(this.cfg, 'docker').baseRootfs),
    }
  }

  private classRootfsIdentity(vmClass: VmClass): string {
    return this.rootfsIds[vmClass] ?? this.rootfsIds.standard
  }

  /** Rootfs identity the assigned VM's guest booted from (current image if unknown). */
  private bootRootfsIdentity(a: AssignedVm): string {
    return a.bootRootfsIdentity ?? this.classRootfsIdentity(a.handle.vmClass)
  }

  /**
   * The staged golden image for `vmClass` (built beside the live one, see
   * self-update.ts), or null. Read from disk on every call: a rebuild replaces
   * the file under a running agent. A pinned `METAL_ROOTFS_IDENTITY` can't tell
   * two images apart, so staged boots are off on such a host.
   */
  stagedRootfs(vmClass: VmClass = 'standard'): { path: string; identity: string } | null {
    if (this.cfg.rootfsIdentity) return null
    const path = stagedRootfsPath(classConfig(this.cfg, vmClass).baseRootfs)
    if (!existsSync(path)) return null
    const identity = computeRootfsIdentity(this.cfg, path)
    return identity === 'unknown' ? null : { path, identity }
  }

  /** Is this VM on the host's current image, the staged one, or neither (stale)? */
  private rootfsGeneration(identity: string, vmClass: VmClass): 'current' | 'staged' | 'stale' {
    if (identity === this.classRootfsIdentity(vmClass)) return 'current'
    if (identity === this.stagedRootfs(vmClass)?.identity) return 'staged'
    return 'stale'
  }

  /**
   * Re-adopt microVMs that survived a node-agent restart (rolling deploy). For
   * each entry in the durable live registry, verify the firecracker pid is still
   * alive, its API socket still exists, and the guest still answers /health; if
   * so, re-attach (mgr.adoptVM) and restore it to `assigned`. Entries that fail
   * any check are dropped from the registry. Finally SIGKILL every firecracker
   * on the host we did NOT adopt — old warm-pool VMs (no state) and assigned VMs
   * whose guest was unhealthy — so the fresh warm pool starts from a clean slate.
   *
   * MUST run before reconcile()/fillPool(), which spawn new firecracker
   * processes the host-orphan reaper would otherwise kill.
   */
  async adopt(): Promise<{ adopted: string[]; reaped: number }> {
    const adoptedIds = new Set<string>()
    const adoptedProjects: string[] = []
    const midOpen: AssignedVm[] = []
    for (const e of this.live.all()) {
      if (this.assigned.has(e.projectId)) continue // already tracked (defensive)
      if (!pidAlive(e.pid) || !existsSync(e.socketPath)) {
        this.live.remove(e.projectId)
        continue
      }
      // A live firecracker process with its API socket present IS a real microVM
      // holding (possibly unsaved) user state — so we ADOPT it unconditionally and
      // never let it be reaped here. The health probe is advisory only: a transient
      // unresponsiveness during the restart window (host load, overlapping restarts)
      // must not SIGKILL a running VM. A guest that is truly wedged stays adopted;
      // `open()`'s health gate discards it on the next assign (once host-mediated
      // durability has a current copy). The idle reaper and `/stop` still cannot
      // until stale `activeStreams` expire on poll failure — they are not the
      // self-heal path. (Only pid-dead / socket-gone entries, handled above, are
      // dropped so leftover procs, if any, get reaped.)
      let healthy = false
      for (let i = 0; i < 3 && !healthy; i++) {
        healthy = await probeHealth(e.agentUrl, 2000)
        if (!healthy) await Bun.sleep(250)
      }
      if (!healthy) {
        console.warn(
          `[pool] adopting ${e.projectId} (pid ${e.pid}) despite failed health probe — live FC proc, keeping it rather than reaping`,
        )
      }
      const handle: FcVmHandle = {
        id: e.vmId,
        agentUrl: e.agentUrl,
        guestIp: e.guestIp,
        pid: e.pid,
        platform: 'linux',
        net: e.net,
        rootfs: e.rootfs,
        socketPath: e.socketPath,
        serialLog: e.serialLog,
        vcpus: e.vcpus,
        memoryMB: e.memoryMB,
        vmClass: e.vmClass ?? 'standard',
        dataDrive: e.dataDrive,
        workspaceDrive: e.workspaceDrive,
      }
      this.mgr.adoptVM(handle)
      // A VM reclaimed before the restart still has its balloon inflated, but the
      // accounting lived in this process's memory. Read the target back, so a
      // request can deflate it and the idle pass can re-bank it, instead of
      // leaving the guest short of RAM until it hits OOM. `deflate_on_oom` is the
      // backstop, not the plan. Gated: with reclaim off this is an FC call per
      // adopted VM that nothing would ever act on.
      let balloonedMiB: number | undefined
      if (this.cfg.idleReclaim) {
        const target = await this.mgr.balloonTargetMiB(handle).catch(() => undefined)
        if (target && target > 0) balloonedMiB = target
      }
      this.assigned.set(e.projectId, {
        projectId: e.projectId,
        alwaysOn: e.alwaysOn,
        runtimeToken: e.runtimeToken,
        publishedSubdomain: e.publishedSubdomain,
        publishedDataLoaded: e.publishedDataLoaded,
        handle,
        balloonedMiB,
        assignedAt: e.assignedAt,
        lastTouchedAt: Date.now(),
        // Fresh idle window across the restart, like lastTouchedAt: the guest's
        // real-activity history doesn't survive in the registry, and reaping an
        // adopted VM on its original assignedAt would suspend the live set on
        // every rolling deploy.
        lastRealActivityAt: Date.now(),
        // Same fresh seed, but the first baselining poll corrects it from the
        // guest's own report — otherwise every metal-agent deploy would hand a
        // VM that has been idle for days another full busy-idle ceiling. Only
        // adopt needs that correction: assign and resume are a user action
        // happening now, so their `now` seed is already the truth.
        lastUserActivityAt: Date.now(),
        needsUserActivityBaseline: true,
        // Billing counters start at the restart, not at the registry's original
        // assignedAt: the counters live in memory, so charging `now - assignedAt`
        // on the first tick would bill the VM's whole life again to whichever
        // class it happens to be in (SHO-532). The restart gap itself (seconds)
        // goes unbilled — bounded, and the safe direction.
        meter: { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: Date.now() },
        restoredFrom: e.restoredFrom,
        bootRootfsIdentity: e.bootRootfsIdentity,
        workspaceOrigin: e.workspaceOrigin,
        backupParentEtag: e.backupParentEtag,
        dataParentEtag: e.dataParentEtag,
        dataUntrustedReason: e.dataUntrustedReason,
        dataSnapshotFailure: e.dataSnapshotFailure,
        homeParentEtag: e.homeParentEtag,
        homeUntrustedReason: e.homeUntrustedReason,
        memberData: e.memberData,
        workspaceMemberIds: e.workspaceMemberIds,
        repoParentEtag: e.repoParentEtag,
        repoUntrustedReason: e.repoUntrustedReason,
        sourceUntrustedReason: e.sourceUntrustedReason,
        stateSince: e.stateSince ?? e.assignedAt,
        repoLinked: e.repoLinked,
        lastHealthOk: healthy,
        quarantine: e.quarantine,
        openState: e.openState,
        // A person's activity before the restart decides whether a mid-open VM
        // may be retired (SHO-584): their work exists only in that guest.
        userSeenSinceAssign: e.userSeenSinceAssign,
        repoCorruptFailure: e.repoCorruptFailure,
        rotateRetryAt: e.rotateRetryAt,
        rotationBlocked: e.rotationBlocked,
        refuseCount: e.refuseCount,
        refusedSince: e.refusedSince,
        refuseRetryAt: e.refuseRetryAt,
        refusalLogged: e.refusalLogged,
      })
      adoptedIds.add(e.vmId)
      adoptedProjects.push(e.projectId)
      // The assign that created this VM never finished hydrating (SHO-584). Its
      // tree is a partial hydrate — source, database, home and `.git` are only
      // some of what they should be, and it carries no lineage. Adopting it as a
      // normal assigned VM is how one 525 MB half-open VM spent six days writing
      // 10,391 quarantine copies because it could never back up and therefore
      // could never stop.
      if (e.openState === 'opening') midOpen.push(this.assigned.get(e.projectId)!)
    }
    // Every id the pool owns, not just the adopted ones: a fill that started
    // while these health probes were running (a claim, the reaper tick's
    // `reconcile`) has already spawned warm VMs, and they are in neither the live
    // registry nor `adoptedIds`. Killing those is how one activation restart on
    // staging made 8/8 cold boots fail and rolled a good image back (SHO-563).
    const keep = this.liveHandleIds()
    for (const id of adoptedIds) keep.add(id)
    const reaped = this.mgr.reapHostOrphans(keep)
    if (adoptedProjects.length) {
      console.log(`[pool] adopted ${adoptedProjects.length} live microVM(s) across restart: ${adoptedProjects.join(', ')}`)
    }
    for (const a of midOpen) await this.handleAdoptedMidOpen(a)
    return { adopted: adoptedProjects, reaped }
  }

  /**
   * An adopted VM whose open never finished (SHO-584).
   *
   * Every archive it would write is marked untrusted FIRST, so nothing it holds
   * can reach the durable backups however this ends. Then:
   *   - no person has used it → retire it without a snapshot, after one
   *     quarantine copy. The durable backup is the truth (that is what the
   *     interrupted open was hydrating when it was cut off), so the next open
   *     cold-boots from it instead of resuming a half tree.
   *   - a person has used it → keep it running and alert. Their work exists only
   *     in this guest, so destroying it is not ours to decide.
   */
  private async handleAdoptedMidOpen(a: AssignedVm): Promise<void> {
    const reason =
      'adopted mid-open: the assign that created this VM was cut off by a restart, so its tree is a partial hydrate'
    metrics.inc(M.midOpenAdopted)
    this.distrustSource(a, reason)
    this.distrustData(a, reason)
    this.distrustHome(a, reason)
    this.distrustRepo(a, reason)
    // `ws:` runtimes keep their writable state per member, not on the VM.
    for (const id of a.workspaceMemberIds ?? []) {
      const member = this.memberDataState(a, id)
      member.sourceUntrustedReason ??= reason
      member.untrustedReason ??= reason
    }
    a.repoHydratePending = false
    a.openState = undefined
    this.writeLive(a)
    if (a.userSeenSinceAssign) {
      console.error(
        `[pool] adopted ${a.projectId} MID-OPEN but a person has used it since — keeping it running and NOT ` +
          `retiring it. Every one of its exports goes to conflict/ until it is healed; the durable backups ` +
          `are untouched.`,
      )
      return
    }
    const steps: RecycleStep[] = []
    try {
      await this.backupForRecycle(a, steps, { reason: 'adopted-mid-open' })
    } catch (err: any) {
      console.error(`[pool] mid-open retirement of ${a.projectId}: backup pass ended early:`, err?.message ?? err)
    }
    this.closeMeter(a)
    this.assigned.delete(a.projectId)
    this.live.remove(a.projectId)
    await this.mgr.stopVM(a.handle).catch(() => {})
    console.error(
      `[pool] RETIRED ${a.projectId} (adopted mid-open, no user activity): stopped without a snapshot so its ` +
        `next open cold-boots from the durable backup. Steps: ${JSON.stringify(steps)}`,
    )
  }

  /**
   * Graceful pre-restart hook for a rolling deploy. Kills ONLY warm/available
   * VMs (they hold no user state; leaving them would just orphan them for the
   * next instance to reap and refill). Assigned VMs are LEFT RUNNING: with
   * systemd `KillMode=process` their firecracker processes survive the agent
   * exit, their registry entries persist, and the next instance re-adopts them
   * via adopt(). Deliberately does NOT snapshot or kill assigned VMs.
   */
  async prepareForRestart(): Promise<{ releasedWarm: number; keptAssigned: number }> {
    const releasedWarm = this.available.length
    for (const vm of this.available) await this.mgr.stopVM(vm.handle).catch(() => {})
    this.available = []
    return { releasedWarm, keptAssigned: this.assigned.size }
  }

  /**
   * A person used this VM since its assign: record it, and persist it so an
   * adopt-after-restart can still tell "a person's work exists only here" from
   * "nobody has touched it" (SHO-584).
   */
  private noteUserSeen(a: AssignedVm): void {
    if (a.userSeenSinceAssign) return
    a.userSeenSinceAssign = true
    this.writeLive(a)
  }

  /** Persist an assigned VM's connection info so the next instance can adopt it. */
  private writeLive(a: AssignedVm): void {
    this.live.put({
      projectId: a.projectId,
      vmId: a.handle.id,
      pid: a.handle.pid,
      guestIp: a.handle.guestIp,
      agentUrl: a.handle.agentUrl,
      socketPath: a.handle.socketPath,
      serialLog: a.handle.serialLog,
      net: a.handle.net,
      rootfs: a.handle.rootfs,
      vcpus: a.handle.vcpus,
      memoryMB: a.handle.memoryMB,
      vmClass: a.handle.vmClass,
      dataDrive: a.handle.dataDrive,
      workspaceDrive: a.handle.workspaceDrive,
      assignedAt: a.assignedAt,
      lastTouchedAt: a.lastTouchedAt,
      restoredFrom: a.restoredFrom,
      bootRootfsIdentity: a.bootRootfsIdentity,
      alwaysOn: a.alwaysOn,
      runtimeToken: a.runtimeToken,
      publishedSubdomain: a.publishedSubdomain,
      publishedDataLoaded: a.publishedDataLoaded,
      workspaceOrigin: a.workspaceOrigin,
      backupParentEtag: a.backupParentEtag,
      dataParentEtag: a.dataParentEtag,
      dataUntrustedReason: a.dataUntrustedReason,
      dataSnapshotFailure: a.dataSnapshotFailure,
      homeParentEtag: a.homeParentEtag,
      homeUntrustedReason: a.homeUntrustedReason,
      memberData: a.memberData,
      workspaceMemberIds: a.workspaceMemberIds,
      repoParentEtag: a.repoParentEtag,
      repoUntrustedReason: a.repoUntrustedReason,
      sourceUntrustedReason: a.sourceUntrustedReason,
      stateSince: a.stateSince,
      repoLinked: a.repoLinked,
      quarantine: a.quarantine,
      openState: a.openState,
      userSeenSinceAssign: a.userSeenSinceAssign,
      repoCorruptFailure: a.repoCorruptFailure,
      rotateRetryAt: a.rotateRetryAt,
      rotationBlocked: a.rotationBlocked,
      refuseCount: a.refuseCount,
      refusedSince: a.refusedSince,
      refuseRetryAt: a.refuseRetryAt,
      refusalLogged: a.refusalLogged,
      v: 1,
    })
  }

  /**
   * The dedupe slots + daily cap for this VM's `conflict/` writes (SHO-584).
   * One bookkeeping object, persisted with the live entry, shared by all four
   * archive writers so a project's cap counts them together.
   */
  private quarantineFor(a: AssignedVm): QuarantineBookkeeping {
    return {
      state: a.quarantine,
      onChange: (state: QuarantineState) => {
        a.quarantine = state
        this.writeLive(a)
      },
    }
  }

  /**
   * Rebuild the in-memory `suspended` map from the persistent index at startup
   * so a node-agent restart keeps NVMe locality (no store re-pull stampede).
   * Entries whose artifacts are missing are dropped (their index file removed).
   */
  async rehydrate(): Promise<number> {
    let n = 0
    for (const e of this.index.all()) {
      const s = this.entryToSuspended(e)
      if (!s) {
        this.index.remove(e.projectId)
        continue
      }
      this.suspended.set(e.projectId, s)
      n++
    }
    // Staged snapshots survive a restart only while the image they were taken
    // on is still the staged one; after a newer rebuild they can never be used.
    let staged = 0
    for (const e of this.stagedIndex.all()) {
      const s = this.entryToSuspended(e)
      if (!s || s.rootfsIdentity !== this.stagedRootfs(s.snapshot.vmClass ?? 'standard')?.identity) {
        if (s) await this.deleteLocalArtifacts(s.snapshot)
        this.stagedIndex.remove(e.projectId)
        continue
      }
      this.stagedSuspended.set(e.projectId, s)
      staged++
    }
    if (n) console.log(`[pool] rehydrated ${n} suspended snapshot(s) from cache index`)
    if (staged) console.log(`[pool] rehydrated ${staged} pre-warmed snapshot(s) on the staged rootfs`)
    return n
  }

  /** A cache-index entry as a suspended VM, or null when its artifacts are gone. */
  private entryToSuspended(e: CacheEntry): SuspendedVm | null {
    if (!existsSync(e.snapshotPath) || !existsSync(e.memFilePath) || !existsSync(e.rootfs)) return null
    const snapshot: FcSnapshot = {
      vmId: e.vmId,
      snapshotPath: e.snapshotPath,
      memFilePath: e.memFilePath,
      rootfs: e.rootfs,
      net: e.net,
      vcpus: e.vcpus,
      memoryMB: e.memoryMB,
      createdAt: e.createdAt,
      bytesMem: e.bytesMem,
      bytesState: e.bytesState,
      bytesRootfs: e.bytesRootfs,
      vmClass: e.vmClass,
      dataDrive: e.dataDrive,
      workspaceDrive: e.workspaceDrive,
    }
    return {
      projectId: e.projectId,
      snapshot,
      suspendedAt: e.suspendedAt,
      lastAccessAt: e.lastAccessAt,
      rootfsIdentity: e.rootfsIdentity,
      backupEtag: e.backupEtag,
      dataEtag: e.dataEtag,
      homeEtag: e.homeEtag,
      publishedDataLoaded: e.publishedDataLoaded,
      memberDataEtags: e.memberDataEtags,
      memberSourceEtags: e.memberSourceEtags,
      repoEtag: e.repoEtag,
      workspaceOrigin: e.workspaceOrigin,
      durablePending: e.durablePending,
    }
  }

  private claim(vmClass: VmClass = 'standard'): PooledVm | null {
    const idx = this.available.findIndex((v) => v.ready && v.handle.vmClass === vmClass)
    const vm = idx === -1 ? null : this.available.splice(idx, 1)[0]!
    // Replace in background. A miss tops up too: a fill whose boots failed is
    // not retried on its own, so an empty pool would otherwise stay empty.
    this.reconcile().catch(() => {})
    return vm
  }

  /**
   * Guest HTTP liveness. `protected` so tests can stub it without a real guest
   * (fake 172.16 URLs would otherwise always fail and trip the health gate).
   * A couple of short retries so a slow-but-live guest is not discarded.
   */
  protected async isGuestHealthy(handle: FcVmHandle, opts: { patient?: boolean } = {}): Promise<boolean> {
    if (opts.patient) return probeHealth(handle.agentUrl, HEALTH_GATE_PATIENT_TIMEOUT_MS)
    for (let i = 0; i < HEALTH_GATE_RETRIES; i++) {
      if (await probeHealth(handle.agentUrl, HEALTH_GATE_TIMEOUT_MS)) return true
      if (i + 1 < HEALTH_GATE_RETRIES) await Bun.sleep(150)
    }
    return false
  }

  /** Dump the guest serial tail so a wedge has a forensic record. */
  private dumpGuestSerial(a: AssignedVm, reason: string): void {
    const path = a.handle.serialLog
    if (!path) return
    const tail = readSerialTail(path)
    if (!tail) return
    console.error(`[pool] guest serial tail (${reason}) project=${a.projectId} vm=${a.handle.id}:\n${tail}`)
  }

  /** {@link restrictToOwnMembers}, logging and counting whatever it had to strip. */
  private ownMembersOnly<B extends { attachedProjectIds?: string[] } | undefined>(
    runtimeKey: string,
    env: Record<string, string>,
    bind?: B,
  ): { env: Record<string, string>; bind?: B } {
    const r = restrictToOwnMembers(runtimeKey, env, bind)
    if (r.foreign.length) {
      metrics.inc(M.foreignMembersStripped, r.foreign.length)
      console.error(
        `[pool] refusing foreign workspace members for ${runtimeKey}: ${r.foreign.join(',')} ` +
          `(a project is only online in its own runtime)`,
      )
    }
    return { env: r.env, bind: r.bind }
  }

  /** Mount a project archive into an already-running workspace microVM. */
  async mountWorkspaceMember(
    runtimeKey: string,
    projectId: string,
    destDir: string,
  ): Promise<{ hydrated: boolean }> {
    if (!ownMemberIds(runtimeKey).includes(projectId)) {
      metrics.inc(M.foreignMemberMountRefused)
      throw new ForeignMemberError(runtimeKey, projectId)
    }
    const assigned = this.assigned.get(runtimeKey)
    if (!assigned) throw new Error(`workspace runtime ${runtimeKey} is not assigned`)
    const env: Record<string, string> = assigned.runtimeToken ? { RUNTIME_AUTH_SECRET: assigned.runtimeToken } : {}
    const ref = await this.sourceRef(projectId)
    if (ref) {
      await this.applyArchive(assigned.handle, env, ref, `${projectId} workspace member`, destDir)
    }
    this.linkMemberSource(assigned, projectId, ref)
    await this.hydrateMemberData(assigned, env, projectId, destDir)
    const response = await fetch(
      `${assigned.handle.agentUrl}/internal/workspace/members`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(assigned.runtimeToken ? { 'x-runtime-token': assigned.runtimeToken } : {}),
        },
        body: JSON.stringify({ id: projectId }),
        signal: AbortSignal.timeout(this.cfg.hydrateTimeoutMs),
      },
    )
    if (!response.ok) {
      throw new Error(`workspace member mount failed (${response.status}): ${await response.text().catch(() => '')}`)
    }
    assigned.workspaceMemberIds = [...new Set([...(assigned.workspaceMemberIds ?? []), projectId])]
    this.writeLive(assigned)
    return { hydrated: !!ref }
  }

  /** Export and remove a member from a running workspace microVM. */
  async unmountWorkspaceMember(
    runtimeKey: string,
    projectId: string,
    destDir: string,
  ): Promise<{ exported: boolean }> {
    const assigned = this.assigned.get(runtimeKey)
    if (!assigned) return { exported: false }
    const r = await this.evictMember(assigned, projectId, destDir)
    return { exported: r.outcome === 'exported' }
  }

  /**
   * Export a member under its lineage, save its writable state, then remove it
   * from the guest. The guest deletes the member's folder, so a source export
   * that landed nowhere durable (neither the backup nor a quarantine key)
   * throws and leaves the member mounted.
   */
  private async evictMember(
    assigned: AssignedVm,
    projectId: string,
    destDir: string,
  ): Promise<{ outcome: 'exported' | 'conflict' | 'empty'; detail?: string }> {
    const bytes = await this.fetchExport(assigned.handle, assigned.runtimeToken, destDir)
    let outcome: 'exported' | 'conflict' | 'empty' = 'empty'
    let detail: string | undefined
    if (bytes) {
      const stored = await this.storeMemberSource(assigned, projectId, bytes)
      if (stored.ok) {
        outcome = 'exported'
        detail = stored.outcome.status
      } else if (stored.outcome.status === 'conflict' && stored.outcome.quarantineKey) {
        outcome = 'conflict'
        detail = `quarantined at ${stored.outcome.quarantineKey}`
      } else {
        throw new Error(
          `source export of ${projectId} from ${assigned.projectId} is not durable (${stored.outcome.status}); left mounted`,
        )
      }
    }
    const slot = this.memberDataSlot(assigned, projectId, destDir)
    await this.dataFlight
      .run(slot.flightKey, () => this.saveDataSlotInner(assigned, slot, { final: true }))
      .catch((err) =>
        console.error(`[pool] writable-state backup for unmounted member ${projectId} failed:`, err?.message ?? err),
      )
    await this.removeGuestMember(assigned, projectId)
    assigned.workspaceMemberIds = (assigned.workspaceMemberIds ?? []).filter((id) => id !== projectId)
    if (assigned.memberData) delete assigned.memberData[projectId]
    this.dataTags.delete(slot.flightKey)
    this.writeLive(assigned)
    return { outcome, detail }
  }

  /** Unmount a member in the guest, which deletes its folder. `protected` for tests. */
  protected async removeGuestMember(a: AssignedVm, projectId: string): Promise<void> {
    const response = await fetch(`${a.handle.agentUrl}/internal/workspace/members/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers: a.runtimeToken ? { 'x-runtime-token': a.runtimeToken } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`workspace member unmount failed (${response.status}): ${await response.text().catch(() => '')}`)
    }
  }

  /**
   * Take every foreign member (see {@link ownMemberIds}) off every running
   * workspace VM on this host: export it under its lineage (written, or
   * quarantined on a mismatch), save its writable state, and unmount it. For
   * VMs that predate the single-runtime rule; new assigns never mount one.
   */
  async drainForeignMembers(): Promise<ForeignMemberDrainResult[]> {
    const results: ForeignMemberDrainResult[] = []
    for (const a of [...this.assigned.values()]) {
      if (!a.projectId.startsWith('ws:') || !this.mgr.isRunning(a.handle)) continue
      // Those drain themselves before their final backups.
      if (this.suspendFlight.has(a.projectId) || this.recycleFlight.has(a.projectId)) continue
      results.push(...(await this.drainForeignMembersOf(a)))
    }
    return results
  }

  private async drainForeignMembersOf(a: AssignedVm, listTimeoutMs?: number): Promise<ForeignMemberDrainResult[]> {
    return this.sourceLock.run(a.projectId, async () => {
      const own = ownMemberIds(a.projectId)
      const mounted = (await this.guestMountedMembers(a, listTimeoutMs)) ?? []
      const foreign = [...new Set([...(a.workspaceMemberIds ?? []), ...mounted])].filter((id) => !own.includes(id))
      const results: ForeignMemberDrainResult[] = []
      for (const projectId of foreign) {
        let r: ForeignMemberDrainResult
        try {
          r = { runtimeKey: a.projectId, projectId, ...(await this.evictMember(a, projectId, `/app/workspace/${projectId}`)) }
        } catch (err: any) {
          r = { runtimeKey: a.projectId, projectId, outcome: 'failed', detail: err?.message ?? String(err) }
        }
        metrics.inc(`${M.foreignMemberDrained}{outcome="${r.outcome}"}`)
        const line = `[pool] drained foreign member ${projectId} from ${a.projectId}: ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`
        if (r.outcome === 'failed') console.error(line)
        else console.log(line)
        results.push(r)
      }
      return results
    })
  }

  /**
   * Runtimes on this host that hold `projectId` online: its own runtime, plus
   * any workspace VM that tracks or has mounted it. One entry is the invariant.
   */
  async memberHolders(projectId: string): Promise<string[]> {
    const own = `ws:proj:${projectId}`
    const vms = [...this.assigned.values()]
    const held = await Promise.all(
      vms.map(async (a) => {
        if (a.projectId === own || a.projectId === projectId) return true
        if (!a.projectId.startsWith('ws:')) return false
        if (a.workspaceMemberIds?.includes(projectId)) return true
        return ((await this.guestMountedMembers(a, 3_000)) ?? []).includes(projectId)
      }),
    )
    return vms.filter((_, i) => held[i]).map((a) => a.projectId).sort()
  }

  /**
   * Open a project on this host: resume its snapshot if one exists (hot local
   * OR durable store), else claim+assign a warm VM. Concurrent opens for the
   * same project collapse into one via singleflight (no double cold-boot / no
   * racing resumes).
   */
  async open(
    projectId: string,
    env: Record<string, string> = {},
    bind?: { workspaceId?: string; attachedProjectIds?: string[] },
    opts: { cause?: VmCause } = {},
  ): Promise<OpenResult> {
    ;({ env, bind } = this.ownMembersOnly(projectId, env, bind))
    const r = await this.openOnce(projectId, env, bind, null, opts.cause)
    // Joined a concurrent staged open that had nothing to boot: this caller
    // needs a running VM, so open again (now as the flight's owner).
    if (r.mode === 'prewarmed') return this.open(projectId, env, bind, opts)
    return r
  }

  /**
   * Pre-warm open on the STAGED rootfs (switch-over): boot a fresh VM from the
   * staged image without touching the project's current snapshot, so its
   * suspend lands in `stagedSuspended`. An already-live project is handed back
   * as-is (`bootRootfsIdentity` tells the caller which image it is on).
   */
  async openStaged(
    projectId: string,
    env: Record<string, string> = {},
    bind?: { workspaceId?: string; attachedProjectIds?: string[] },
  ): Promise<OpenResult | PrewarmedResult> {
    ;({ env, bind } = this.ownMembersOnly(projectId, env, bind))
    const staged = this.stagedRootfs(this.resolveVmClass(projectId, env))
    if (!staged) throw new StagedRootfsUnavailableError(`no staged rootfs on this host for ${projectId}`)
    // A staged open is always the switch-over pre-warm, whatever the caller
    // labelled it: it exists to fill the new image, not to serve a user.
    return this.openOnce(projectId, env, bind, staged, 'prewarm')
  }

  private async openOnce(
    projectId: string,
    env: Record<string, string>,
    bind: { workspaceId?: string; attachedProjectIds?: string[] } | undefined,
    staged: { path: string; identity: string } | null,
    cause: VmCause = 'user_open',
  ): Promise<OpenResult | PrewarmedResult> {
    const r = await this.openFlight.run(projectId, async (): Promise<OpenResult | PrewarmedResult> => {
      const timer = new PhaseTimer()
      const done = (res: Omit<OpenResult, 'phases' | 'totalMs'>): OpenResult => ({
        ...res,
        phases: timer.phases(),
        totalMs: timer.totalMs(),
      })
      if (staged) {
        const held = this.stagedSuspended.get(projectId)
        if (held && held.rootfsIdentity === staged.identity && !this.assigned.has(projectId)) {
          return { mode: 'prewarmed', stagedSnapshotIdentity: staged.identity }
        }
        if (held) await this.dropStaged(projectId)
      } else if (this.stagedSuspended.has(projectId)) {
        // A user open changes the project's data, so a snapshot pre-warmed
        // before it is already behind.
        await this.dropStaged(projectId)
      }
      // Idempotent: if the project is already live here, hand back the same VM
      // rather than restoring a duplicate from the store (which a re-/assign
      // for a live project — e.g. a control-plane replica routing to the placed
      // host — would otherwise trigger).
      const live = this.assigned.get(projectId)
      const liveT0 = performance.now()
      if (live) {
        // Only hand back the tracked VM if its firecracker process is still
        // alive AND the guest still answers HTTP. A dead process (crash, OOM-kill,
        // or a lost suspend race) left in the assigned map is a PHANTOM: we would
        // return its guest URL as a warm "reused" hit, the control plane would
        // proxy to it and get ECONNREFUSED/timeout, and because the wake poll keeps
        // touching the entry the idle reaper never clears it. A mute guest (FC
        // process alive, HTTP hung) is the same phantom with a live PID — the
        // 2026-08 wedged-guest outage. Once it has stayed mute past
        // MUTE_DISCARD_AFTER_MS, discard and fall through to resume/boot so
        // THIS open self-heals.
        const running = this.mgr.isRunning(live.handle)
        let healthy =
          running &&
          ((await this.isGuestHealthy(live.handle)) || (await this.isGuestHealthy(live.handle, { patient: true })))
        if (running && !healthy) {
          // Hand back a slow guest rather than destroy it: reprovisioning a
          // busy VM loses its in-flight work and its unsaved workspace.
          const failedFor = live.activityPollFailedAt !== undefined ? Date.now() - live.activityPollFailedAt : 0
          if (failedFor < MUTE_DISCARD_AFTER_MS) {
            console.warn(
              `[pool] assigned VM ${live.handle.id} for ${projectId} is slow to answer (activity polls failing for ${Math.round(failedFor / 1000)}s) — keeping it`,
            )
            healthy = true
          }
        }
        if (healthy) {
          live.lastTouchedAt = Date.now()
          live.lastHealthOk = true
          // Re-assert the drive size on every open, like always-on: a project
          // that raised its setting while the VM was live, or a VM that predates
          // the grow, converges here. No-op when it is already big enough.
          const wantDriveMiB = workspaceDriveMiBFromEnv(env)
          if (wantDriveMiB !== undefined) {
            await this.ensureWorkspaceDriveSize(live, wantDriveMiB).catch((err: any) =>
              console.warn(`[pool] open: workspace-drive grow failed for ${projectId}:`, err?.message ?? err),
            )
          }
          if (bind?.attachedProjectIds) {
            // Merge, never replace: the caller's attachments omit projects
            // mounted live into this VM, and dropping them here meant their
            // work was never backed up.
            live.workspaceMemberIds = [...new Set([...(live.workspaceMemberIds ?? []), ...bind.attachedProjectIds])]
            this.writeLive(live)
          }
          // `reused`: re-attached an already-running VM (no boot, no resume).
          // The control plane records this as a warm hit, not a cold miss.
          timer.add('live_check', performance.now() - liveT0)
          return done({
            handle: live.handle,
            mode: 'assigned',
            reused: true,
            bootRootfsIdentity: this.bootRootfsIdentity(live),
          })
        }
        const mute = this.mgr.isRunning(live.handle)
        if (mute) {
          metrics.inc(M.healthGateDiscard)
          this.dumpGuestSerial(live, 'health-gate')
          console.warn(
            `[pool] assigned VM ${live.handle.id} for ${projectId} is running but guest HTTP is mute — rescuing workspace, then reprovisioning`,
          )
        } else {
          console.warn(
            `[pool] assigned VM ${live.handle.id} for ${projectId} is dead (fc process gone) — rescuing workspace, then reprovisioning`,
          )
        }
        await this.discardDeadVm(live, mute ? 'health-gate: guest mute' : 'health-gate: fc process gone')
        timer.add('live_check', performance.now() - liveT0)
      }
      if (staged) {
        // Never resume here: the current snapshot stays the project's serving
        // copy until activation, and this boot is on the new image.
        const a = await this.assign(projectId, env, bind, timer, staged, cause)
        return done({ handle: a.handle, mode: 'assigned', bootRootfsIdentity: staged.identity })
      }
      let staleReason: StaleReason | undefined
      if (await timer.time('can_resume', () => this.canResume(projectId))) {
        try {
          const res = await this.resume(projectId, env, timer, cause)
          if (res)
            return done({
              handle: res.assigned.handle,
              mode: 'resumed',
              source: res.source,
              readyMs: res.readyMs,
              suspendReason: res.suspendReason,
              bootRootfsIdentity: this.bootRootfsIdentity(res.assigned),
            })
          staleReason = this.lastStaleReason.get(projectId) ?? 'no_snapshot'
        } catch (err: any) {
          staleReason = 'resume_error'
          // A resume can throw on an unrestorable snapshot (e.g. the dm CoW
          // store went missing). Never surface that as a hard open failure —
          // drop the unusable LOCAL entry and fall through to a cold boot so the
          // project still opens. The durable copy (if any) is left intact.
          console.error(
            `[pool] resume failed for ${projectId}, falling back to cold boot:`,
            err?.message ?? err,
          )
          await this.evictLocal(projectId)
        }
      } else {
        staleReason = 'no_snapshot'
      }
      this.lastStaleReason.delete(projectId)
      const a = await this.assign(projectId, env, bind, timer, undefined, cause)
      return done({ handle: a.handle, mode: 'assigned', staleReason, bootRootfsIdentity: this.bootRootfsIdentity(a) })
    })
    if (r?.mode === 'prewarmed') return r
    const reported = this.reportOpen(projectId, r as OpenResult)
    // Always-on: paid tiers (control plane sets SHOGO_ALWAYS_ON) must never be
    // idle-suspended by the reaper. Re-assert on EVERY open — this is the one
    // path with `env`, so it also (re)applies the flag after a resume (which
    // carries no env) and re-persists it for adopt-on-restart.
    const alwaysOn = env.SHOGO_ALWAYS_ON === '1' || env.SHOGO_ALWAYS_ON === 'true'
    const publishedSubdomain = publishedSubdomainFromEnv(env) ?? this.assigned.get(projectId)?.publishedSubdomain
    const a = this.assigned.get(projectId)
    if (a) {
      const token = env.RUNTIME_AUTH_SECRET || a.runtimeToken
      if (!!a.alwaysOn !== alwaysOn || a.runtimeToken !== token || a.publishedSubdomain !== publishedSubdomain) {
        a.alwaysOn = alwaysOn
        a.runtimeToken = token
        a.publishedSubdomain = publishedSubdomain
        this.writeLive(a)
      }
    }
    return reported
  }

  /**
   * Attach what the control plane needs to see how an open went, and keep a
   * copy for the slow case. The control plane stops waiting on /assign after
   * 30s, so a slow open's phases die with the request that timed out; its
   * retry is then a `reused` hit. That retry gets the stashed open as
   * `lateWake`, once, so the slow opens are exactly the ones still measured.
   */
  private reportOpen(projectId: string, r: OpenResult): OpenResult {
    if (r.reused) {
      const late = this.lastOpen.get(projectId)
      this.lastOpen.delete(projectId)
      if (late && Date.now() - late.at <= LATE_WAKE_TTL_MS) return { ...r, lateWake: late }
      return r
    }
    const a = this.assigned.get(projectId)
    const repo = r.mode === 'assigned' ? a?.repoRestore : undefined
    if (a) a.repoRestore = undefined
    const out: OpenResult = repo ? { ...r, repo } : r
    const late: LateWake = {
      at: Date.now(),
      mode: r.mode,
      ...(r.source ? { source: r.source } : {}),
      ...(r.staleReason ? { staleReason: r.staleReason } : {}),
      ...(r.suspendReason ? { suspendReason: r.suspendReason } : {}),
      phases: r.phases ?? {},
      totalMs: r.totalMs ?? 0,
      ...(repo ? { repo } : {}),
    }
    this.lastOpen.set(projectId, late)
    if (this.lastOpen.size > 500) {
      const cutoff = Date.now() - LATE_WAKE_TTL_MS
      for (const [k, v] of this.lastOpen) if (v.at < cutoff) this.lastOpen.delete(k)
    }
    console.log(
      `[pool] opened ${projectId} mode=${r.mode}${r.source ? `/${r.source}` : ''}` +
        `${r.staleReason ? ` stale=${r.staleReason}` : ''} total=${r.totalMs ?? '?'}ms` +
        `${repo ? ` repo=${repo.mode}(${repo.bundles}b/${repo.bytes}B in ${repo.foregroundMs}ms)` : ''} ` +
        `phases=${JSON.stringify(r.phases ?? {})}`,
    )
    return out
  }

  /** Claim + assign a warm VM to a project (or boot one on a cold miss). */
  async assign(
    projectId: string,
    env: Record<string, string> = {},
    bind?: { workspaceId?: string; attachedProjectIds?: string[] },
    timer = new PhaseTimer(),
    staged?: { path: string; identity: string },
    cause: VmCause = 'user_open',
  ): Promise<AssignedVm> {
    ;({ env, bind } = this.ownMembersOnly(projectId, env, bind))
    const vmClass = this.resolveVmClass(projectId, env)
    if (projectId.startsWith('ws:')) {
      env = await timer.time('confirm_members', () => this.withConfirmedNewMembers(env))
    }
    // Pool VMs boot from the current image at the class's size, so a staged
    // boot or a project that needs a bigger VM always starts fresh.
    const bigger = vmBootSize(env, classConfig(this.cfg, vmClass))
    // Make room BEFORE claiming/booting: a host full of warm VMs serves this
    // project by suspending the longest-idle one, instead of the control plane
    // buying another host to hold VMs nobody is using (SHO-444). Never fails the
    // assign — see `makeRoom`.
    await timer.time('evict_wait', () =>
      this.makeRoom({
        exclude: projectId,
        vmMemMiB: bigger?.memoryMB ?? classConfig(this.cfg, vmClass).memMiB,
      }),
    )
    let vm = staged || bigger ? null : this.claim(vmClass)
    if (!vm) {
      const t0 = performance.now()
      let waited = 0
      vm = await this.heavy.run(
        () => this.bootOne(false, vmClass, staged?.path, bigger),
        (ms) => {
          waited = ms
          timer.add('heavy_wait', ms)
        },
      )
      timer.add('boot', performance.now() - t0 - waited)
    }
    return this.assignVm(projectId, env, bind, timer, vm, staged?.identity, cause)
  }

  private resolveVmClass(projectId: string, env: Record<string, string>): VmClass {
    const vmClass = vmClassFromEnv(env)
    if (vmClass !== 'standard' && !isVmClassSupported(this.cfg, vmClass)) {
      // Fail closed to 'standard' rather than boot a docker-class VM off a
      // nonexistent/wrong image (see classConfig's own fallback for the same
      // reasoning). The control plane is expected to only route to hosts that
      // advertise the class (metal-warm-pool-controller candidate filtering) —
      // reaching here means either a routing bug or a host whose docker rootfs
      // was unset/removed after being advertised. Loud, not silent: a project
      // that NEEDS docker tooling failing its shell commands is much harder to
      // debug than a log line here.
      console.error(
        `[pool] project ${projectId} requested vmClass=${vmClass} but this host does not support it ` +
          `(METAL_DOCKER_ROOTFS unset) — falling back to a standard VM`,
      )
      return 'standard'
    }
    return vmClass
  }

  private async assignVm(
    projectId: string,
    env: Record<string, string>,
    bind: { workspaceId?: string; attachedProjectIds?: string[] } | undefined,
    timer: PhaseTimer,
    vm: PooledVm,
    stagedIdentity: string | undefined,
    cause: VmCause,
  ): Promise<AssignedVm> {
    // The claimed/booted VM is now off the pool and not yet in `assigned`. If
    // the guest /pool/assign call fails or times out we must stop it, or its FC
    // process leaks (tracked by no map). Guard the whole in-flight window.
    this.inFlight.add(vm.handle.id)
    const guestAssignT0 = performance.now()
    try {
      const res = await fetch(`${vm.handle.agentUrl}/pool/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          env,
          ...(bind?.workspaceId ? { workspaceId: bind.workspaceId, attachedProjectIds: bind.attachedProjectIds ?? [] } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`/pool/assign failed (${res.status}): ${await res.text()}`)
    } catch (err) {
      await this.mgr.stopVM(vm.handle).catch(() => {})
      throw err
    } finally {
      this.inFlight.delete(vm.handle.id)
      timer.add('guest_assign', performance.now() - guestAssignT0)
    }

    const now = Date.now()
    const publishedSubdomain = publishedSubdomainFromEnv(env)
    const a: AssignedVm = {
      projectId,
      handle: vm.handle,
      assignedAt: now,
      stateSince: now,
      cause,
      meter: { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: now },
      repoHydratePending: true,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      lastUserActivityAt: now,
      // Only a person opening the project (or a visitor hitting a published
      // site) has earned the relaxed idle window. A schedule tick, an agent
      // wake or a prewarm gets the aggressive one until someone actually shows
      // up (SHO-533).
      userSeenSinceAssign: cause === 'user_open' || cause === 'published',
      // Warm VMs never outlive the agent process (prepareForRestart kills
      // them), so this one booted from the image this process was started on.
      bootRootfsIdentity: stagedIdentity ?? this.classRootfsIdentity(vm.handle.vmClass),
      runtimeToken: env.RUNTIME_AUTH_SECRET,
      workspaceMemberIds: workspaceMemberIdsFromEnv(env),
      publishedSubdomain,
      // Provisional: a warm VM boots from the template. Promoted to 'backup'
      // below iff hydrate applies real source; a hydrate that CAN'T confirm the
      // template is correct fails the open rather than leave a mislabeled VM.
      workspaceOrigin: 'template',
      // Written BEFORE any hydrate runs, and cleared only when the open is
      // complete. A restart that adopts this entry with `'opening'` still on it
      // therefore knows the tree is a partial hydrate, not a workspace — the
      // 525 MB half-open VM that could never back up or suspend (SHO-584).
      openState: 'opening',
    }
    this.assigned.set(projectId, a)
    this.writeLive(a)

    // Grow the workspace drive to the size this project asked for, BEFORE any
    // of its files are restored (SHO-349): a project whose workspace is larger
    // than the fleet default must not be hydrated into a drive that can't hold
    // it. Best-effort — a failed grow must not fail the assignment; every later
    // open retries it.
    const requestedDriveMiB = workspaceDriveMiBFromEnv(env)
    if (requestedDriveMiB !== undefined) {
      try {
        await timer.time('workspace_drive', () => this.ensureWorkspaceDriveSize(a, requestedDriveMiB))
      } catch (err: any) {
        console.warn(`[pool] assign: workspace-drive grow failed for ${projectId}:`, err?.message ?? err)
      }
    }

    // Cold miss: this warm VM booted from the TEMPLATE, so its workspace is the
    // "Project Ready" placeholder — the project's real source lives only in the
    // durable S3 backup. (Resume-from-snapshot in open() already carries the
    // real workspace and never lands here.) Hydrate host-side so the guest gets
    // its source without ever holding S3 credentials.
    //
    // FAIL CLOSED: unlike before, a hydrate error is NOT swallowed. If a durable
    // backup exists but we couldn't apply it (guest rejected it, or S3 was
    // unreachable so we can't even rule out a backup), serving the template is
    // never acceptable — the user sees the wrong app AND the template would be
    // snapshotted/backed up over their real source on the next idle-suspend.
    // Tear the VM down and surface the error so the control plane retries.
    let sourceTimes: Record<string, number | null> = {}
    try {
      const h: { hydrated: boolean; parentEtag?: string; lastModified?: number | null } = projectId.startsWith('ws:')
        ? { hydrated: false }
        : await timer.time('hydrate_source', () =>
            this.hydrateFromBackup(publishedSourceId(projectId) ?? projectId, vm.handle, env),
          )
      if (h.hydrated) {
        a.workspaceOrigin = 'backup'
        a.backupParentEtag = h.parentEtag
        sourceTimes = { '.': h.lastModified ?? null }
        this.writeLive(a)
      }
    } catch (err: any) {
      console.error(`[pool] hydrate-from-backup failed for ${projectId} — failing open (NOT serving template):`, err?.message ?? err)
      this.closeMeter(a)
      this.assigned.delete(projectId)
      this.live.remove(projectId)
      await this.mgr.stopVM(vm.handle).catch(() => {})
      throw err
    }

    if (projectId.startsWith('ws:')) {
      try {
        sourceTimes = await timer.time('hydrate_members', () => this.hydrateWorkspaceMembers(a, env))
        // Members restored from their durable backups are real source even if
        // the merged-root repo hydrate below fails. Left at 'template', every
        // suspend evicted the snapshot and every wake cold-booted.
        if (Object.values(a.memberData ?? {}).some((m) => m.sourceParentEtag)) {
          a.workspaceOrigin = 'backup'
          this.writeLive(a)
        }
      } catch (err: any) {
        console.error(`[pool] workspace member hydrate failed for ${projectId}:`, err?.message ?? err)
        this.closeMeter(a)
        this.assigned.delete(projectId)
        this.live.remove(projectId)
        await this.mgr.stopVM(vm.handle).catch(() => {})
        throw err
      }
    }

    // Overlay the project's durable WRITABLE STATE (database + uploads) on top
    // of the source we just hydrated. Without this a cold boot restores code
    // over an empty database — which is how a rootfs rebuild (invalidating every
    // snapshot) silently destroyed a user's data. Runs for every project, not
    // just published ones.
    //
    // Best-effort by design, but a FAILURE is what makes this VM dangerous: it
    // is now running on whatever database the source archive happened to carry
    // (usually an empty one), while a real archive still sits in S3. Marking it
    // untrusted is what stops that empty database from being exported over the
    // user's data — the exact incident this subsystem exists to prevent.
    if (projectId.startsWith('ws:')) {
      await timer.time('hydrate_data', () => this.hydrateWorkspaceMemberData(a, env))
    } else if (publishedSourceId(projectId)) {
      // Live site data is the published-data overlay below; the project's dev
      // database must not leak into the site.
    } else {
      try {
        const d = await timer.time('hydrate_data', () => this.hydrateProjectData(projectId, vm.handle, env))
        if (d.hydrated) {
          a.dataParentEtag = d.parentEtag
          this.writeLive(a)
        }
        // Not hydrated + no error = no durable archive exists yet. Nothing to
        // lose, so the VM keeps create-only rights and can seed the first one.
      } catch (err: any) {
        const reason = `writable-state hydrate failed at assign (${err?.message ?? err})`
        this.distrustData(a, reason)
        console.error(
          `[pool] writable-state hydrate failed for ${projectId} — booting with the source's ` +
            `database. This VM is marked UNTRUSTED and will NOT write to the durable archive:`,
          err?.message ?? err,
        )
      }
    }

    // Overlay the project's durable `.git`. git_only's per-turn artifact is
    // `repo.git.tar.gz`; metal guests cannot persist it themselves (no S3
    // creds), so the host hydrates it here — after source, before the guest
    // starts serving chat. A failed overlay must not later overwrite the
    // durable archive with the template seed `.git`.
    //
    // Workspace runtimes too: their merged root is one repo that commits every
    // member's files each turn and is exported under the runtime key. Skipping
    // the hydrate leaves the replacement VM create-only against an archive
    // that already exists, so every later export is refused as a conflict.
    let repoDeferred = false
    try {
      // A published runtime never commits, and resetting its tree to a `.git`
      // HEAD would replace the source it just restored.
      const r = publishedSourceId(projectId)
        ? { hydrated: false as const, parentEtag: undefined }
        : await timer.time('hydrate_repo', () => this.hydrateRepoAtAssign(a, vm.handle, env, sourceTimes))
      if (r === 'deferred') {
        // finishRepoDeferred owns the rest, including clearing repoHydratePending.
        repoDeferred = true
      } else if (r.hydrated) {
        a.repoParentEtag = r.parentEtag
        // A workspace runtime has no source backup of its own (members are
        // backed up per project), so the durable merged-root repo is what
        // makes it real source. Left at 'template', every suspend would be
        // refused a durable snapshot push and every wake would cold-boot.
        if (projectId.startsWith('ws:')) a.workspaceOrigin = 'backup'
      }
      if (!repoDeferred) a.repoLinked = true
    } catch (err: any) {
      const reason = `repo hydrate failed at assign (${err?.message ?? err})`
      this.distrustRepo(a, reason)
      if (err instanceof RepoAdoptUncertainError) this.distrustSource(a, reason)
      console.error(
        `[pool] repo hydrate failed for ${projectId} — booting with the source's ` +
          `.git. This VM is marked UNTRUSTED for repo.git.tar.gz and will NOT overwrite it:`,
        err?.message ?? err,
      )
    } finally {
      if (!repoDeferred) {
        a.repoHydratePending = false
        a.repoHeadSha = undefined
        a.repoExportedHeadSha = undefined
        a.repoExportSha = undefined
        this.writeLive(a)
      }
    }

    // Restore the agent's encrypted home directory (~/.ssh, ~/.oci, ...) and
    // its workspace `.env*` files LAST, after the git checkout above and the
    // member hydrate before it. Both replace whole directory trees, so a
    // workspace `.env` restored earlier is gone before the agent ever runs —
    // the cold-boot data loss this ordering exists to prevent.
    //
    // Best-effort like writable state, and for the same reason a failure marks
    // the VM untrusted: it now has an empty home, which must never be exported
    // over the real one.
    if (homeStateEligible(publishedSubdomain)) {
      try {
        const h = await timer.time('hydrate_home', () => this.hydrateHomeState(projectId, vm.handle, env))
        if (h === 'unsupported') a.homeExportUnsupported = true
        else if (h.hydrated) a.homeParentEtag = h.parentEtag
        this.writeLive(a)
      } catch (err: any) {
        metrics.inc(M.homeHydrateFailed)
        this.distrustHome(a, `home-state hydrate failed at assign (${err?.message ?? err})`)
        console.error(
          `[pool] home-state hydrate failed for ${projectId} — booting with an empty home. ` +
            `This VM is marked UNTRUSTED and will NOT overwrite the durable home archive:`,
          err?.message ?? err,
        )
      }
    }

    // Server-backed published VM: overlay the live site's writable state
    // ({subdomain}/data.tar.gz) on top of the git-restored source so the app
    // boots with accumulated end-user data (not a fresh DB). Host-side — the
    // guest holds no S3 creds. Best-effort: a fresh/first publish has no archive.
    // Applied last so a published site's live data wins over the dev snapshot.
    // A failed hydrate leaves the VM unable to export, so its dev database can
    // never overwrite the live archive.
    if (publishedSubdomain) {
      await timer.time('hydrate_published', () => this.hydratePublishedData(a, publishedSubdomain, vm.handle, env)).catch((err) =>
        console.error(
          `[pool] published-data hydrate failed for ${publishedSubdomain} (serving the source's database; exports disabled):`,
          err?.message ?? err,
        ),
      )
    }
    // The open is complete: every archive this VM may ever write over has been
    // hydrated (or explicitly distrusted), so an adopt from here on is a normal
    // VM. Anything that adopts the entry BEFORE this line sees a partial tree.
    a.openState = 'ready'
    this.writeLive(a)
    return a
  }

  /**
   * Cold-start hydration. Returns whether a durable backup was applied and, if
   * so, the ETag the resulting workspace descends from (its lineage anchor).
   *   - no durable backup (new project) → `{ hydrated: false }`; the template
   *     is the correct initial state.
   *   - backup applied → `{ hydrated: true, parentEtag }`.
   *   - backup exists but the guest rejected it, OR S3 was unreachable so we
   *     can't even tell if a backup exists → THROWS. The caller (assign) fails
   *     closed: it must NOT serve the template over real source, because a
   *     later idle-suspend would then snapshot/back up the template and destroy
   *     the user's app (the incident this guards).
   */
  private async hydrateFromBackup(
    projectId: string,
    handle: FcVmHandle,
    env: Record<string, string>,
  ): Promise<{ hydrated: boolean; parentEtag?: string; lastModified?: number | null }> {
    const ref = await this.sourceRef(projectId)
    if (!ref) {
      console.log(`[pool] no durable backup for ${projectId} — cold start keeps template`)
      return { hydrated: false }
    }
    await this.applyArchive(handle, env, ref, `${projectId} source`)
    console.log(
      `[pool] hydrated ${projectId} from durable backup (${ref.bytes} bytes, etag=${ref.etag ?? 'none'})`,
    )
    return { hydrated: true, parentEtag: ref.etag ?? undefined, lastModified: ref.lastModified ?? null }
  }

  /**
   * Describe the durable source backup without downloading it. A `protected`
   * seam so tests can supply a canned reference without touching S3.
   */
  protected sourceRef(projectId: string): Promise<ArchiveRef | null> {
    return describeWorkspaceArchive(projectId, this.cfg, PRESIGN_TTL_SEC)
  }


  /**
   * Get an archive into the guest's workspace, preferring the guest to PULL it.
   *
   * Pushing bytes cannot work at multi-gigabyte sizes: Bun.serve accumulates a
   * request body in memory whenever the handler reads slower than the wire
   * delivers it (+2423 MB of RSS for a 1 GB body against +94 MB when the reader
   * keeps up), and `tar` never keeps up. That is what panicked the guest kernel
   * on a 2 GB cold boot — "Out of memory and no killable processes" — with the
   * host's careful chunking making no difference, because the accumulation
   * happens below the guest's handler.
   *
   * So the host hands over a short-lived presigned URL and the guest pulls it
   * through `curl` into `tar`, where a kernel pipe supplies the backpressure.
   * Neither side holds the archive, and the host no longer downloads it at all.
   *
   * What the URL POINTS AT is then a separate question, and the answer is
   * preferably this host. A guest pulls on one connection, and this object
   * store's slow mode is per-connection — 1.5-10.6 MB/s measured on real cold
   * boots, against an edge that gives up at ~100 s. The host can fetch the same
   * object several parts at a time and serve it over the tap link as one
   * ordinary stream, so the guest is unchanged and only the connections move.
   * When the proxy declines — no ranged reads, a small archive, or the host
   * already at its limit — this falls back to the presigned URL and behaves
   * exactly as it did before.
   *
   * The push remains for one case: a guest whose runtime predates the pull
   * endpoint answers 404, and during that rollout window the old path is still
   * the correct thing to do.
   */
  private async applyArchive(
    handle: FcVmHandle,
    env: Record<string, string>,
    ref: ArchiveRef,
    what: string,
    destDir?: string,
  ): Promise<void> {
    const token = env.RUNTIME_AUTH_SECRET
    const auth = token ? { Authorization: `Bearer ${token}` } : {}
    const budgetMs = this.hydrateBudgetMs(ref.bytes)

    const proxied = this.hydrateProxy.mint({
      hostIp: handle.net?.hostIp,
      guestIp: handle.guestIp,
      size: ref.bytes,
      label: what,
      range: ref.range,
    })
    // Proxy first when we have one, then the presigned URL. Ordered rather
    // than chosen, so anything the proxy gets wrong costs a retry instead of
    // the boot: it is new code in front of every cold boot, and the path it
    // replaces still works.
    const candidates = [proxied, ref.url].filter((u): u is string => !!u)

    for (const [i, url] of candidates.entries()) {
      const res = await fetch(`${handle.agentUrl}/pool/hydrate-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ url, bytes: ref.bytes, timeoutMs: budgetMs, ...(destDir ? { destDir } : {}) }),
        // The guest holds the transfer open for the whole pull, so the host's
        // own deadline has to cover it with room to answer.
        signal: AbortSignal.timeout(budgetMs + 30_000),
      })
      if (res.ok) return

      // 404 is the guest saying it has no pull endpoint at all, which no other
      // URL will fix — stop and push.
      if (res.status === 404) {
        console.log(`[pool] guest has no pull endpoint — pushing ${what} instead`)
        break
      }
      const detail = await res.text()
      const last = i === candidates.length - 1
      if (last) throw new Error(`/pool/hydrate-url (${what}) failed (${res.status}): ${detail}`)
      console.warn(
        `[pool] host-served hydrate of ${what} failed (${res.status}): ${detail} — retrying direct from the store`,
      )
    }

    const bytes = await ref.load()
    const res = await fetch(`${handle.agentUrl}/pool/hydrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        ...auth,
        ...(destDir ? { 'x-shogo-dest-dir': destDir } : {}),
      },
      ...this.archiveBody(bytes),
      signal: AbortSignal.timeout(this.hydrateBudgetMs(bytes.byteLength)),
    } as any)
    if (!res.ok) throw new Error(`/pool/hydrate (${what}) failed (${res.status}): ${await res.text()}`)
  }

  /**
   * Send an archive to the guest as a CHUNKED body rather than a sized one.
   *
   * Only the push fallback uses this. Bun.serve buffers a request body whole
   * when Content-Length is set, no matter what the handler does with it —
   * +1978 MB of RSS for a 1 GB body against +91 MB for the same bytes sent
   * chunked — so passing a Uint8Array here would be strictly worse. It does not
   * make the push safe at any size (see {@link applyArchive}); it makes the
   * push as cheap as a push can be.
   */
  protected archiveBody(bytes: Uint8Array): { body: ReadableStream<Uint8Array>; duplex: 'half' } {
    const CHUNK = 1024 * 1024
    let offset = 0
    return {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) return controller.close()
          const end = Math.min(offset + CHUNK, bytes.byteLength)
          controller.enqueue(bytes.subarray(offset, end))
          offset = end
        },
      }),
      duplex: 'half',
    }
  }

  /**
   * Hydrate deadline for an archive of `bytes`: a fixed allowance for the
   * round trip plus a per-MiB term for actually moving and extracting it.
   *
   * A single flat timeout cannot serve both ends of this distribution — the
   * median project is 0.7 MB and the largest is 1.8 GB. The flat 60 s was
   * comfortable for the former and, on a busy host, not always enough for the
   * latter; because hydrate is fail-closed, falling short does not produce a
   * slow boot but a project that will not open.
   */
  protected hydrateBudgetMs(bytes: number): number {
    const perMiB = this.cfg.hydrateTimeoutPerMiBMs
    if (!perMiB || bytes <= 0) return this.cfg.hydrateTimeoutMs
    const want = this.cfg.hydrateTimeoutMs + Math.ceil(bytes / (1024 * 1024)) * perMiB
    return Math.min(want, HYDRATE_BUDGET_CEILING_MS)
  }

  /**
   * Pull the guest's packed source archive over the control channel. A
   * `protected` seam so tests can inject bytes (or null) without a live guest.
   * Returns null when the guest reports nothing to back up (204, empty project).
   */
  protected async fetchExport(handle: FcVmHandle, token?: string, dir?: string): Promise<Uint8Array | null> {
    const dl = exportDeadline(this.cfg.hydrateTimeoutMs)
    const mem = memProbe.begin('export:source', handle.id)
    let bytes = 0
    try {
      const res = await fetch(`${handle.agentUrl}/pool/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(dir ? { body: JSON.stringify({ dir }) } : {}),
        signal: dl.signal,
      })
      if (res.status === 204) return null
      if (!res.ok) throw new Error(`/pool/export failed (${res.status}): ${await res.text()}`)
      memProbe.held(mem, Number(res.headers.get('content-length')) || 0)
      const buf = await this.readExportBody(res, `source ${handle.id}${dir ? ` ${dir}` : ''}`)
      bytes = buf.byteLength
      return bytes ? buf : null
    } catch (err) {
      // A read that stopped early — deadline, or a body the guest is still
      // sending — must be torn down, not merely abandoned: the guest only
      // releases its spool file when the connection actually goes away.
      dl.abort(err)
      throw err
    } finally {
      dl.dispose()
      memProbe.end(mem, bytes)
    }
  }

  /**
   * Write-side durability: before snapshotting on suspend, pull the LATEST
   * project source from the (still-live) guest and upload it to the durable S3
   * backup (`{projectId}/project-src.tar.gz`). This keeps the source fresh so
   * the project can cold-hydrate on a DIFFERENT metal machine even when that
   * host has no local snapshot. Host-side upload — the guest holds no S3 creds.
   * Best-effort: the snapshot is the primary resume path, so a failed backup is
   * logged and never blocks/faults the suspend.
   */
  /**
   * Lineage-guarded upload of the packed source to the durable store. A
   * `protected` seam mirroring `fetchArchive`/`fetchExport` so tests exercise
   * the guard wiring without S3.
   */
  protected uploadBackupGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: {
      parentEtag?: string
      adoptWhenUnknown?: boolean
      untrusted?: boolean
      quarantine?: QuarantineBookkeeping
    },
  ): Promise<BackupWriteOutcome> {
    return uploadWorkspaceArchiveGuarded(projectId, bytes, opts, this.cfg)
  }

  /**
   * Write-side durability with a STRUCTURAL anti-clobber guard. Pull the guest's
   * latest source and upload it to the durable backup ONLY if this workspace
   * descends from the object currently in S3 (lineage = `backupParentEtag`).
   *
   * A workspace that came up as the template, or from a stale snapshot, has a
   * lineage that no longer matches the real backup — so instead of overwriting
   * it (the incident that reduced a 148 MB project to a 337 KB template) the
   * guard diverts the export to a quarantine key and logs loudly. The one
   * exception is the migration tail: a resume of a snapshot taken before
   * lineage stamping shipped has UNKNOWN (not mismatched) lineage, so we trust
   * it (`adoptWhenUnknown`) to preserve pre-change behavior for legitimate
   * legacy workspaces — a genuine template origin is never trusted this way.
   */
  private async saveBackupToStore(a: AssignedVm): Promise<SourceSaveResult> {
    if (publishedSourceId(a.projectId)) return 'empty'
    return this.sourceLock.run(a.projectId, async () => {
      const bytes = await this.fetchExport(a.handle, a.runtimeToken)
      if (!bytes) {
        console.log(`[pool] no source to back up for ${a.projectId} (empty/new workspace)`)
        return 'empty'
      }
      return this.storeSource(a, bytes)
    })
  }

  /**
   * Read one guest export body under the shared budget and the size cap.
   *
   * Every export goes through here for the reason in `byte-budget.ts`: the guest
   * streams whatever its spool file holds and there is no cap on the guest side,
   * so the host is the only place the read can be bounded (SHO-593).
   */
  private async readExportBody(res: Response, label: string): Promise<Uint8Array> {
    try {
      return await readBoundedBody(res, {
        budget: this.exportBudget,
        capBytes: this.cfg.exportMaxBytes,
        label,
      })
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        metrics.inc(M.exportTooLarge)
        console.error(
          `[pool] refusing ${err.message} — nothing buffered, the durable backup is left in place`,
        )
      }
      throw err
    }
  }

  /**
   * Upload source bytes under the lineage guard. Returns true when the bytes
   * are durable somewhere — written, or diverted to a quarantine key.
   */
  private async storeSourceBytes(a: AssignedVm, bytes: Uint8Array): Promise<boolean> {
    return (await this.storeSource(a, bytes)) !== 'lost'
  }

  /**
   * Rescue path: the guest is gone and the source was extracted to disk. The
   * file is read whole (there is no stream into the lineage guard), so the read
   * is tracked — this is the one hold that has no size cap at all.
   */
  private async storeSourceBytesFromDisk(a: AssignedVm, path: string): Promise<boolean> {
    const mem = memProbe.begin('rescue:disk', a.projectId)
    let bytes = 0
    try {
      const buf = readFileSync(path)
      bytes = buf.byteLength
      return (await this.storeSource(a, new Uint8Array(buf))) !== 'lost'
    } finally {
      memProbe.end(mem, bytes)
    }
  }

  private async storeSource(a: AssignedVm, bytes: Uint8Array): Promise<'written' | 'quarantined' | 'lost'> {
    // Its source is the project's archive, which is already durable.
    if (publishedSourceId(a.projectId)) return 'written'
    const outcome = await this.uploadBackupGuarded(a.projectId, bytes, {
      quarantine: this.quarantineFor(a),
      parentEtag: a.backupParentEtag,
      // Only a resumed legacy snapshot (origin 'snapshot' with no stamped ETag)
      // may overwrite an object it can't prove it descends from. A template
      // origin must NEVER adopt — that is exactly the clobber we prevent.
      adoptWhenUnknown: a.workspaceOrigin === 'snapshot',
      untrusted: !!a.sourceUntrustedReason,
    })
    switch (outcome.status) {
      case 'promoted':
        metrics.inc(M.backupTemplatePromotion)
        console.log(
          `[pool] promoted real source over a template-shaped backup for ${a.projectId} ` +
            `(${bytes.byteLength} bytes); replaced placeholder kept at ${outcome.supersededKey}`,
        )
      // falls through — a promotion anchors lineage exactly like a normal write
      case 'created':
      case 'written':
      case 'adopted':
        // Re-anchor lineage to the object we just wrote so subsequent suspends
        // (and adopt-on-restart) keep passing the guard.
        a.backupParentEtag = outcome.etag ?? a.backupParentEtag
        a.workspaceOrigin = 'backup'
        this.writeLive(a)
        console.log(`[pool] saved source backup for ${a.projectId} (${bytes.byteLength} bytes, ${outcome.status}, etag=${outcome.etag ?? 'none'})`)
        return 'written'
      case 'conflict': {
        metrics.inc(M.backupConflict)
        if (outcome.reason === 'size-regression') metrics.inc(M.backupSizeRegression)
        const why =
          outcome.reason === 'size-regression'
            ? `SIZE BACKSTOP tripped — this ${bytes.byteLength}-byte (template-shaped) export would have ` +
              `collapsed a real durable backup; refusing to adopt/overwrite`
            : outcome.reason === 'untrusted'
              ? `its source tree is untrusted (${a.sourceUntrustedReason})`
              : `workspace lineage (origin=${a.workspaceOrigin ?? 'unknown'}, ` +
              `parentEtag=${a.backupParentEtag ?? 'none'}) does not match current backup ` +
              `(etag=${outcome.currentEtag ?? 'none'})`
        console.error(
          `[pool] REFUSED to overwrite durable backup for ${a.projectId} — ${why}. ` +
            `Export quarantined at ${outcome.quarantineKey} (${bytes.byteLength} bytes) — ` +
            `durable backup left intact.`,
        )
        return outcome.quarantineKey ? 'quarantined' : 'lost'
      }
      case 'skipped':
        return 'lost'
    }
    return 'lost'
  }

  /** Project ids the guest reports mounted; null when it can't say. */
  protected async guestMountedMembers(a: AssignedVm, timeoutMs = 10_000): Promise<string[] | null> {
    try {
      const res = await fetch(`${a.handle.agentUrl}/internal/workspace/members`, {
        headers: a.runtimeToken ? { 'x-runtime-token': a.runtimeToken } : {},
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { mounted?: Array<{ id?: unknown }> }
      if (!Array.isArray(body?.mounted)) return null
      return body.mounted.map((m) => m?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
    } catch {
      return null
    }
  }

  /**
   * The members to back up: the runtime's own members (see {@link ownMemberIds})
   * that the host tracks or the guest has mounted. A resume or a reused open
   * rebuilds the host's list from the caller's env, so the guest is the
   * authority on what is on its disk — but a foreign member it reports (a VM
   * from before the single-runtime rule) is never tracked or exported here:
   * `drainForeignMembers` takes it off under its own lineage.
   */
  private async workspaceMembersForBackup(
    a: AssignedVm,
    timeoutMs?: number,
  ): Promise<{ ids: string[]; guestConfirmed: boolean }> {
    const own = ownMemberIds(a.projectId)
    const known = a.workspaceMemberIds ?? []
    const mounted = await this.guestMountedMembers(a, timeoutMs)
    const foreign = [...new Set([...known, ...(mounted ?? [])])].filter((id) => !own.includes(id))
    if (foreign.length) {
      metrics.inc(M.foreignMemberBackupSkipped, foreign.length)
      console.error(
        `[pool] not backing up foreign workspace members ${foreign.join(',')} of ${a.projectId} ` +
          `(a project is only online in its own runtime; POST /drain-foreign-members exports and unmounts them)`,
      )
    }
    const ownKnown = known.filter((id) => own.includes(id))
    if (!mounted) return { ids: ownKnown, guestConfirmed: false }
    const ownMounted = mounted.filter((id) => own.includes(id))
    const untracked = ownMounted.filter((id) => !ownKnown.includes(id))
    const notMounted = ownKnown.filter((id) => !ownMounted.includes(id))
    if (untracked.length || notMounted.length) {
      metrics.inc(M.workspaceMemberDrift)
      console.warn(
        `[pool] workspace member list for ${a.projectId} disagrees with the guest: ` +
          `host [${known.join(',')}], guest mounted [${mounted.join(',')}]` +
          (untracked.length ? ` — now tracking ${untracked.join(',')}` : ''),
      )
    }
    if (untracked.length) {
      a.workspaceMemberIds = [...known, ...untracked]
      this.writeLive(a)
    }
    return { ids: [...ownKnown, ...untracked], guestConfirmed: true }
  }

  /** Back up each member's source. Returns the members whose latest source is NOT the durable backup. */
  private async saveWorkspaceMembersToStore(a: AssignedVm): Promise<Array<{ projectId: string; reason: string }>> {
    return this.sourceLock.run(a.projectId, () => this.saveWorkspaceMembersUnlocked(a))
  }

  private async saveWorkspaceMembersUnlocked(a: AssignedVm): Promise<Array<{ projectId: string; reason: string }>> {
    const failed: Array<{ projectId: string; reason: string }> = []
    const { ids } = await this.workspaceMembersForBackup(a)
    for (const projectId of ids) {
      try {
        const bytes = await this.fetchExport(
          a.handle,
          a.runtimeToken,
          `/app/workspace/${projectId}`,
        )
        if (!bytes) {
          console.warn(
            `[pool] workspace member ${projectId} in ${a.projectId} exported nothing (empty or not on disk) — no source backup written`,
          )
          continue
        }
        const { ok, outcome } = await this.storeMemberSource(a, projectId, bytes)
        if (ok) {
          console.log(`[pool] saved workspace member backup for ${projectId} (${bytes.byteLength} bytes)`)
        } else {
          failed.push({ projectId, reason: `not promoted (${outcome.status})` })
        }
      } catch (error: any) {
        failed.push({ projectId, reason: error?.message ?? String(error) })
        console.error(`[pool] workspace member backup failed for ${projectId}:`, error?.message ?? error)
      }
    }
    return failed
  }

  /**
   * Upload one member's source under its own lineage. Before this was guarded,
   * any VM holding the member (a second host, or one whose tree the guest had
   * reset to a stale repo HEAD) overwrote the backup outright.
   */
  private async storeMemberSource(
    a: AssignedVm,
    memberId: string,
    bytes: Uint8Array,
  ): Promise<{ ok: boolean; outcome: BackupWriteOutcome }> {
    const state = this.memberDataState(a, memberId)
    const outcome = await this.uploadBackupGuarded(memberId, bytes, {
      quarantine: this.quarantineFor(a),
      parentEtag: state.sourceParentEtag,
      // Unknown lineage is trusted only for the runtime's own project restored
      // from a snapshot that predates member stamping. A member this VM merely
      // found mounted in the guest has no lineage at all, and adopting it is how
      // a second VM overwrote a project's backup from a stale copy.
      adoptWhenUnknown:
        ownMemberIds(a.projectId).includes(memberId) &&
        a.workspaceOrigin === 'snapshot' &&
        !state.sourceLinked &&
        !state.sourceParentEtag,
      untrusted: !!state.sourceUntrustedReason,
    })
    switch (outcome.status) {
      case 'created':
      case 'written':
      case 'adopted':
      case 'promoted':
        state.sourceParentEtag = outcome.etag ?? state.sourceParentEtag
        state.sourceLinked = true
        this.writeLive(a)
        return { ok: true, outcome }
      case 'conflict':
        metrics.inc(M.backupConflict)
        console.error(
          `[pool] REFUSED to overwrite workspace member backup for ${memberId} (${a.projectId}) — ` +
            (outcome.reason === 'untrusted'
              ? `this member's tree is untrusted (${state.sourceUntrustedReason})`
              : `lineage (parentEtag=${state.sourceParentEtag ?? 'none'}) does not match current ` +
                `backup (etag=${outcome.currentEtag ?? 'none'})`) +
            `. Export quarantined at ${outcome.quarantineKey} (${bytes.byteLength} bytes) — durable backup left intact.`,
        )
        return { ok: false, outcome }
      default:
        return { ok: false, outcome }
    }
  }

  /** Record which backup (if any) a member's subfolder was hydrated from. */
  private linkMemberSource(a: AssignedVm, memberId: string, ref: ArchiveRef | null): void {
    const state = this.memberDataState(a, memberId)
    state.sourceParentEtag = ref?.etag ?? undefined
    state.sourceLinked = true
  }

  /**
   * Hydrate each member's source. Returns when each member's backup was last
   * written (null when unknown or absent), which the repo hydrate needs to
   * avoid resetting a newer member tree to an older repo HEAD.
   */
  /**
   * Add `WORKSPACE_NEW_PROJECT_IDS`: the members the store confirms have no
   * source backup. The guest seeds the starter only into those, so a lookup
   * that fails leaves the member out rather than risk seeding over a real
   * project.
   */
  private async withConfirmedNewMembers(env: Record<string, string>): Promise<Record<string, string>> {
    const memberIds = (env.WORKSPACE_PROJECT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)
    const confirmed: string[] = []
    for (const memberId of memberIds) {
      try {
        if (!(await this.sourceRef(memberId))) confirmed.push(memberId)
      } catch (err: any) {
        console.warn(`[pool] could not confirm workspace member ${memberId} has no backup — not seeding it:`, err?.message ?? err)
      }
    }
    return { ...env, WORKSPACE_NEW_PROJECT_IDS: confirmed.join(',') }
  }

  private async hydrateWorkspaceMembers(
    a: AssignedVm,
    env: Record<string, string>,
  ): Promise<Record<string, number | null>> {
    const sourceTimes: Record<string, number | null> = {}
    for (const projectId of a.workspaceMemberIds ?? []) {
      const ref = await this.sourceRef(projectId)
      this.linkMemberSource(a, projectId, ref)
      if (!ref) {
        console.log(`[pool] no durable backup for workspace member ${projectId} — keeping its seeded directory`)
        sourceTimes[projectId] = null
        continue
      }
      await this.applyArchive(
        a.handle,
        env,
        ref,
        `${projectId} workspace member`,
        `/app/workspace/${projectId}`,
      )
      sourceTimes[projectId] = ref.lastModified ?? null
    }
    this.writeLive(a)
    return sourceTimes
  }

  /**
   * Overlay each member's durable writable state (`{memberId}/project-data.tar.gz`)
   * onto its subfolder, after the member's source is in place. Same contract as
   * the single-project hydrate: a hydrated member claims descent from that
   * archive; a member with no archive keeps create-only rights; a FAILED
   * hydrate distrusts only that member so its (probably empty) database can
   * never be exported over the real one. Never fails the open.
   */
  private async hydrateWorkspaceMemberData(a: AssignedVm, env: Record<string, string>): Promise<void> {
    for (const memberId of a.workspaceMemberIds ?? []) {
      await this.hydrateMemberData(a, env, memberId, `/app/workspace/${memberId}`)
    }
    this.writeLive(a)
  }

  private async hydrateMemberData(
    a: AssignedVm,
    env: Record<string, string>,
    memberId: string,
    destDir: string,
  ): Promise<void> {
    const state = this.memberDataState(a, memberId)
    try {
      const ref = await this.projectDataRef(memberId)
      if (!ref) {
        console.log(`[pool] no durable writable state for workspace member ${memberId} — using the source's database`)
        return
      }
      await this.applyArchive(a.handle, env, ref, `${memberId} member writable state`, destDir)
      state.parentEtag = ref.etag ?? undefined
      console.log(
        `[pool] hydrated writable state for workspace member ${memberId} ` +
          `(${ref.bytes} bytes, etag=${ref.etag ?? 'none'})`,
      )
    } catch (err: any) {
      state.untrustedReason = `writable-state hydrate failed (${err?.message ?? err})`
      console.error(
        `[pool] writable-state hydrate failed for workspace member ${memberId} of ${a.projectId} — ` +
          `booting with the source's database. This member is marked UNTRUSTED:`,
        err?.message ?? err,
      )
    }
  }

  private memberDataState(a: AssignedVm, memberId: string): MemberDataState {
    a.memberData ??= {}
    return (a.memberData[memberId] ??= {})
  }

  /** Per-member source ETags safe to stamp into a snapshot (untrusted members omitted). */
  private trustedMemberSourceEtags(a: AssignedVm): Record<string, string> | undefined {
    if (!a.memberData) return undefined
    const out: Record<string, string> = {}
    for (const [id, s] of Object.entries(a.memberData)) {
      if (s.sourceParentEtag && !s.sourceUntrustedReason) out[id] = s.sourceParentEtag
    }
    return Object.keys(out).length ? out : undefined
  }

  /** Why this VM's source tree (or any member's) cannot be vouched for, if it cannot. */
  private sourceUntrustedReason(a: AssignedVm): string | undefined {
    if (a.sourceUntrustedReason) return a.sourceUntrustedReason
    for (const [id, s] of Object.entries(a.memberData ?? {})) {
      if (s.sourceUntrustedReason) return `member ${id}: ${s.sourceUntrustedReason}`
    }
    return undefined
  }

  /** Per-member data ETags safe to stamp into a snapshot (untrusted members omitted). */
  private trustedMemberDataEtags(a: AssignedVm): Record<string, string> | undefined {
    if (!a.memberData) return undefined
    const out: Record<string, string> = {}
    for (const [id, s] of Object.entries(a.memberData)) {
      if (s.parentEtag && !s.untrustedReason) out[id] = s.parentEtag
    }
    return Object.keys(out).length ? out : undefined
  }

  // --- per-project writable-state durability (database + uploads) ----------
  // Source durability above persists code. This persists the runtime state that
  // code operates on, for EVERY project, because a snapshot is not a backup: a
  // rootfs rebuild invalidates every snapshot at once, and the cold boot that
  // follows restores source over an empty database.

  /**
   * Pull the guest's packed writable state over the control channel.
   *
   * `knownTag` is the guest's own change fingerprint from the previous export.
   * Passing it back lets the guest answer 304 without snapshotting its
   * database or packing anything, which is what makes a short export interval
   * affordable for the many projects that are simply idle.
   *
   * Returns 'unchanged' for that 304, or null when the guest has nothing
   * writable at all (204) — a static app, or a workspace whose database has not
   * been created. `protected` so tests can inject bytes without a live guest.
   */
  protected async fetchDataExport(
    handle: FcVmHandle,
    token?: string,
    knownTag?: string,
    dir?: string,
  ): Promise<DataExportResult> {
    const dl = exportDeadline(this.cfg.hydrateTimeoutMs)
    const mem = memProbe.begin('export:data', handle.id)
    let bytes = 0
    try {
      const res = await fetch(`${handle.agentUrl}/pool/export-data`, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(knownTag ? { 'If-None-Match': knownTag } : {}),
          ...(dir ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(dir ? { body: JSON.stringify({ dir }) } : {}),
        signal: dl.signal,
      })
      if (res.status === 304) return 'unchanged'
      if (res.status === 204) return null
      // A guest from before this endpoint existed. Distinguished from a real
      // failure because it is permanent for this VM and must not be retried.
      if (res.status === 404) return 'unsupported'
      if (!res.ok) throw await exportError(res)
      memProbe.held(mem, Number(res.headers.get('content-length')) || 0)
      const buf = await this.readExportBody(res, `writable state ${handle.id}${dir ? ` ${dir}` : ''}`)
      bytes = buf.byteLength
      if (!bytes) return null
      return { bytes: buf, tag: res.headers.get('etag') }
    } catch (err) {
      dl.abort(err)
      throw err
    } finally {
      dl.dispose()
      memProbe.end(mem, bytes)
    }
  }

  /** Guarded (conditional) upload of writable state. `protected` for tests. */
  protected uploadDataGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { lineage: DataLineage; preserveOnRefusal?: boolean; quarantine?: QuarantineBookkeeping },
  ): Promise<DataWriteOutcome> {
    return uploadProjectDataGuarded(projectId, bytes, opts, this.cfg)
  }

  /**
   * Cold-start hydration of writable state: pull `{projectId}/project-data.tar.gz`
   * and stream it to the guest's `/pool/hydrate`, which extracts it over the
   * source tree. The archive is rooted at the workspace dir (`prisma/dev.db`,
   * `uploads/`), so it overlays cleanly on the source we hydrated first.
   *
   * Returns the archive's ETag so the caller can stamp lineage — that stamp is
   * what later authorizes this VM to overwrite the archive.
   */
  private async hydrateProjectData(
    projectId: string,
    handle: FcVmHandle,
    env: Record<string, string>,
  ): Promise<{ hydrated: boolean; parentEtag?: string }> {
    const ref = await this.projectDataRef(projectId)
    if (!ref) {
      console.log(`[pool] no durable writable state for ${projectId} — using the source's database`)
      return { hydrated: false }
    }
    await this.applyArchive(handle, env, ref, `${projectId} writable state`)
    console.log(
      `[pool] hydrated writable state for ${projectId} ` +
        `(${ref.bytes} bytes, etag=${ref.etag ?? 'none'})`,
    )
    return { hydrated: true, parentEtag: ref.etag ?? undefined }
  }

  /** Describe the durable writable-state archive. `protected` for tests. */
  protected projectDataRef(projectId: string): Promise<ArchiveRef | null> {
    return describeProjectDataArchive(projectId, this.cfg, PRESIGN_TTL_SEC)
  }

  private trustedRepoEtag(a: AssignedVm): string | undefined {
    return a.repoUntrustedReason ? undefined : a.repoParentEtag
  }

  protected repoLineageOf(a: AssignedVm): RepoLineage {
    if (a.repoUntrustedReason) return { kind: 'untrusted', reason: a.repoUntrustedReason }
    if (a.repoParentEtag) return { kind: 'descends', etag: a.repoParentEtag }
    return { kind: 'create-only' }
  }

  /**
   * The source tree may have been rewritten behind the host, so no export of
   * it may land on a durable source backup. Workspace runtimes mark every
   * member: the reset spans the whole merged root.
   */
  private distrustSource(a: AssignedVm, reason: string): void {
    if (a.projectId.startsWith('ws:')) {
      for (const id of a.workspaceMemberIds ?? []) {
        const state = this.memberDataState(a, id)
        state.sourceUntrustedReason ??= reason
      }
    } else {
      a.sourceUntrustedReason ??= reason
    }
    console.error(`[pool] source of ${a.projectId} is UNTRUSTED — its exports go to conflict/ only: ${reason}`)
    this.writeLive(a)
  }

  private distrustRepo(a: AssignedVm, reason: string): void {
    if (a.repoUntrustedReason === reason) return
    a.repoUntrustedReason = reason
    this.writeLive(a)
  }

  /**
   * Ask the guest to commit its working tree before this VM is backed up and
   * destroyed (SHO-399). The repo backup bundles commits that already exist and
   * makes none of its own, so without this every edit since the last
   * turn-complete auto-commit dies with the VM.
   *
   * Returns null on success, or the reason it failed — a failed checkpoint is a
   * failed backup step, so a non-forced recycle aborts and retries later
   * instead of dropping the agent's work. A guest older than the route answers
   * 404 and keeps today's behaviour (the export's own best-effort flush).
   */
  protected async checkpointGuest(a: AssignedVm, noteTmp?: (tmp: DroppedTmpReport) => void): Promise<string | null> {
    if (a.repoHydratePending) return null
    const res = await fetch(`${a.handle.agentUrl}/pool/checkpoint-commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(a.runtimeToken ? { 'x-runtime-token': a.runtimeToken, Authorization: `Bearer ${a.runtimeToken}` } : {}),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      return `checkpoint commit failed (${res.status})${text ? `: ${text}` : ''}`
    }
    const body = (await res.json().catch(() => null)) as { tmp?: Partial<DroppedTmpReport> } | null
    const tmp = readTmpReport(body?.tmp)
    if (tmp) noteTmp?.(tmp)
    return null
  }

  protected async fetchRepoExport(
    handle: FcVmHandle,
    token?: string,
    opts: { skipLfsPush?: boolean } = {},
  ): Promise<RepoExport | null> {
    const dl = exportDeadline(this.cfg.hydrateTimeoutMs)
    try {
      return await this.readRepoExport(handle, token, dl, opts)
    } catch (err) {
      dl.abort(err)
      throw err
    } finally {
      dl.dispose()
    }
  }

  private async readRepoExport(
    handle: FcVmHandle,
    token: string | undefined,
    dl: { signal: AbortSignal },
    opts: { skipLfsPush?: boolean } = {},
  ): Promise<RepoExport | null> {
    const res = await fetch(`${handle.agentUrl}/pool/export-repo`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.skipLfsPush ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.skipLfsPush ? { body: JSON.stringify({ skipLfsPush: true }) } : {}),
      signal: dl.signal,
    })
    if (res.status === 204) return null
    if (res.status === 404) return null
    if (!res.ok) {
      // Both export paths classify here or nowhere: a corrupt `.git` must
      // become RepoCorruptError whichever endpoint the guest answered on, or
      // the pool would keep re-exporting 525 MB every sweep (SHO-584).
      const text = await res.text()
      const message = `/pool/export-repo failed (${res.status}): ${text}`
      if (isRepoCorrupt(text)) throw new RepoCorruptError(message)
      throw new Error(message)
    }
    const path = this.exportSpoolPath(handle.id, 'repo')
    const dispose = () => rmSync(path, { force: true })
    let spooled: { size: number; sha256: string }
    try {
      spooled = await spoolResponse(res, path, REPO_MAX_BYTES)
    } catch (err) {
      dispose()
      throw err
    }
    if (!spooled.size) {
      dispose()
      return null
    }
    const rootCommitAt = Number(res.headers.get(REPO_ROOT_COMMIT_AT_HEADER))
    return {
      bytes: Bun.file(path),
      rootCommitAt: Number.isFinite(rootCommitAt) && rootCommitAt > 0 ? rootCommitAt : null,
      sha256: spooled.sha256,
      dispose,
    }
  }

  /** Spool dir for in-flight guest exports. Emptied at startup. */
  protected get exportSpoolDir(): string {
    return join(this.cfg.runDir, 'exports')
  }

  private exportSpoolPath(vmId: string, kind: string): string {
    mkdirSync(this.exportSpoolDir, { recursive: true })
    const rand = Math.random().toString(36).slice(2, 8)
    return join(this.exportSpoolDir, `${vmId}-${kind}-${Date.now()}-${rand}.tar.gz`)
  }

  protected uploadRepoGuarded(
    projectId: string,
    bytes: RepoBody,
    opts: { lineage: RepoLineage; preserveOnRefusal?: boolean; quarantine?: QuarantineBookkeeping },
  ): Promise<RepoWriteOutcome> {
    return uploadRepoArchiveGuarded(projectId, bytes, opts, this.cfg)
  }

  async saveRepoToStore(a: AssignedVm): Promise<boolean> {
    try {
      const saved = await this.repoFlight.run(a.projectId, () => this.saveRepoInner(a))
      // A repo that saves again is no longer corrupt: a heal (or the guest's own
      // gc) can repair it, and keeping the block would pin the VM to its old
      // rootfs for six hours at a time.
      if (saved && a.repoCorruptFailure) {
        a.repoCorruptFailure = undefined
        this.writeLive(a)
      }
      return saved
    } catch (err) {
      // A corrupt `.git` is permanent for this VM, not a slow guest: record it so
      // rotation blocks (SHO-584) instead of re-exporting every ten minutes.
      if (err instanceof RepoCorruptError) this.noteRepoCorrupt(a, err.message)
      throw err
    }
  }

  /**
   * Record that this VM's `.git` cannot be exported because the repository
   * itself is corrupt (`bad object` / `missing blob`).
   *
   * Only the first failure of a streak alerts: a corrupt repo does not heal by
   * being retried, and the fleet-wide signal (the counter, one journal line
   * naming the project) is what a human acts on. The state is persisted so an
   * adopt does not restart the clock, and `rotateStale` reads it to block
   * rotation for {@link ROTATE_BLOCKED_RETRY_MS}.
   */
  private noteRepoCorrupt(a: AssignedVm, message: string, now = Date.now()): void {
    const prev = a.repoCorruptFailure
    a.repoCorruptFailure = {
      code: REPO_CORRUPT_CODE,
      message: message.slice(0, 500),
      since: prev?.since ?? now,
      attempts: (prev?.attempts ?? 0) + 1,
      // Not tried again until this passes, even across a restart: retrying a
      // corrupt repo is what produced the 525 MB-every-ten-minutes loop.
      retryAt: now + ROTATE_BLOCKED_RETRY_MS,
    }
    this.writeLive(a)
    if (prev) return
    metrics.inc(M.repoCorrupt)
    console.error(
      `[pool] repo of ${a.projectId} is CORRUPT (${REPO_CORRUPT_CODE}): ${a.repoCorruptFailure.message}. ` +
        `Its git history cannot be exported until the guest's .git is repaired; rotation will not retry it ` +
        `every pass, and its exports are not re-attempted until then.`,
    )
  }

  /**
   * Export this VM's `.git`, classifying a CORRUPT repository on the way out.
   *
   * The single funnel for both export paths (the tarball/bundle writer and a
   * recycle's final backup), so whichever one meets `bad object` records the
   * same persistent block instead of only the tarball path noticing (SHO-584).
   */
  private async exportRepoOf(a: AssignedVm, opts: { skipLfsPush?: boolean } = {}): Promise<RepoExport | null> {
    try {
      return await this.fetchRepoExport(a.handle, a.runtimeToken, opts)
    } catch (err) {
      if (err instanceof RepoCorruptError) this.noteRepoCorrupt(a, err.message)
      throw err
    }
  }

  private async saveRepoInner(a: AssignedVm): Promise<boolean> {
    if (publishedSourceId(a.projectId)) return false
    // A corrupt `.git` is permanent until something repairs it, so it is not
    // re-exported inside the block window. One attempt is made when the window
    // expires: a guest-side heal (or gc) can fix it, and a success clears the
    // mark in `saveRepoToStore` (SHO-584).
    if (a.repoCorruptFailure && Date.now() < a.repoCorruptFailure.retryAt) return false
    // No root repo in the guest: there are no commits to make durable, and
    // asking for an export only produced a 500 `not a git repository` every
    // sweep (SHO-540).
    if (a.repoAbsent) return false
    if (a.repoHydratePending) return false
    const lineage = this.repoLineageOf(a)
    if (lineage.kind === 'untrusted') {
      // An untrusted VM used to save NOTHING for the rest of its life, which is
      // how a day and a half of work was lost (SHO-442). It cannot write the
      // real repo, but its `.git` still goes to `conflict/` — the floor that
      // keeps the work durable until the reconcile heals it.
      return this.quarantineRepo(a)
    }
    const head = a.repoHeadSha
    const bundled = await this.storeRepoBundles(a)
    if (bundled !== null) {
      if (bundled !== 'lost' && head && a.repoHeadSha === head) {
        a.repoExportedHeadSha = head
        a.repoLastSavedAt = Date.now()
      }
      return bundled === 'written'
    }
    let exported: RepoExport | null
    try {
      exported = await this.exportRepoOf(a)
    } catch (err) {
      if (err instanceof ExportTooLargeError) metrics.inc(M.repoTooLarge)
      throw err
    }
    if (!exported) return false
    try {
      // A guest that reports no HEAD is exported every sweep, so the HEAD skip
      // never fires for it. The bytes it sends are already durable when they
      // match this VM's last upload.
      const sha = exported.sha256 ?? (await repoBodySha256(exported.bytes))
      if (sha === a.repoExportSha) {
        metrics.inc(M.repoExportUnchanged)
        if (head && a.repoHeadSha === head) {
          a.repoExportedHeadSha = head
          a.repoLastSavedAt = Date.now()
        }
        return false
      }
      const out = await this.storeRepoBytes(a, exported.bytes, exported.rootCommitAt)
      if (out !== 'lost') {
        a.repoExportSha = sha
        if (head && a.repoHeadSha === head) {
          a.repoExportedHeadSha = head
          a.repoLastSavedAt = Date.now()
        }
      }
      return out === 'written'
    } finally {
      exported.dispose?.()
    }
  }

  /**
   * Copy an UNTRUSTED VM's `.git` to `conflict/<projectId>/…-repo.tar.gz`.
   *
   * The tarball carries `.git/lfs/objects` itself, so the LFS push is skipped:
   * the point is to get the bytes somewhere durable NOW, not to wait on a push
   * that may be the very thing that failed. `storeRepoBytes` sees the untrusted
   * lineage and diverts the upload to the quarantine key.
   *
   * Runs on every HEAD change (see `exportAllRepos`), so the copy tracks the
   * work instead of freezing at the moment trust was lost.
   */
  protected async quarantineRepo(a: AssignedVm): Promise<boolean> {
    let exported: RepoExport | null
    try {
      exported = await this.exportRepoOf(a, { skipLfsPush: true })
    } catch (err: any) {
      console.error(`[pool] quarantine export for ${a.projectId} failed:`, err?.message ?? err)
      return false
    }
    if (!exported) return false
    try {
      const out = await this.storeRepoBytes(a, exported.bytes, exported.rootCommitAt)
      if (out === 'quarantined') {
        metrics.inc(M.repoQuarantine)
        a.repoQuarantinedHeadSha = a.repoHeadSha
        this.writeLive(a)
        console.error(
          `[pool] quarantined the repo of UNTRUSTED ${a.projectId} at HEAD ${a.repoHeadSha?.slice(0, 12) ?? 'unknown'} ` +
            `(${repoBodySize(exported.bytes)} bytes) — durable repo left intact`,
        )
        return true
      }
      if (out === 'lost') {
        console.error(`[pool] quarantine export for ${a.projectId} reached nowhere durable`)
      }
      return false
    } finally {
      exported.dispose?.()
    }
  }

  /**
   * Re-attach an UNTRUSTED VM to the durable history (SHO-442).
   *
   * Downloads the durable repo into a side staging dir, then asks the guest to
   * write a commit whose tree is its CURRENT working tree and whose parents are
   * `[durable HEAD, live HEAD]`. No file is rewritten, so a busy workspace is
   * fine. On success the VM descends from the durable repo again and normal
   * saves resume; on failure it stays untrusted and the next sweep retries.
   */
  protected async healUntrustedRepo(a: AssignedVm): Promise<boolean> {
    if (!a.repoUntrustedReason || a.repoHydratePending) return false
    if (this.assigned.get(a.projectId) !== a) return false
    const now = Date.now()
    if (a.repoHealRetryAt && now < a.repoHealRetryAt) return false

    const fail = (reason: string) => {
      a.repoHealFailures = (a.repoHealFailures ?? 0) + 1
      a.repoHealRetryAt = now + Math.min(REPO_HEAL_MAX_BACKOFF_MS, REPO_HEAL_MIN_BACKOFF_MS * 2 ** (a.repoHealFailures - 1))
      console.warn(`[pool] repo heal for ${a.projectId} deferred (${reason}); next attempt ${new Date(a.repoHealRetryAt).toISOString()}`)
      return false
    }

    const env: Record<string, string> = a.runtimeToken ? { RUNTIME_AUTH_SECRET: a.runtimeToken } : {}
    let probe: { reconcile?: boolean } | null
    try {
      probe = await this.callRepoHydrated(a.handle, env, { probe: true }, Math.min(this.cfg.hydrateTimeoutMs, 10_000))
    } catch (err: any) {
      return fail(`probe failed: ${err?.message ?? err}`)
    }
    if (probe?.reconcile !== true) return fail('guest cannot reconcile')

    const read = await this.repoManifest(a.projectId).catch(() => null)
    const ref = read ? null : await this.repoRef(a.projectId).catch(() => null)
    if (!read && !ref) return fail('no durable repo to reconcile against')

    try {
      if (read) {
        const bundles = await this.presignRepoBundles(a.projectId, read.manifest)
        const totalBytes = bundles.reduce((n, b) => n + b.bytes, 0)
        const downloadMs = Math.max(this.cfg.hydrateTimeoutMs, this.hydrateBudgetMs(totalBytes))
        await this.callRepoBundlesHydrate(
          a.handle,
          env,
          {
            stagingDir: REPO_RECONCILE_DIR,
            manifest: read.manifest,
            bundles: bundles.map(({ sha256, url }) => ({ sha256, url })),
            timeoutMs: downloadMs,
          },
          downloadMs + this.repoHydratedSlackMs,
        )
      } else if (ref) {
        await this.applyArchive(a.handle, env, ref, `${a.projectId} reconcile repo`, REPO_RECONCILE_DIR)
      }

      const res = await fetch(`${a.handle.agentUrl}/pool/repo-reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(a.runtimeToken ? { Authorization: `Bearer ${a.runtimeToken}` } : {}) },
        body: JSON.stringify({ stagingDir: REPO_RECONCILE_DIR, timeoutMs: this.cfg.hydrateTimeoutMs }),
        signal: AbortSignal.timeout(this.cfg.hydrateTimeoutMs + this.repoHydratedSlackMs),
      })
      if (res.status === 404) return fail('guest has no reconcile route')
      if (!res.ok) return fail(`guest refused (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`)
      const body = (await res.json().catch(() => ({}))) as { head?: string }

      a.repoUntrustedReason = undefined
      a.repoParentEtag = read?.etag ?? ref?.etag ?? a.repoParentEtag
      a.repoLinked = true
      a.repoHealFailures = 0
      a.repoHealRetryAt = undefined
      a.repoHeadSha = body.head ?? a.repoHeadSha
      a.repoExportedHeadSha = undefined
      a.repoExportSha = undefined
      this.writeLive(a)
      metrics.inc(M.repoHealed)
      console.log(
        `[pool] healed UNTRUSTED ${a.projectId}: live history re-attached to the durable repo at ` +
          `${body.head?.slice(0, 12) ?? 'unknown'} — normal saves resume`,
      )
      return true
    } catch (err: any) {
      return fail(err?.message ?? String(err))
    }
  }

  /**
   * Whether a cold boot would restore this VM's current HEAD.
   *
   * The one predicate every "stop this VM" path consults (SHO-442): not
   * untrusted, no hydrate in flight, and the durable repo holds the HEAD the
   * guest last reported. A quarantine copy does NOT count — a cold boot
   * restores the durable copy, not `conflict/`.
   */
  repoDurable(a: AssignedVm): boolean {
    // Nothing to lose: the guest reports no commits at all, so its files are
    // the source backup's already. This holds whatever the lineage says — an
    // untrusted VM that never made a commit is not a risk to stop.
    if (!a.repoHeadSha) return true
    // A restore still in flight is not a distrust: the guest is serving the
    // SOURCE's `.git` while the durable history downloads. Commits are
    // suppressed while it runs (`checkpointGuest` is a no-op) and the working
    // tree is already in the source backup, so a cold boot starts from exactly
    // the same place. Refusing instead would pin a VM whose download never
    // finishes (SHO-442).
    if (this.repoRestoring(a)) return true
    if (a.repoUntrustedReason) return false
    return a.repoExportedHeadSha === a.repoHeadSha
  }

  /** The assign-time restore has not landed yet; see `repoDurable`. */
  private repoRestoring(a: AssignedVm): boolean {
    return a.repoHydratePending === true && a.repoUntrustedReason === REPO_DEFERRED_REASON
  }

  /** Seconds since this VM's HEAD last reached the durable repo (0 when durable). */
  private repoUnsavedSeconds(a: AssignedVm, now = Date.now()): number {
    if (this.repoDurable(a)) return 0
    return Math.max(0, Math.round((now - (a.repoLastSavedAt ?? a.assignedAt)) / 1000))
  }

  /**
   * What the UI and the alert need to know about this VM's git durability
   * (SHO-442). `saving-failing` is the state the incident sat in for a day and
   * a half with nothing showing it.
   */
  private durabilityOf(a: AssignedVm): ProjectDurability {
    const lastSavedAt = a.repoLastSavedAt
    const untrusted = a.repoUntrustedReason && !this.repoRestoring(a) ? a.repoUntrustedReason : undefined
    if (untrusted) {
      return {
        state: 'untrusted',
        since: lastSavedAt ?? a.assignedAt,
        ...(lastSavedAt ? { lastSavedAt } : {}),
        reason: untrusted,
      }
    }
    if (!this.repoDurable(a)) {
      return {
        state: 'saving-failing',
        since: lastSavedAt ?? a.assignedAt,
        ...(lastSavedAt ? { lastSavedAt } : {}),
        reason: 'latest changes not saved yet',
      }
    }
    return { state: 'ok', since: lastSavedAt ?? a.assignedAt, ...(lastSavedAt ? { lastSavedAt } : {}) }
  }

  /**
   * Refuse to stop a VM whose current HEAD is not in the durable repo. The VM
   * keeps running (on the old image if needed) and the next sweep retries —
   * never a cold start over unsaved work.
   */
  private refuseUndurable(a: AssignedVm, action: string): void {
    metrics.inc(M.repoDurabilityRefused)
    console.error(
      `[pool] REFUSED to ${action} ${a.projectId}: its current HEAD is not in the durable repo ` +
        `(untrusted=${a.repoUntrustedReason ?? 'no'}, head=${a.repoHeadSha?.slice(0, 12) ?? 'unknown'}, ` +
        `exported=${a.repoExportedHeadSha?.slice(0, 12) ?? 'none'}). Keeping it running; the next sweep retries.`,
    )
  }

  /**
   * Upload `.git` bytes under the lineage guard. `written` = the durable repo
   * now holds them; `quarantined` = diverted to a conflict key (still durable,
   * needs a human); `lost` = nowhere durable. `rootCommitAt` is when the
   * exported history began, or null when the guest did not say.
   */
  private async storeRepoBytes(
    a: AssignedVm,
    bytes: RepoBody,
    rootCommitAt: number | null,
  ): Promise<'written' | 'quarantined' | 'lost'> {
    if (publishedSourceId(a.projectId)) return 'written'
    const outcome = await this.uploadRepoGuarded(a.projectId, bytes, {
      quarantine: this.quarantineFor(a),
      lineage: this.repoLineageOf(a),
      preserveOnRefusal: true,
    })
    switch (outcome.status) {
      case 'created':
      case 'written':
        a.repoParentEtag = outcome.etag ?? a.repoParentEtag
        this.writeLive(a)
        console.log(
          `[pool] saved repo archive for ${a.projectId} (${repoBodySize(bytes)} bytes, ${outcome.status}, etag=${outcome.etag ?? 'none'})`,
        )
        return 'written'
      case 'conflict':
        if (!a.repoParentEtag && !a.repoLinked && (await this.promoteUnlinkedRepo(a, bytes, rootCommitAt))) {
          return 'written'
        }
        metrics.inc(M.repoConflict)
        if (outcome.quarantineKey) a.repoQuarantineKey = outcome.quarantineKey
        console.error(
          `[pool] REFUSED to overwrite repo.git.tar.gz for ${a.projectId} — lineage ` +
            `(etag=${a.repoParentEtag ?? 'none'}) does not match. Quarantined at ${outcome.quarantineKey}.`,
        )
        return outcome.quarantineKey ? 'quarantined' : 'lost'
      case 'refused':
        metrics.inc(M.repoRefused)
        if (outcome.quarantineKey) a.repoQuarantineKey = outcome.quarantineKey
        return outcome.quarantineKey ? 'quarantined' : 'lost'
      case 'too-large':
        metrics.inc(M.repoTooLarge)
        console.error(
          `[pool] repo archive for ${a.projectId} is too large (${outcome.bytes} > ${outcome.limit}) — not persisted`,
        )
        return 'lost'
      case 'skipped':
        return 'lost'
    }
    return 'lost'
  }

  /**
   * A create-only VM whose export hit an existing durable repo. That repo is
   * only stale (not someone else's live work) when nothing wrote it after this
   * VM's workspace became its own — the case for workspace runtimes that ran
   * before they hydrated `.git`, whose exports were otherwise refused forever.
   * Then this VM's `.git` supersedes it, with the old archive kept under
   * `conflict/`. Any later write means another VM is live and the conflict
   * stands.
   *
   * Never when this VM's history began on this boot (or its start is unknown):
   * that `.git` was seeded from whatever the workspace held at boot, and
   * superseding with it discards the durable history it never contained.
   */
  private async promoteUnlinkedRepo(a: AssignedVm, bytes: RepoBody, rootCommitAt: number | null): Promise<boolean> {
    return this.promoteUnlinkedWith(a, rootCommitAt, {
      preserve: () => this.preserveDurableRepo(a.projectId),
      write: (lineage) => this.uploadRepoGuarded(a.projectId, bytes, { lineage, quarantine: this.quarantineFor(a) }),
    })
  }

  /** Same supersede rules for either format; `io` supplies the store operations. */
  private async promoteUnlinkedWith(
    a: AssignedVm,
    rootCommitAt: number | null,
    io: {
      preserve: () => Promise<string | null>
      write: (lineage: RepoLineage) => Promise<RepoWriteOutcome>
    },
  ): Promise<boolean> {
    const since = a.stateSince ?? a.assignedAt
    if (rootCommitAt === null || rootCommitAt >= since - REPO_BORN_ON_BOOT_SLACK_MS) {
      console.warn(
        `[pool] not promoting unlinked repo for ${a.projectId}: its history ` +
          (rootCommitAt === null
            ? 'start is unknown'
            : `began ${new Date(rootCommitAt).toISOString()}, on this VM's boot (${new Date(since).toISOString()})`),
      )
      return false
    }
    let current: { etag: string | null; lastModified: number | null } | null
    try {
      current = await this.statDurableRepo(a.projectId)
    } catch {
      return false
    }
    if (!current?.etag || current.lastModified === null || current.lastModified >= since) return false

    const preservedKey = await io.preserve().catch(() => null)
    if (!preservedKey) return false
    const outcome = await io.write({ kind: 'descends', etag: current.etag })
    if (outcome.status !== 'written' && outcome.status !== 'created') return false

    metrics.inc(M.repoPromoted)
    a.repoParentEtag = outcome.etag ?? current.etag
    this.writeLive(a)
    console.log(
      `[pool] promoted unlinked repo for ${a.projectId} over etag=${current.etag} ` +
        `(last written ${new Date(current.lastModified).toISOString()}, before this VM's state began ` +
        `${new Date(since).toISOString()}); previous archive kept at ${preservedKey}`,
    )
    return true
  }

  /**
   * The incremental writer. Returns null when the legacy tarball path should
   * run instead: no manifest exists yet and the guest cannot read or write
   * bundles, or cannot push the LFS objects a bundle would leave out. A
   * project with a manifest never falls back.
   */
  private async storeRepoBundles(a: AssignedVm): Promise<RepoPersist | null> {
    const current = await this.repoManifest(a.projectId)
    if (!current && !(await this.guestHasRepoBundles(a))) return null
    // Past the compaction threshold the export is a full base, which restarts the chain.
    const compact = !!current && needsCompaction(current.manifest.bundles)
    const since = current && !compact ? Object.values(current.manifest.refs) : null
    let exported: RepoBundleExport | null
    try {
      exported = await this.exportRepoBundle(a, since)
    } catch (err) {
      // A push still running is a retry, never a fallback: the tarball path
      // would re-run the same push and time out again (SHO-442).
      if (err instanceof RepoBundleLfsPendingError) throw err
      // The tarball still carries `.git/lfs/objects`; a bundle cannot, so the
      // project stays unmigrated until its LFS push succeeds.
      if (!current && err instanceof RepoBundleLfsPushError) {
        metrics.inc(M.repoBundleLfsFallback)
        console.warn(`[pool] keeping ${a.projectId} on the repo tarball: ${err.message}`)
        return null
      }
      throw err
    }
    if (!exported) {
      if (current) {
        throw new Error(`guest cannot export incremental repo for ${a.projectId}; refusing the tarball fallback`)
      }
      return null
    }
    if (exported.bundle) await this.publishRepoBundle(a, exported.bundle)
    if (compact && exported.bundle?.kind === 'base') metrics.inc(M.repoBundleCompactions)
    const bundles = nextBundleChain(current?.manifest.bundles ?? null, exported.bundle)
    if (bundles.length === 0) return 'empty'
    if (exported.lfsMissing?.length) {
      metrics.inc(M.repoLfsMissing, exported.lfsMissing.length)
      console.error(
        `[pool] ${a.projectId}: ${exported.lfsMissing.length} LFS object(s) are missing on both sides — ` +
          `history exported, content lost: ${exported.lfsMissing.flatMap((m) => m.paths).slice(0, 10).join(', ')}`,
      )
    }
    const next = parseRepoManifest({
      v: 1,
      head: exported.head,
      refs: exported.refs,
      config: exported.config,
      rootCommitAt: exported.rootCommitAt,
      bundles,
      ...(exported.lfsMissing?.length ? { lfsMissing: exported.lfsMissing } : {}),
    })
    if (current && sameManifestState(current.manifest, next)) return 'unchanged'
    return this.writeRepoManifest(a, next)
  }

  /**
   * Ask the guest for the next bundle. `since` holds the tips the manifest
   * records; null asks for a full base.
   */
  /**
   * Whether this VM's guest advertises bundle support in the repo-hydrated
   * probe. Only a capable guest may migrate a project, since every later
   * restore of that project needs the same capability. A failed probe is not
   * cached, so it is retried on the next save.
   */
  protected async guestHasRepoBundles(a: AssignedVm): Promise<boolean> {
    const known = this.repoBundleCapable.get(a)
    if (known !== undefined) return known
    let capable: boolean
    try {
      const env: Record<string, string> = a.runtimeToken ? { RUNTIME_AUTH_SECRET: a.runtimeToken } : {}
      const probe = await this.callRepoHydrated(a.handle, env, { probe: true }, Math.min(this.cfg.hydrateTimeoutMs, 10_000))
      capable = probe?.bundles === true
    } catch (err: any) {
      console.warn(`[pool] repo bundle probe failed for ${a.projectId}: ${err?.message ?? err}`)
      return false
    }
    this.repoBundleCapable.set(a, capable)
    return capable
  }

  protected async exportRepoBundle(a: AssignedVm, since: string[] | null): Promise<RepoBundleExport | null> {
    const res = await fetch(`${a.handle.agentUrl}/pool/export-repo-bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(a.runtimeToken ? { Authorization: `Bearer ${a.runtimeToken}` } : {}) },
      body: JSON.stringify(since ? { since } : { full: true }),
      signal: AbortSignal.timeout(this.cfg.hydrateTimeoutMs),
    })
    if (res.status === 404) return null
    // 202: the guest's LFS push is still running. The next sweep joins the same
    // job, so this is a retry, not a failure — and never a tarball fallback.
    if (res.status === 202) {
      const body = (await res.json().catch(() => ({}))) as { pushedOids?: number; totalOids?: number }
      metrics.inc(M.repoBundleLfsPending)
      throw new RepoBundleLfsPendingError(
        `lfs push still running for ${a.projectId} (${body.pushedOids ?? 0}/${body.totalOids ?? '?'} objects)`,
      )
    }
    if (!res.ok) {
      const text = await res.text()
      const message = `/pool/export-repo-bundle failed (${res.status}): ${text}`
      if (isRepoCorrupt(text)) throw new RepoCorruptError(message)
      if (res.status === 503 && isLfsPushFailure(text)) throw new RepoBundleLfsPushError(message)
      throw new Error(message)
    }
    return (await res.json()) as RepoBundleExport
  }

  /**
   * Fetch one bundle from the guest, check it against what the export promised,
   * and store it. It goes up before the manifest that references it, so a
   * failed manifest write leaves only an unreferenced bundle for GC.
   */
  private async publishRepoBundle(a: AssignedVm, entry: RepoManifestBundle): Promise<void> {
    const path = this.exportSpoolPath(a.handle.id, 'bundle')
    const dl = exportDeadline(this.cfg.hydrateTimeoutMs)
    try {
      const res = await fetch(`${a.handle.agentUrl}/pool/export-repo-bundle/${entry.sha256}`, {
        headers: a.runtimeToken ? { Authorization: `Bearer ${a.runtimeToken}` } : {},
        signal: dl.signal,
      })
      if (!res.ok) throw new Error(`bundle ${entry.sha256} download failed (${res.status})`)
      const spooled = await spoolResponse(res, path, REPO_MAX_BYTES)
      if (spooled.sha256 !== entry.sha256 || spooled.size !== entry.bytes) {
        throw new Error(`bundle ${entry.sha256} did not match its export (${spooled.size} bytes)`)
      }
      await this.uploadRepoBundleGuarded(a.projectId, entry, Bun.file(path))
      metrics.inc(M.repoBundleBytes, entry.bytes)
      if (entry.kind === 'base') metrics.inc(M.repoBundleFull)
    } catch (err) {
      dl.abort(err)
      throw err
    } finally {
      dl.dispose()
      rmSync(path, { force: true })
    }
  }

  protected uploadRepoBundleGuarded(projectId: string, entry: RepoManifestBundle, body: ReturnType<typeof Bun.file>) {
    return uploadRepoBundle(projectId, entry, body, this.cfg)
  }

  private async writeRepoManifest(a: AssignedVm, manifest: RepoManifest): Promise<RepoPersist> {
    const outcome = await this.uploadManifestGuarded(a.projectId, manifest, {
      quarantine: this.quarantineFor(a),
      lineage: this.repoLineageOf(a),
      preserveOnRefusal: true,
    })
    switch (outcome.status) {
      case 'created':
      case 'written':
        a.repoParentEtag = outcome.etag ?? a.repoParentEtag
        this.writeLive(a)
        console.log(
          `[pool] saved repo manifest for ${a.projectId} (${manifest.bundles.length} bundle(s), ${outcome.status}, etag=${outcome.etag ?? 'none'})`,
        )
        this.scheduleRepoBundleSweep(a.projectId)
        return 'written'
      case 'conflict':
        if (!a.repoParentEtag && !a.repoLinked && (await this.promoteUnlinkedManifest(a, manifest))) {
          return 'written'
        }
        metrics.inc(M.repoManifestConflict)
        console.error(
          `[pool] REFUSED to overwrite repo manifest for ${a.projectId} — lineage ` +
            `(etag=${a.repoParentEtag ?? 'none'}) does not match. Quarantined at ${outcome.quarantineKey}.`,
        )
        return outcome.quarantineKey ? 'quarantined' : 'lost'
      case 'refused':
        metrics.inc(M.repoRefused)
        return outcome.quarantineKey ? 'quarantined' : 'lost'
      case 'too-large':
        metrics.inc(M.repoTooLarge)
        return 'lost'
      case 'skipped':
        return 'lost'
    }
    return 'lost'
  }

  /**
   * Sweep a project's unreferenced bundles, at most once per interval. It runs
   * in the background and never blocks an export. Retired bundles are removed
   * only after the grace period, so the timing is not critical.
   */
  protected scheduleRepoBundleSweep(projectId: string, now = Date.now()): void {
    if (now - (this.repoBundleSweptAt.get(projectId) ?? 0) < REPO_BUNDLE_SWEEP_INTERVAL_MS) return
    this.repoBundleSweptAt.set(projectId, now)
    sweepRepoBundles(projectId, this.cfg, now, REPO_BUNDLE_GRACE_MS)
      .then((r) => {
        if (r?.deleted) metrics.inc(M.repoBundlesGced, r.deleted)
      })
      .catch((err: any) => console.warn(`[pool] repo bundle sweep failed for ${projectId}:`, err?.message ?? err))
  }

  /** Last sweep per project, so a busy writer does not list the bucket on every save. */
  private repoBundleSweptAt = new Map<string, number>()
  private repoBundleCapable = new WeakMap<AssignedVm, boolean>()

  private promoteUnlinkedManifest(a: AssignedVm, manifest: RepoManifest): Promise<boolean> {
    return this.promoteUnlinkedWith(a, manifest.rootCommitAt, {
      preserve: () => this.preserveDurableManifest(a.projectId),
      write: (lineage) =>
        this.uploadManifestGuarded(a.projectId, manifest, { lineage, quarantine: this.quarantineFor(a) }),
    })
  }

  protected uploadManifestGuarded(
    projectId: string,
    manifest: RepoManifest,
    opts: { lineage: RepoLineage; preserveOnRefusal?: boolean; quarantine?: QuarantineBookkeeping },
  ): Promise<RepoWriteOutcome> {
    return uploadRepoManifestGuarded(projectId, manifest, opts, this.cfg)
  }

  protected preserveDurableManifest(projectId: string): Promise<string | null> {
    return preserveRepoManifest(projectId, this.cfg)
  }

  protected statDurableRepo(projectId: string): Promise<{ etag: string | null; lastModified: number | null } | null> {
    return statRepoArchive(projectId, this.cfg)
  }

  protected preserveDurableRepo(projectId: string): Promise<string | null> {
    return preserveRepoArchive(projectId, this.cfg)
  }

  /**
   * `sourceTimes` maps each top-level path the source hydrate just wrote
   * (`'.'` for a single project, member ids for a workspace runtime) to when
   * its durable backup was last written. Those newer than the durable repo are
   * kept as they are: the repo stops advancing whenever its exports are
   * refused, and resetting to its HEAD would rewind the newer source.
   *
   * Throws {@link RepoAdoptUncertainError} when the guest may have rewritten
   * the tree without the host seeing the result; any other throw leaves the
   * tree as the source hydrate left it.
   */
  private async hydrateRepo(
    projectId: string,
    handle: FcVmHandle,
    env: Record<string, string>,
    sourceTimes: Record<string, number | null> = {},
  ): Promise<{ hydrated: boolean; parentEtag?: string; keptPaths?: string[] }> {
    const stage = await this.prepareRepoStage(projectId, handle, env, sourceTimes)
    if (stage.kind === 'none') return { hydrated: false }
    if (stage.kind === 'applied') return { hydrated: true, parentEtag: stage.parentEtag }
    await stage.download
    return this.adoptRepoStage(projectId, handle, env, stage)
  }

  /**
   * Everything before the swap: read the durable lineage, probe the guest and
   * START the download into the staging dir (returned as `download`, not
   * awaited). Staging never touches the live tree, which is what lets an open
   * stop waiting for it.
   */
  private async prepareRepoStage(
    projectId: string,
    handle: FcVmHandle,
    env: Record<string, string>,
    sourceTimes: Record<string, number | null>,
  ): Promise<RepoStage> {
    // A manifest is authoritative once it exists, so the tarball is never read then.
    const read = await this.repoManifest(projectId)
    if (read) return this.prepareRepoStageFromBundles(projectId, handle, env, read, sourceTimes)
    const ref = await this.repoRef(projectId)
    if (!ref) {
      console.log(`[pool] no durable repo for ${projectId} — guest keeps its seeded .git`)
      return { kind: 'none' }
    }
    // Stage, then have the guest swap `.git` in and reset the tree to HEAD.
    // Overlaying straight onto the live `.git` leaves a template seed commit
    // as HEAD when the durable repo is older or empty, and never rebuilds the
    // working tree, so the (older) source archive would be committed as a revert.
    const probe = await this.callRepoHydrated(handle, env, { probe: true })
    if (!probe) {
      console.log(`[pool] guest has no /pool/repo-hydrated — overlaying ${projectId} repo the legacy way`)
      await this.applyArchive(handle, env, ref, `${projectId} repo`)
      console.log(`[pool] hydrated .git for ${projectId} (${ref.bytes} bytes, etag=${ref.etag ?? 'none'})`)
      return { kind: 'applied', parentEtag: ref.etag ?? undefined, bytes: ref.bytes }
    }

    const keepPaths = repoKeepPaths(sourceTimes, ref.lastModified ?? null)
    if (keepPaths.length && probe.deadline !== true) {
      throw new Error(
        `durable repo is older than the source of ${keepPaths.join(', ')} and this guest cannot keep ` +
          `paths out of the reset — leaving the tree as hydrated`,
      )
    }
    return {
      kind: 'staging',
      parentEtag: ref.etag ?? undefined,
      keepPaths,
      bytes: ref.bytes,
      bundles: 0,
      canDefer: probe.ifIdle === true,
      describe: `(${ref.bytes} bytes, etag=${ref.etag ?? 'none'}`,
      download: this.applyArchive(handle, env, ref, `${projectId} repo`, REPO_STAGING_DIR),
    }
  }

  /**
   * Restore from the incremental format: the guest downloads and verifies each
   * bundle into the staging dir, then adopts it like a tarball. A guest without
   * the capability is refused, not handed the stale tarball.
   */
  private async prepareRepoStageFromBundles(
    projectId: string,
    handle: FcVmHandle,
    env: Record<string, string>,
    read: RepoManifestRead,
    sourceTimes: Record<string, number | null>,
  ): Promise<RepoStage> {
    const probe = await this.callRepoHydrated(handle, env, { probe: true })
    if (probe?.bundles !== true) {
      throw new Error(
        `guest cannot restore incremental repo bundles for ${projectId}; refusing to restore a stale tarball`,
      )
    }
    const keepPaths = repoKeepPaths(sourceTimes, read.lastModified)
    if (keepPaths.length && probe.deadline !== true) {
      throw new Error(
        `durable repo is older than the source of ${keepPaths.join(', ')} and this guest cannot keep ` +
          `paths out of the reset — leaving the tree as hydrated`,
      )
    }
    const bundles = await this.presignRepoBundles(projectId, read.manifest)
    const totalBytes = bundles.reduce((n, b) => n + b.bytes, 0)
    const downloadMs = Math.max(this.cfg.hydrateTimeoutMs, this.hydrateBudgetMs(totalBytes))
    // Staging only: a failure here leaves the live tree exactly as it was.
    const download = this.callRepoBundlesHydrate(
      handle,
      env,
      {
        stagingDir: REPO_STAGING_DIR,
        manifest: read.manifest,
        bundles: bundles.map(({ sha256, url }) => ({ sha256, url })),
        timeoutMs: downloadMs,
      },
      downloadMs + this.repoHydratedSlackMs,
    )
    return {
      kind: 'staging',
      parentEtag: read.etag ?? undefined,
      keepPaths,
      bytes: totalBytes,
      bundles: bundles.length,
      canDefer: probe.ifIdle === true,
      describe: `from ${bundles.length} bundle(s) (${totalBytes} bytes, manifest etag=${read.etag ?? 'none'}`,
      download,
    }
  }

  /** Swap a fully downloaded stage in. `ifIdle`: the guest refuses (409) once the workspace has been used. */
  private async adoptRepoStage(
    projectId: string,
    handle: FcVmHandle,
    env: Record<string, string>,
    stage: Extract<RepoStage, { kind: 'staging' }>,
    opts: { ifIdle?: boolean } = {},
  ): Promise<{ hydrated: boolean; parentEtag?: string; keptPaths?: string[] }> {
    const { keepPaths } = stage
    await this.adoptStagedRepo(handle, env, keepPaths, opts)
    console.log(
      `[pool] hydrated .git for ${projectId} ${stage.describe}` +
        `${keepPaths.length ? `, kept newer source at ${keepPaths.join(', ')}` : ''})`,
    )
    return { hydrated: true, parentEtag: stage.parentEtag, keptPaths: keepPaths }
  }

  /**
   * The assign-time repo restore, bounded by `repoForegroundMs`.
   *
   * Source, data and home are already in place, so the guest can serve on the
   * source's own `.git`. If the history download is still running when the
   * budget runs out, the open returns now and {@link finishRepoDeferred} swaps
   * the history in afterwards, but only while nobody has used the workspace
   * (the guest enforces that; see `ifIdle` on /pool/repo-hydrated). A guest
   * that cannot enforce it is waited for, exactly as before.
   */
  private async hydrateRepoAtAssign(
    a: AssignedVm,
    handle: FcVmHandle,
    env: Record<string, string>,
    sourceTimes: Record<string, number | null>,
  ): Promise<{ hydrated: boolean; parentEtag?: string } | 'deferred'> {
    const t0 = performance.now()
    let outcome: RepoRestoreInfo['mode'] = 'failed'
    let bytes = 0
    let bundles = 0
    try {
      const stage = await this.prepareRepoStage(a.projectId, handle, env, sourceTimes)
      if (stage.kind !== 'none') bytes = stage.bytes
      if (stage.kind === 'staging') bundles = stage.bundles
      if (stage.kind === 'none') {
        outcome = 'none'
        return { hydrated: false }
      }
      if (stage.kind === 'applied') {
        metrics.inc(M.repoHydrateBytes, stage.bytes)
        outcome = 'foreground'
        return { hydrated: true, parentEtag: stage.parentEtag }
      }
      metrics.inc(M.repoHydrateBytes, stage.bytes)
      metrics.inc(M.repoHydrateBundles, stage.bundles)
      const budget = this.cfg.repoForegroundMs
      if (stage.canDefer && budget > 0) {
        const finished = await settlesWithin(stage.download, budget)
        if (!finished) {
          outcome = 'deferred'
          this.deferRepoHydrate(a, handle, env, stage, t0)
          return 'deferred'
        }
      }
      await stage.download
      const r = await this.adoptRepoStage(a.projectId, handle, env, stage)
      outcome = 'foreground'
      return r
    } finally {
      const ms = Math.round(performance.now() - t0)
      a.repoRestore = { mode: outcome, bytes, bundles, foregroundMs: ms }
      metrics.inc(`${M.repoHydrate}{outcome="${outcome}"}`)
      if (outcome !== 'deferred') metrics.inc(M.repoHydrateMs, ms)
    }
  }

  private deferRepoHydrate(
    a: AssignedVm,
    handle: FcVmHandle,
    env: Record<string, string>,
    stage: Extract<RepoStage, { kind: 'staging' }>,
    t0: number,
  ): void {
    // Persisted, so an agent restart mid-download leaves the VM untrusted for
    // repo writes (today's failure state) rather than linked to a lineage its
    // `.git` never adopted. Cleared once the swap lands.
    a.repoUntrustedReason = REPO_DEFERRED_REASON
    this.writeLive(a)
    console.warn(
      `[pool] repo hydrate for ${a.projectId} still downloading after ${this.cfg.repoForegroundMs}ms ` +
        `${stage.describe}) — serving the source's .git now, finishing in the background`,
    )
    void this.finishRepoDeferred(a, handle, env, stage, t0)
  }

  private async finishRepoDeferred(
    a: AssignedVm,
    handle: FcVmHandle,
    env: Record<string, string>,
    stage: Extract<RepoStage, { kind: 'staging' }>,
    t0: number,
  ): Promise<void> {
    let outcome: 'adopted' | 'busy' | 'failed' | 'abandoned' = 'failed'
    try {
      await stage.download
      if (this.assigned.get(a.projectId) !== a) {
        outcome = 'abandoned'
        return
      }
      const r = await this.adoptRepoStage(a.projectId, handle, env, stage, { ifIdle: true })
      if (a.repoUntrustedReason === REPO_DEFERRED_REASON) a.repoUntrustedReason = undefined
      a.repoParentEtag = r.parentEtag
      if (r.hydrated && a.projectId.startsWith('ws:')) a.workspaceOrigin = 'backup'
      a.repoLinked = true
      outcome = 'adopted'
    } catch (err: any) {
      if (this.assigned.get(a.projectId) !== a) {
        outcome = 'abandoned'
        return
      }
      const busy = err instanceof RepoHydrateRefusedError && err.status === 409
      outcome = busy ? 'busy' : 'failed'
      const reason = busy
        ? 'repo hydrate finished after the workspace was in use — kept the source .git'
        : `repo hydrate failed in the background (${err?.message ?? err})`
      this.distrustRepo(a, reason)
      if (err instanceof RepoAdoptUncertainError) this.distrustSource(a, reason)
      console.error(
        `[pool] deferred repo hydrate for ${a.projectId} ${busy ? 'not adopted' : 'failed'} — this VM stays ` +
          `UNTRUSTED for repo.git and will NOT overwrite it:`,
        busy ? reason : (err?.message ?? err),
      )
    } finally {
      const ms = Math.round(performance.now() - t0)
      metrics.inc(`${M.repoHydrateDeferred}{outcome="${outcome}"}`)
      metrics.inc(M.repoHydrateMs, ms)
      a.repoHydratePending = false
      a.repoHeadSha = undefined
      a.repoExportedHeadSha = undefined
      a.repoExportSha = undefined
      if (this.assigned.get(a.projectId) === a) this.writeLive(a)
      console.log(`[pool] deferred repo hydrate for ${a.projectId}: ${outcome} after ${ms}ms`)
    }
  }

  /** Swap the staged `.git` in and reset the tree. Past the deadline the guest declines. */
  private async adoptStagedRepo(
    handle: FcVmHandle,
    env: Record<string, string>,
    keepPaths: string[],
    opts: { ifIdle?: boolean } = {},
  ): Promise<void> {
    const timeoutMs = this.cfg.hydrateTimeoutMs
    try {
      await this.callRepoHydrated(
        handle,
        env,
        {
          stagingDir: REPO_STAGING_DIR,
          timeoutMs,
          ...(keepPaths.length ? { keepPaths } : {}),
          ...(opts.ifIdle ? { ifIdle: true } : {}),
        },
        timeoutMs + this.repoHydratedSlackMs,
      )
    } catch (err: any) {
      if (err instanceof RepoHydrateRefusedError) throw err
      throw new RepoAdoptUncertainError(
        `guest did not answer /pool/repo-hydrated (${err?.message ?? err}); it may still reset the tree`,
      )
    }
  }

  /** Presigned GETs for each bundle of the manifest, in chain order. */
  protected presignRepoBundles(projectId: string, manifest: RepoManifestRead['manifest']) {
    return describeRepoBundles(projectId, manifest, this.cfg, PRESIGN_TTL_SEC)
  }

  /** The project's incremental manifest, or null when it has none. */
  protected repoManifest(projectId: string): Promise<RepoManifestRead | null> {
    return fetchRepoManifest(projectId, this.cfg)
  }

  /**
   * Lineage stamp for the repo: the manifest's ETag once one exists, else the
   * tarball's. Snapshot drift compares against this.
   */
  protected async repoStampRef(projectId: string): Promise<ArchiveRef | null> {
    const read = await this.repoManifest(projectId)
    if (read) {
      return {
        etag: read.etag,
        bytes: 0,
        lastModified: read.lastModified,
        url: null,
        load: async () => {
          throw new Error('the repo manifest is a lineage stamp, not restorable bytes')
        },
      }
    }
    return this.repoRef(projectId)
  }

  /** Stage a restored repo in the guest, verified bundle by bundle. */
  protected async callRepoBundlesHydrate(
    handle: FcVmHandle,
    env: Record<string, string>,
    body: {
      stagingDir: string
      manifest: RepoManifestRead['manifest']
      bundles: Array<{ sha256: string; url: string }>
      timeoutMs: number
    },
    waitMs: number,
  ): Promise<void> {
    const token = env.RUNTIME_AUTH_SECRET
    const res = await fetch(`${handle.agentUrl}/pool/repo-bundles-hydrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(waitMs),
    })
    if (!res.ok) throw new Error(`/pool/repo-bundles-hydrate failed (${res.status}): ${await res.text()}`)
  }

  /**
   * Returns null when the guest predates `/pool/repo-hydrated` (404), else its
   * JSON answer. Throws {@link RepoHydrateRefusedError} when the guest answered
   * with an error; network errors and timeouts propagate as they are.
   */
  protected async callRepoHydrated(
    handle: FcVmHandle,
    env: Record<string, string>,
    body: { probe: true } | { stagingDir: string; timeoutMs?: number; keepPaths?: string[]; ifIdle?: boolean },
    waitMs: number = this.cfg.hydrateTimeoutMs,
  ): Promise<{ deadline?: boolean; bundles?: boolean; ifIdle?: boolean; reconcile?: boolean } | null> {
    const token = env.RUNTIME_AUTH_SECRET
    const res = await fetch(`${handle.agentUrl}/pool/repo-hydrated`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(waitMs),
    })
    if (res.status === 404) return null
    if (!res.ok) throw new RepoHydrateRefusedError(res.status, await res.text())
    return ((await res.json().catch(() => ({}))) ?? {}) as { deadline?: boolean; bundles?: boolean; ifIdle?: boolean; reconcile?: boolean }
  }

  protected repoRef(projectId: string): Promise<ArchiveRef | null> {
    return describeRepoArchive(projectId, this.cfg, PRESIGN_TTL_SEC)
  }

  /**
   * Export `.git` for every live VM whose HEAD has moved, or whose last export
   * is missing. Driven by the same guarded interval as writable-state so a
   * host that never suspends still persists git_only history.
   *
   * A HEAD the guest reported that is already durable is skipped: re-exporting
   * an unchanged multi-GB repo every interval is what starved the agent's
   * event loop. A guest that reports no HEAD is exported every time. Failures
   * back off so a repo that cannot export is not retried every interval.
   */
  async exportAllRepos(now = Date.now()): Promise<number> {
    let n = 0
    for (const a of this.assigned.values()) {
      // An untrusted VM cannot write the durable repo, but it must still save:
      // its `.git` goes to `conflict/` on every HEAD change, and the reconcile
      // below tries to heal it back to a normal writer (SHO-442). A restore
      // still in flight is skipped: its `.git` is the source's, so there is
      // nothing new to copy yet.
      if (a.repoUntrustedReason && !this.repoRestoring(a)) {
        if (a.repoHeadSha && a.repoHeadSha !== a.repoQuarantinedHeadSha) {
          if (await this.quarantineRepo(a)) n++
        }
        await this.healUntrustedRepo(a)
        continue
      }
      if (a.repoAbsent) continue
      if (a.repoHeadSha && a.repoHeadSha === a.repoExportedHeadSha) continue
      if (a.repoExportRetryAt && now < a.repoExportRetryAt) continue
      try {
        const wrote = await this.saveRepoToStore(a)
        if (wrote) n++
        a.repoExportFailures = 0
        a.repoExportRetryAt = undefined
      } catch (err: any) {
        const failures = (a.repoExportFailures ?? 0) + 1
        a.repoExportFailures = failures
        a.repoExportRetryAt =
          now + Math.min(REPO_EXPORT_MAX_BACKOFF_MS, REPO_EXPORT_MIN_BACKOFF_MS * 2 ** (failures - 1))
        console.error(
          `[pool] repo export failed for ${a.projectId} (attempt ${failures}, next ` +
            `${new Date(a.repoExportRetryAt).toISOString()}):`,
          err?.message ?? err,
        )
      }
    }
    return n
  }

  /**
   * The data ETag safe to freeze into a snapshot — none for an untrusted VM.
   *
   * A VM distrusted after a failed precondition still holds the ETag it used
   * to descend from. Stamping that into a snapshot would let the resumed VM
   * claim a descent its database no longer has, laundering untrusted state
   * back into a writer. A resume with no stamp is merely create-only, which
   * cannot overwrite anything.
   */
  private trustedDataEtag(a: AssignedVm): string | undefined {
    return a.dataUntrustedReason ? undefined : a.dataParentEtag
  }

  /** What a backup target is entitled to do to its durable writable-state archive. */
  private dataLineageFor(state: MemberDataState): DataLineage {
    if (state.untrustedReason) return { kind: 'untrusted', reason: state.untrustedReason }
    if (state.parentEtag) return { kind: 'descends', etag: state.parentEtag }
    return { kind: 'create-only' }
  }

  /**
   * Mark a VM's database provenance as bad, so its exports stop reaching the
   * durable archive. Sticky for the life of the assignment: once we cannot
   * prove what this database descends from, no later export makes it provable.
   */
  private distrustData(a: AssignedVm, reason: string): void {
    if (a.dataUntrustedReason === reason) return
    a.dataUntrustedReason = reason
    this.writeLive(a)
  }

  /**
   * Record a failed writable-state export on the VM, so a database nobody can
   * snapshot is VISIBLE instead of being one 500 line among hundreds.
   *
   * Only a named snapshot failure gets an entry, and only the first one of a
   * streak raises the alert: a guest that keeps failing is retried on its
   * backoff and every retry is already logged, but the fleet-wide signal (the
   * gauge, the journal line naming the project and the SQLite message) fires
   * once per streak. Otherwise a VM stuck for four days would page every ten
   * minutes (SHO-541).
   */
  private noteDataExportError(a: AssignedVm, slot: DataSlot, err: any): void {
    if (err?.code !== SQLITE_SNAPSHOT_FAILED) return
    const message = String(err?.message ?? err).slice(0, 500)
    const prev = a.dataSnapshotFailure
    a.dataSnapshotFailure = {
      code: SQLITE_SNAPSHOT_FAILED,
      message,
      since: prev?.since ?? Date.now(),
      attempts: (prev?.attempts ?? 0) + 1,
    }
    this.writeLive(a)
    if (prev) return
    metrics.inc(M.dataSnapshotFailed)
    console.error(
      `[pool] writable-state snapshot FAILED for ${slot.label} (${SQLITE_SNAPSHOT_FAILED}): ${message}. ` +
        `Its database is not being backed up; the exports are retried with backoff.`,
    )
  }

  /**
   * Pull the guest's CURRENT writable state and upload it under the guard.
   *
   * Serialized per project: the periodic exporter and `suspend()` both call
   * this, and two concurrent exports of the same project would each carry the
   * same lineage, so whichever landed second would fail its precondition and
   * discard a perfectly good — and probably fresher — export.
   *
   * `final` marks the last export of an assignment (suspend). It is what
   * decides whether refused bytes are worth quarantining; see
   * `uploadProjectDataGuarded`.
   *
   * Returns true when something was written, false when skipped, unchanged,
   * refused, or there was nothing to persist.
   */
  async saveProjectDataToStore(a: AssignedVm, opts: DataSaveOpts = {}): Promise<boolean> {
    if (publishedSourceId(a.projectId)) return false
    if (a.projectId.startsWith('ws:')) return this.saveWorkspaceMemberDataToStore(a, opts)
    const slot = this.projectDataSlot(a)
    return this.dataFlight.run(slot.flightKey, () => this.saveDataSlotInner(a, slot, opts))
  }

  /**
   * Workspace runtimes: back up each member's writable state to its own
   * `{memberId}/project-data.tar.gz`. The runtime root holds no database —
   * every member's lives in `/app/workspace/<memberId>` — so exporting the root
   * (what the single-project path does) would never persist anything.
   *
   * Members are independent: one failing does not skip the rest. The first
   * error is rethrown afterwards so the periodic exporter's backoff still sees
   * a sick guest.
   */
  async saveWorkspaceMemberDataToStore(a: AssignedVm, opts: DataSaveOpts = {}): Promise<boolean> {
    let wrote = false
    let firstError: unknown
    const own = ownMemberIds(a.projectId)
    for (const memberId of (a.workspaceMemberIds ?? []).filter((id) => own.includes(id))) {
      const slot = this.memberDataSlot(a, memberId)
      try {
        if (await this.dataFlight.run(slot.flightKey, () => this.saveDataSlotInner(a, slot, opts))) wrote = true
      } catch (err: any) {
        firstError ??= err
        console.error(`[pool] writable-state backup failed for workspace member ${memberId}:`, err?.message ?? err)
      }
      if (a.dataExportUnsupported) break
    }
    if (firstError) throw firstError
    return wrote
  }

  private projectDataSlot(a: AssignedVm): DataSlot {
    const state: MemberDataState = {
      parentEtag: a.dataParentEtag,
      untrustedReason: a.dataUntrustedReason,
      lastUploadAt: a.dataLastUploadAt,
      lastBytes: a.dataLastBytes,
      lastDailyCopyDate: a.dataLastDailyCopyDate,
    }
    return {
      storageId: a.projectId,
      flightKey: a.projectId,
      label: a.projectId,
      state,
      commit: () => {
        a.dataParentEtag = state.parentEtag
        a.dataUntrustedReason = state.untrustedReason
        a.dataLastUploadAt = state.lastUploadAt
        a.dataLastBytes = state.lastBytes
        a.dataLastDailyCopyDate = state.lastDailyCopyDate
        this.writeLive(a)
      },
    }
  }

  private memberDataSlot(a: AssignedVm, memberId: string, dir = `/app/workspace/${memberId}`): DataSlot {
    return {
      storageId: memberId,
      flightKey: `${a.projectId}#${memberId}`,
      dir,
      label: `workspace member ${memberId} (${a.projectId})`,
      state: this.memberDataState(a, memberId),
      commit: () => this.writeLive(a),
    }
  }

  private async saveDataSlotInner(
    a: AssignedVm,
    slot: DataSlot,
    opts: DataSaveOpts,
  ): Promise<boolean> {
    const { state } = slot
    const lineage = this.dataLineageFor(state)
    const now = Date.now()

    // An untrusted VM can never write, so there is no point packing a database
    // and shipping it across the control channel to find that out. The only
    // exception is the final export, whose bytes we keep for recovery.
    if (lineage.kind === 'untrusted' && !opts.final) {
      metrics.inc(M.dataRefused)
      return false
    }

    if (!opts.final && this.largeDataThrottled(state, now)) {
      metrics.inc(M.dataUploadThrottled)
      return false
    }

    // The guest short-circuits on an unchanged tag, so an idle project costs
    // one round-trip with no snapshot, no packing and no transfer.
    const known = this.dataTags.get(slot.flightKey)
    let exported: DataExportResult
    try {
      exported = await this.fetchDataExport(a.handle, a.runtimeToken, known, slot.dir)
    } catch (err: any) {
      this.noteDataExportError(a, slot, err)
      throw err
    }
    if (exported === 'unchanged') {
      metrics.inc(M.dataUnchanged)
      return false
    }
    if (exported === 'unsupported') {
      if (!a.dataExportUnsupported) {
        a.dataExportUnsupported = true
        metrics.inc(M.dataUnsupported)
        console.log(
          `[pool] guest for ${a.projectId} predates /pool/export-data — ` +
            `its writable state is not durable until the VM is recycled`,
        )
      }
      return false
    }
    if (!exported) return false
    const { bytes, tag } = exported
    // A snapshot arrived, so whatever the last failure was, it is over. Cleared
    // before the upload, not after: the guest producing a snapshot is the fact
    // the rotation rule and the alert care about, and a refused upload
    // (`conflict`) is a different, already-tracked problem.
    if (a.dataSnapshotFailure) {
      a.dataSnapshotFailure = undefined
      this.writeLive(a)
    }

    if (lineage.kind === 'descends') await this.ensureDailyRestorePoint(slot, now)

    const outcome = await this.uploadDataGuarded(slot.storageId, bytes, {
      quarantine: this.quarantineFor(a),
      lineage,
      preserveOnRefusal: opts.final === true,
    })
    switch (outcome.status) {
      case 'created':
      case 'written': {
        // Re-anchor lineage to what we just wrote, from the PUT's own response,
        // so the next write's precondition matches without a second round-trip.
        state.parentEtag = outcome.etag ?? state.parentEtag
        state.untrustedReason = undefined
        state.lastUploadAt = now
        state.lastBytes = bytes.byteLength
        slot.commit()
        if (tag) this.dataTags.set(slot.flightKey, tag)
        metrics.inc(
          opts.reason === 'recycle'
            ? M.dataUploadRecycle
            : opts.final
              ? M.dataUploadFinal
              : M.dataUploadPeriodic,
        )
        console.log(
          `[pool] saved writable state for ${slot.label} ` +
            `(${bytes.byteLength} bytes, ${outcome.status}, etag=${outcome.etag ?? 'none'})`,
        )
        return true
      }
      case 'conflict': {
        metrics.inc(M.dataConflict)
        // The archive is not the one this workspace descends from, so nothing
        // it exports later will be safe to write either. Distrust it now and
        // stop paying for an export every cycle.
        const why =
          outcome.reason === 'raced-create'
            ? `a durable archive already exists and this workspace cannot prove it descends from it`
            : `its lineage (etag=${state.parentEtag ?? 'none'}) no longer matches the durable archive`
        if (state.untrustedReason !== why) {
          state.untrustedReason = why
          slot.commit()
        }
        console.error(
          `[pool] REFUSED to overwrite durable writable state for ${slot.label} — ${why}. ` +
            `Durable archive left intact` +
            (outcome.quarantineKey ? `; export preserved at ${outcome.quarantineKey}` : '') +
            `.`,
        )
        return false
      }
      case 'refused': {
        metrics.inc(M.dataRefused)
        console.error(
          `[pool] writable state for ${slot.label} NOT persisted — ${outcome.reason}. ` +
            `This project is running without durability` +
            (outcome.quarantineKey ? `; final export preserved at ${outcome.quarantineKey}` : '') +
            `.`,
        )
        return false
      }
      case 'too-large':
        metrics.inc(M.dataTooLarge)
        console.error(
          `[pool] writable state for ${slot.label} is ${outcome.bytes} bytes, over the ` +
            `${outcome.limit}-byte durability limit — NOT persisted. This project's data is ` +
            `only as durable as its VM snapshot; it needs a real storage backend.`,
        )
        // A FINAL export that could not be persisted fails the recycle/suspend
        // step, or the VM would be rotated on data that exists only in its own
        // snapshot (SHO-584). Periodic sweeps still return quietly.
        if (opts.final) {
          throw new Error(`writable state is ${outcome.bytes} bytes, over the ${outcome.limit}-byte durability limit`)
        }
        return false
      case 'skipped':
        return false
    }
  }

  /**
   * True when a periodic upload should wait: the last archive was large and
   * the last upload is more recent than the large-database interval. Every
   * replaced archive is retained as a noncurrent version for a day, so a big
   * database changing every cycle would otherwise store hundreds of copies.
   */
  private largeDataThrottled(state: MemberDataState, now: number): boolean {
    const { projectDataLargeBytes: large, projectDataLargeMinIntervalMs: gap } = this.cfg
    if (!(large > 0) || !(gap > 0)) return false
    if (state.lastBytes == null || state.lastBytes <= large) return false
    if (state.lastUploadAt == null) return false
    return now - state.lastUploadAt < gap
  }

  /**
   * Before the first overwrite of a new UTC day, server-side copy the current
   * archive to yesterday's restore point. Failure never blocks the backup
   * itself; the day stays unmarked so the next cycle retries.
   */
  private async ensureDailyRestorePoint(slot: DataSlot, now: number): Promise<void> {
    const today = utcDate(now)
    if (slot.state.lastDailyCopyDate === today) return
    const day = utcDate(now - 24 * 60 * 60 * 1000)
    try {
      const result = await this.copyDataToDaily(slot.storageId, day)
      if (result === 'copied') {
        metrics.inc(M.dataDailyCopied)
        console.log(`[pool] saved ${day} restore point for ${slot.label}`)
      }
      slot.state.lastDailyCopyDate = today
    } catch (err: any) {
      metrics.inc(M.dataDailyCopyFailed)
      console.error(`[pool] ${day} restore point for ${slot.label} failed (will retry):`, err?.message ?? err)
    }
  }

  /** `protected` for tests. */
  protected copyDataToDaily(projectId: string, date: string): Promise<DailyCopyResult> {
    return copyProjectDataToDaily(projectId, date, this.cfg)
  }

  // --- server-backed published writable-state durability -------------------
  // The metal analog of the Knative runtime's PublishedDataSync, done host-side
  // because the guest holds no S3 creds. Hydrate on cold boot; export
  // periodically + on suspend. All best-effort — the site still serves without
  // durability, it just cold-boots a fresh DB.

  /** Upload a published subdomain's writable-state archive. `protected` for tests. */
  protected uploadPublishedData(subdomain: string, bytes: Uint8Array): Promise<boolean> {
    return uploadPublishedDataArchive(subdomain, bytes, this.cfg)
  }

  private async hydratePublishedData(
    a: AssignedVm,
    subdomain: string,
    handle: FcVmHandle,
    env: Record<string, string>,
  ): Promise<void> {
    if (!this.publishedDataEnabled()) {
      console.log(`[pool] published-data bucket not configured — ${subdomain} serves the source's database and never exports`)
      return
    }
    const ref = await this.publishedDataRef(subdomain)
    if (!ref) {
      console.log(`[pool] no published-data archive for ${subdomain} — booting fresh DB`)
    } else {
      // Goes through the same hydrate path as the other overlays: it extracts a
      // tar over the workspace tree, so a data.tar.gz rooted at the writable
      // paths (prisma/dev.db, uploads/) lands cleanly on the restored source.
      await this.applyArchive(handle, env, ref, `${subdomain} published data`)
      console.log(`[pool] hydrated published-data for ${subdomain} (${ref.bytes} bytes)`)
    }
    a.publishedDataLoaded = true
    this.writeLive(a)
  }

  /** `protected` for tests. */
  protected publishedDataEnabled(): boolean {
    return publishedDataConfigured(this.cfg)
  }

  /** Describe a published subdomain's writable-state archive. `protected` for tests. */
  protected publishedDataRef(subdomain: string): Promise<ArchiveRef | null> {
    return describePublishedDataArchive(subdomain, this.cfg, PRESIGN_TTL_SEC)
  }

  /**
   * Pull the guest's CURRENT writable state and upload it to `{subdomain}/data.tar.gz`.
   * Uses the guest's authenticated `/agent/published-data-archive` endpoint (the
   * same tar the API's dev->live push reads), so the archive stays interchangeable
   * across the Knative pod, the manual push, and this metal VM. Best-effort +
   * idempotent; a no-op when the guest reports nothing writable yet.
   */
  async exportPublishedData(a: AssignedVm): Promise<boolean> {
    if (!a.publishedSubdomain || !a.publishedDataLoaded) return false
    const bytes = await this.fetchPublishedExport(a.handle, a.runtimeToken)
    if (!bytes) return false
    // Re-uploading unchanged state every interval lets an idle copy keep
    // overwriting whatever newer archive has landed since.
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha === a.publishedExportSha) return false
    const uploaded = await this.uploadPublishedData(a.publishedSubdomain, bytes)
    if (uploaded) {
      a.publishedExportSha = sha
      console.log(`[pool] exported published-data for ${a.publishedSubdomain} (${bytes.byteLength} bytes)`)
    }
    return uploaded
  }

  /** Pull the guest's writable-state tar over the control channel. `protected` for tests. */
  protected async fetchPublishedExport(handle: FcVmHandle, token?: string): Promise<Uint8Array | null> {
    const res = await fetch(`${handle.agentUrl}/agent/published-data-archive`, {
      method: 'GET',
      headers: { ...(token ? { 'x-runtime-token': token } : {}) },
      signal: AbortSignal.timeout(this.cfg.hydrateTimeoutMs),
    })
    if (res.status === 404 || res.status === 204) return null
    if (!res.ok) throw new Error(`/agent/published-data-archive failed (${res.status}): ${await res.text()}`)
    const { archive } = (await res.json().catch(() => ({}))) as { archive?: string }
    if (!archive) return null
    return new Uint8Array(Buffer.from(archive, 'base64'))
  }

  /**
   * Export writable state for every live published VM — driven by the agent's
   * periodic exporter loop so long-running always-on sites persist end-user
   * writes without waiting for a suspend (which may never come). Best-effort.
   */
  /**
   * Export writable state for every live VM — driven by the same periodic
   * exporter loop as published data. The suspend-time export alone is not
   * enough: a host that panics, is power-cycled, or has its VMs killed never
   * suspends, and a long-lived always-on project may go days without one.
   * Best-effort; unchanged databases are skipped by the guest's change tag.
   */
  async exportAllProjectData(): Promise<number> {
    let n = 0
    const now = Date.now()
    for (const a of this.assigned.values()) {
      // Permanently unable, or backing off from a run of failures. Both are
      // about not hammering — a guest whose agent is gone does not recover
      // because we asked it again 120 seconds later.
      if (a.dataExportUnsupported) continue
      if (a.dataExportRetryAfter && now < a.dataExportRetryAfter) continue

      try {
        const wrote = await this.saveProjectDataToStore(a)
        // Reaching here at all means the guest answered, so the project is
        // healthy whether or not there was anything new to write.
        a.dataExportFailures = 0
        a.dataExportRetryAfter = undefined
        if (wrote) n++
      } catch (err: any) {
        const fails = (a.dataExportFailures ?? 0) + 1
        const wait = this.dataExportBackoffMs(fails)
        a.dataExportFailures = fails
        a.dataExportRetryAfter = now + wait
        // Log the first few, then only on the (now sparse) retries, so a
        // permanently broken guest costs a handful of lines instead of one
        // per project per cycle for as long as it lives.
        if (fails <= 3 || fails % 10 === 0) {
          console.error(
            `[pool] periodic writable-state export for ${a.projectId} failed ` +
              `(attempt ${fails}, next in ${Math.round(wait / 1000)}s):`,
            err?.message ?? err,
          )
        }
      }
    }
    return n
  }

  /**
   * Back up source for VMs that have been resident a while. Source is otherwise
   * only exported at suspend, and under the relaxed idle window a VM can stay
   * up for hours: a host loss in that time would cost every edit since it was
   * placed. Only VMs with user activity since their last backup are exported,
   * so an idle tail costs nothing.
   */
  async exportAllSource(now = Date.now()): Promise<number> {
    const every = this.cfg.sourceBackupIntervalMs ?? 0
    if (every <= 0) return 0
    let n = 0
    for (const a of [...this.assigned.values()]) {
      if (publishedSourceId(a.projectId) || a.repoHydratePending) continue
      if (this.suspendFlight.has(a.projectId) || this.recycleFlight.has(a.projectId)) continue
      const since = a.lastPeriodicSourceBackupAt ?? a.assignedAt
      if (now - since < every) continue
      if ((a.lastRealActivityAt ?? 0) <= since) continue
      a.lastPeriodicSourceBackupAt = now
      try {
        if (a.projectId.startsWith('ws:')) {
          const failed = await this.saveWorkspaceMembersToStore(a)
          if (failed.length === 0) n++
        } else if ((await this.saveBackupToStore(a)) === 'written') {
          n++
        }
        metrics.inc(M.sourceBackupPeriodic)
      } catch (err: any) {
        metrics.inc(M.sourceBackupPeriodicFailed)
        console.error(`[pool] periodic source backup for ${a.projectId} failed:`, err?.message ?? err)
      }
    }
    return n
  }

  /** Exponential backoff for a failing guest, capped at 30 minutes. */
  private dataExportBackoffMs(failures: number): number {
    const base = this.cfg.projectDataExportIntervalMs
    return Math.min(base * 2 ** Math.min(failures, 8), 30 * 60_000)
  }

  async exportAllPublishedData(): Promise<number> {
    let n = 0
    for (const a of this.assigned.values()) {
      if (!a.publishedSubdomain) continue
      const ok = await this.exportPublishedData(a).catch((err) => {
        console.error(`[pool] periodic published-data export for ${a.publishedSubdomain} failed:`, err?.message ?? err)
        return false
      })
      if (ok) n++
    }
    return n
  }

  // --- encrypted home-directory durability (~/.ssh, ~/.oci, ~/.kube, ...) ---
  // The guest encrypts with a per-project key before handing bytes over, so
  // everything here moves ciphertext. Lineage rules are writable state's.

  /** Describe the durable home archive. `protected` for tests. */
  protected homeStateRef(projectId: string): Promise<ArchiveRef | null> {
    return describeHomeStateArchive(projectId, this.cfg, PRESIGN_TTL_SEC)
  }

  /** Guarded (conditional) upload of the home archive. `protected` for tests. */
  protected uploadHomeGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { lineage: DataLineage; preserveOnRefusal?: boolean; quarantine?: QuarantineBookkeeping },
  ): Promise<DataWriteOutcome> {
    return uploadHomeStateGuarded(projectId, bytes, opts, this.cfg)
  }

  /**
   * Cold-start restore of the home archive. Pushed, not pulled: it is small by
   * construction (the guest caps it at 16 MiB), so none of the large-archive
   * machinery in {@link applyArchive} applies.
   *
   * 'unsupported' = the guest has no home endpoint or no key; it will never
   * export either, so nothing it does can touch the archive.
   */
  private async hydrateHomeState(
    projectId: string,
    handle: FcVmHandle,
    env: Record<string, string>,
  ): Promise<{ hydrated: boolean; parentEtag?: string } | 'unsupported'> {
    const ref = await this.homeStateRef(projectId)
    if (!ref) return { hydrated: false }
    const bytes = await ref.load()
    const token = env.RUNTIME_AUTH_SECRET
    const res = await fetch(`${handle.agentUrl}/pool/hydrate-home`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: bytes,
      signal: AbortSignal.timeout(this.cfg.hydrateTimeoutMs),
    })
    if (res.status === 404) {
      console.log(`[pool] guest for ${projectId} cannot restore its home directory — durable archive left untouched`)
      return 'unsupported'
    }
    if (!res.ok) throw new Error(`/pool/hydrate-home failed (${res.status}): ${await res.text()}`)
    metrics.inc(M.homeHydrated)
    console.log(`[pool] restored home directory for ${projectId} (${bytes.byteLength} bytes, etag=${ref.etag ?? 'none'})`)
    return { hydrated: true, parentEtag: ref.etag ?? undefined }
  }

  /** Pull the guest's encrypted home archive. Same contract as {@link fetchDataExport}, plus 413. */
  protected async fetchHomeExport(
    handle: FcVmHandle,
    token?: string,
    knownTag?: string,
  ): Promise<{ bytes: Uint8Array; tag: string | null } | 'unchanged' | 'unsupported' | 'too-large' | null> {
    const mem = memProbe.begin('export:home', handle.id)
    let bytes = 0
    try {
      const res = await fetch(`${handle.agentUrl}/pool/export-home`, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(knownTag ? { 'If-None-Match': knownTag } : {}),
        },
        signal: AbortSignal.timeout(this.cfg.hydrateTimeoutMs),
      })
      if (res.status === 304) return 'unchanged'
      if (res.status === 204) return null
      if (res.status === 404) return 'unsupported'
      if (res.status === 413) return 'too-large'
      if (!res.ok) throw new Error(`/pool/export-home failed (${res.status}): ${await res.text()}`)
      memProbe.held(mem, Number(res.headers.get('content-length')) || 0)
      const buf = await this.readExportBody(res, `home ${handle.id}`)
      bytes = buf.byteLength
      if (!bytes) return null
      return { bytes: buf, tag: res.headers.get('etag') }
    } finally {
      memProbe.end(mem, bytes)
    }
  }

  private trustedHomeEtag(a: AssignedVm): string | undefined {
    return a.homeUntrustedReason ? undefined : a.homeParentEtag
  }

  private homeLineageOf(a: AssignedVm): DataLineage {
    if (a.homeUntrustedReason) return { kind: 'untrusted', reason: a.homeUntrustedReason }
    if (a.homeParentEtag) return { kind: 'descends', etag: a.homeParentEtag }
    return { kind: 'create-only' }
  }

  private distrustHome(a: AssignedVm, reason: string): void {
    if (a.homeUntrustedReason === reason) return
    a.homeUntrustedReason = reason
    this.writeLive(a)
  }

  /**
   * Pull the guest's home archive and write it under the lineage guard.
   * Serialized per project (periodic sweep vs suspend). `final` = the last
   * export before the VM goes away, whose refused bytes are quarantined.
   */
  async saveHomeStateToStore(a: AssignedVm, opts: DataSaveOpts = {}): Promise<boolean> {
    if (!homeStateEligible(a.publishedSubdomain) || a.homeExportUnsupported) return false
    return this.homeFlight.run(a.projectId, () => this.saveHomeStateInner(a, opts))
  }

  private async saveHomeStateInner(a: AssignedVm, opts: DataSaveOpts): Promise<boolean> {
    const lineage = this.homeLineageOf(a)
    if (lineage.kind === 'untrusted' && !opts.final) {
      metrics.inc(M.homeRefused)
      return false
    }

    const exported = await this.fetchHomeExport(a.handle, a.runtimeToken, this.homeTags.get(a.projectId))
    if (exported === 'unchanged') {
      metrics.inc(M.homeUnchanged)
      return false
    }
    if (exported === 'unsupported') {
      a.homeExportUnsupported = true
      metrics.inc(M.homeUnsupported)
      console.log(`[pool] guest for ${a.projectId} does not persist its home directory (no endpoint or no key)`)
      return false
    }
    if (exported === 'too-large') {
      metrics.inc(M.homeTooLarge)
      console.error(`[pool] home directory for ${a.projectId} is over the guest's limit — NOT persisted`)
      // A final export that did not persist fails the step: the cold boot would
      // hydrate an older home than the one this VM holds (SHO-584).
      if (opts.final) throw new Error("home directory is over the guest's export limit")
      return false
    }
    if (!exported) return false

    const outcome = await this.uploadHomeGuarded(a.projectId, exported.bytes, {
      quarantine: this.quarantineFor(a),
      lineage,
      preserveOnRefusal: opts.final === true,
    })
    switch (outcome.status) {
      case 'created':
      case 'written':
        a.homeParentEtag = outcome.etag ?? a.homeParentEtag
        a.homeUntrustedReason = undefined
        this.writeLive(a)
        if (exported.tag) this.homeTags.set(a.projectId, exported.tag)
        metrics.inc(opts.final ? M.homeUploadFinal : M.homeUploadPeriodic)
        console.log(
          `[pool] saved home directory for ${a.projectId} ` +
            `(${exported.bytes.byteLength} bytes, ${outcome.status}, etag=${outcome.etag ?? 'none'})`,
        )
        return true
      case 'conflict': {
        metrics.inc(M.homeConflict)
        const why =
          outcome.reason === 'raced-create'
            ? 'a durable home archive already exists and this VM cannot prove it descends from it'
            : `its lineage (etag=${a.homeParentEtag ?? 'none'}) no longer matches the durable home archive`
        this.distrustHome(a, why)
        console.error(
          `[pool] REFUSED to overwrite the durable home archive for ${a.projectId} — ${why}` +
            (outcome.quarantineKey ? `; export preserved at ${outcome.quarantineKey}` : '') +
            '.',
        )
        return false
      }
      case 'refused':
        metrics.inc(M.homeRefused)
        console.error(
          `[pool] home directory for ${a.projectId} NOT persisted — ${outcome.reason}` +
            (outcome.quarantineKey ? `; final export preserved at ${outcome.quarantineKey}` : '') +
            '.',
        )
        return false
      case 'too-large':
        metrics.inc(M.homeTooLarge)
        console.error(`[pool] home archive for ${a.projectId} is ${outcome.bytes} bytes, over ${outcome.limit} — NOT persisted`)
        if (opts.final) throw new Error(`home archive is ${outcome.bytes} bytes, over the ${outcome.limit}-byte limit`)
        return false
      case 'skipped':
        return false
    }
  }

  /**
   * Export the home directory of every live VM. Driven by the writable-state
   * export interval; an idle home costs one 304. Failures are logged sparsely
   * and never stop the sweep.
   */
  async exportAllHomeState(): Promise<number> {
    let n = 0
    for (const a of this.assigned.values()) {
      if (a.homeExportUnsupported || !homeStateEligible(a.publishedSubdomain)) continue
      try {
        if (await this.saveHomeStateToStore(a)) n++
        a.homeExportFailures = 0
      } catch (err: any) {
        const fails = (a.homeExportFailures ?? 0) + 1
        a.homeExportFailures = fails
        if (fails <= 3 || fails % 10 === 0) {
          console.error(`[pool] periodic home export for ${a.projectId} failed (attempt ${fails}):`, err?.message ?? err)
        }
      }
    }
    return n
  }

  /**
   * Suspend an assigned project to a snapshot, freeing host RAM.
   * quiesce guest → snapshot (local NVMe) → push to durable store (if enabled).
   * The durable push is best-effort: a failure leaves the hot local snapshot
   * intact so a same-host resume still works. Heavy steps run under the
   * host-wide semaphore; concurrent suspends for one project collapse.
   */
  async suspend(projectId: string, opts: { reason?: SuspendReason } = {}): Promise<SuspendedVm> {
    if (this.recycleFlight.has(projectId)) throw new Error(`project ${projectId} is being recycled`)
    return this.suspendFlight.run(projectId, async () => {
      const a = this.assigned.get(projectId)
      if (!a) throw new Error(`project ${projectId} not assigned`)

      // A pre-warm nobody used holds exactly what it hydrated from the durable
      // backups. Re-pushing them would move their etags past the project's
      // current snapshot, and every open before activation would cold-boot.
      const untouchedPrewarm =
        this.rootfsGeneration(this.bootRootfsIdentity(a), a.handle.vmClass) === 'staged' &&
        !((a.lastRealActivityAt ?? 0) > a.assignedAt)

      // Write-side durability FIRST, while the guest is still fully live: pull
      // the latest source and push it to the durable S3 backup so a resume on a
      // DIFFERENT metal machine (snapshot miss) still cold-hydrates real source.
      // Best-effort — the snapshot below is the primary cross-host resume path.
      let finalBackupFailed = false
      if (!untouchedPrewarm) {
        // The repo goes FIRST because it is the only step that can make a
        // non-durable HEAD durable. If it cannot, this suspend is going to be
        // REFUSED (SHO-442), and every step after it — data, home, source, the
        // published state — would export bytes that then get quarantined for a
        // lineage this VM cannot prove. That ordering is how one VM re-wrote 525
        // MB into `conflict/` every ten minutes for six days (SHO-584).
        //
        // A repo the guest already reported as CORRUPT is not asked again: the
        // failure is permanent for this VM (see `noteRepoCorrupt`), so the export
        // would only burn the guest's CPU to fail the same way.
        if (a.repoCorruptFailure) {
          finalBackupFailed = true
        } else {
          await this.saveRepoToStore(a).catch((err) => {
            finalBackupFailed = true
            console.error(`[pool] repo backup for ${a.projectId} failed:`, err?.message ?? err)
          })
        }

        // Never stop a VM whose current HEAD is not in the durable repo: a cold
        // boot restores the durable copy, so suspending here is how a day and a
        // half of work disappeared (SHO-442). The VM keeps running and the next
        // sweep retries; the alert fires on the unsaved age. Checked HERE, before
        // the remaining exports, so a refused suspend does no more of them.
        if (!this.repoDurable(a)) {
          this.refuseUndurable(a, 'suspend')
          throw new RepoNotDurableError(
            `refusing to suspend ${a.projectId}: its current HEAD is not in the durable repo`,
          )
        }

        if (a.projectId.startsWith('ws:')) {
          // A legacy VM's foreign members are only in this guest; once suspended,
          // its snapshot is never resumed (see foreignStampedMembers).
          await this.drainForeignMembersOf(a, 3_000).catch((err) =>
            console.error(`[pool] draining foreign members of ${a.projectId} failed:`, err?.message ?? err),
          )
          const failed = await this.saveWorkspaceMembersToStore(a).catch((err) => {
            console.error(`[pool] source backup for ${a.projectId} failed:`, err?.message ?? err)
            return [{ projectId: a.projectId, reason: err?.message ?? String(err) }]
          })
          if (failed.length) finalBackupFailed = true
        } else {
          const out = await this.saveBackupToStore(a).catch((err) => {
            console.error(`[pool] source backup for ${a.projectId} failed (snapshot still durable):`, err?.message ?? err)
            return 'lost' as const
          })
          if (out === 'lost') finalBackupFailed = true
        }

        // Same for writable state (database + uploads), and for the same reason:
        // the snapshot is not a backup. A rootfs rebuild invalidates every
        // snapshot at once, and the cold boot that follows restores source only —
        // so without this the user's data is gone.
        await this.saveProjectDataToStore(a, { final: true }).catch((err) => {
          finalBackupFailed = true
          console.error(`[pool] writable-state backup for ${a.projectId} failed:`, err?.message ?? err)
        })

        await this.saveHomeStateToStore(a, { final: true }).catch((err) => {
          finalBackupFailed = true
          console.error(`[pool] home-directory backup for ${a.projectId} failed:`, err?.message ?? err)
        })

        // Server-backed published VM: also flush the live writable state to the
        // published-data bucket so a resume on a DIFFERENT host (snapshot miss)
        // — or a republish/data-push — sees the latest end-user data.
        if (a.publishedSubdomain) {
          await this.exportPublishedData(a).catch((err) =>
            console.error(`[pool] published-data export for ${a.publishedSubdomain} failed (snapshot still durable):`, err?.message ?? err),
          )
        }
      }
      // A snapshot from a superseded rootfs can never be pushed, so the final
      // backups are the only copy. If any of them failed, stopping would drop
      // the work — refuse instead of "skipping the durable push".
      if (!untouchedPrewarm && finalBackupFailed && this.bootSnapshotIsStale(a)) {
        this.refuseUndurable(a, 'suspend (stale rootfs, a final backup failed)')
        throw new RepoNotDurableError(
          `refusing to suspend ${a.projectId}: a final backup failed and its snapshot is from a superseded rootfs`,
        )
      }

      await this.callGuestHook(a.handle.agentUrl, 'quiesce', this.cfg.quiesceTimeoutMs, a.runtimeToken)
      let snapshot: FcSnapshot
      try {
        snapshot = await this.heavy.run(() => this.mgr.snapshotVM(a.handle))
      } catch (err) {
        // The VM keeps running, so bring back the sidecars quiesce stopped.
        await this.callGuestHook(a.handle.agentUrl, 'rehydrate', this.cfg.rehydrateTimeoutMs, a.runtimeToken)
        throw err
      }
      this.closeMeter(a)
      this.assigned.delete(projectId)
      this.live.remove(projectId) // no longer a live process — snapshot is the source of truth
      const now = Date.now()
      const lastAccessAt = Math.max(a.lastTouchedAt, now)
      // Stamp the backup lineage into the snapshot so a resume (here or on
      // another host) carries it back into AssignedVm.backupParentEtag and its
      // next suspend can safely overwrite the backup it actually derives from.
      const s: SuspendedVm = {
        projectId,
        snapshot,
        suspendedAt: now,
        lastAccessAt,
        rootfsIdentity: this.bootRootfsIdentity(a),
        backupEtag: a.backupParentEtag,
        dataEtag: this.trustedDataEtag(a),
        homeEtag: this.trustedHomeEtag(a),
        publishedDataLoaded: a.publishedDataLoaded,
        memberDataEtags: this.trustedMemberDataEtags(a),
        memberSourceEtags: this.trustedMemberSourceEtags(a),
        repoEtag: this.trustedRepoEtag(a),
        workspaceOrigin: a.workspaceOrigin,
        suspendReason: opts.reason,
      }
      const untrustedSource = this.sourceUntrustedReason(a)

      if (this.rootfsGeneration(s.rootfsIdentity!, a.handle.vmClass) === 'staged') {
        // Pre-warm on the staged image: held apart until activation (see
        // `stagedSuspended`); the project's current snapshot keeps serving.
        if (untrustedSource) {
          console.error(`[pool] not keeping a pre-warmed snapshot of ${projectId} — source tree untrusted (${untrustedSource})`)
          await this.deleteLocalArtifacts(snapshot)
          return s
        }
        await this.dropStaged(projectId)
        this.stagedSuspended.set(projectId, s)
        this.writeIndex(s, this.stagedIndex)
        return s
      }

      // Replaces a current snapshot only a staged boot leaves behind (a normal
      // assign resumes, which consumes it).
      const prior = this.suspended.get(projectId)
      if (prior && prior.snapshot.snapshotPath !== snapshot.snapshotPath) {
        await this.deleteLocalArtifacts(prior.snapshot)
      }
      this.suspended.set(projectId, s)
      this.writeIndex(s)

      // A tree we could not vouch for must not come back by resume: it would
      // carry the backup lineage stamped above and write itself over the
      // backup on its next suspend. Cold-boot from the durable backups instead.
      if (untrustedSource) {
        console.error(
          `[pool] not keeping a snapshot of ${projectId} — its source tree is untrusted (${untrustedSource}). ` +
            `The next open cold-boots from the durable backups.`,
        )
        await this.evictLocal(projectId)
        return s
      }

      if (this.store.kind !== 'none' && this.localSnapshotIsStale(s)) {
        // Booted from a superseded rootfs: every pull would reject this
        // snapshot, so uploading it only costs bytes. The final backups above
        // already hold the work, and the next open cold-boots from them.
        console.log(
          `[pool] skipping durable push for ${projectId}: snapshot is from rootfs ${s.rootfsIdentity}, ` +
            `host is on ${this.classRootfsIdentity(a.handle.vmClass)}`,
        )
      } else if (this.store.kind !== 'none') {
        if ((await this.pushDurable(s, a.workspaceOrigin)) === 'blocked') this.evictLocal(projectId)
      }
      return s
    })
  }

  /**
   * Push a suspended snapshot to the durable store. Best-effort: a failure
   * keeps the hot local snapshot. `'blocked'` means the anti-clobber guard
   * refused, and the caller must evict the local copy (see below).
   */
  private async pushDurable(
    s: SuspendedVm,
    origin: SuspendedVm['workspaceOrigin'],
  ): Promise<'pushed' | 'blocked' | 'failed'> {
    const { projectId, snapshot } = s
    const vmClass = snapshot.vmClass ?? 'standard'
    // Anti-clobber for the DURABLE SNAPSHOT tier (mirrors the backup guard):
    // a template-origin VM must not push a template snapshot over a real
    // one. If this workspace is still the template AND a durable snapshot
    // already exists, that existing snapshot descends from real source we
    // must not overwrite — keep the hot local snapshot and skip the push.
    // (A genuinely new project has origin 'template' but no durable snapshot
    // yet, so its first push still creates one.)
    if (origin === 'template' && (await this.store.head(projectId)) != null) {
      metrics.inc(M.backupTemplateSnapshotBlocked)
      // Don't clobber the durable snapshot — AND don't keep this template
      // snapshot locally either: resume() prefers the hot local copy, so a
      // retained template snapshot would SHADOW the real durable one on the
      // next open (a template served over real source). Evict it so the next
      // resume misses locally and pulls the real durable snapshot instead.
      console.error(
        `[pool] REFUSED durable snapshot push for ${projectId} — template-origin VM would clobber an ` +
          `existing durable snapshot. Evicting local template snapshot so the next open restores the ` +
          `real durable copy; durable snapshot left intact.`,
      )
      return 'blocked'
    }
    const identity = s.rootfsIdentity ?? this.classRootfsIdentity(vmClass)
    // In dm mode the durable rootfs artifact is the small CoW *diff*, not
    // the mapper device; in full/reflink it's the image file itself.
    const durable = this.mgr.durableRootfs(snapshot.rootfs)
    const meta: SnapshotMeta = {
      projectId,
      net: snapshot.net,
      vcpus: snapshot.vcpus,
      memoryMB: snapshot.memoryMB,
      bytesMem: snapshot.bytesMem,
      bytesState: snapshot.bytesState,
      createdAt: snapshot.createdAt,
      rootfsPath: snapshot.rootfs,
      rootfsArtifactPath: this.mgr.restoreRootfsArtifactPath(snapshot.rootfs),
      rootfsMode: durable.mode,
      baseIdentity: identity,
      rootfsIdentity: identity,
      vmClass,
      // Not durably persisted (see data-drive.ts header) — recorded only so
      // a cross-host/cold resume can provision a FRESH empty drive of the
      // right size instead of failing outright when the file isn't local.
      dataDriveMiB: snapshot.dataDrive ? classConfig(this.cfg, vmClass).dataDriveMiB : undefined,
      backupEtag: s.backupEtag,
      dataEtag: s.dataEtag,
      homeEtag: s.homeEtag,
      publishedDataLoaded: s.publishedDataLoaded,
      memberDataEtags: s.memberDataEtags,
      memberSourceEtags: s.memberSourceEtags,
      repoEtag: s.repoEtag,
      v: 1,
    }
    try {
      await this.heavy.run(() =>
        this.store.push(
          {
            vmstate: snapshot.snapshotPath,
            mem: snapshot.memFilePath,
            rootfs: durable.path,
            workspaceDrive: snapshot.workspaceDrive,
          },
          meta,
        ),
      )
      return 'pushed'
    } catch (err: any) {
      console.error(`[pool] durable push failed for ${projectId} (local snapshot kept):`, err?.message ?? err)
      return 'failed'
    }
  }

  /**
   * Suspend, unless the VM booted from a rootfs this host has since replaced
   * (neither current nor staged). Such a snapshot could never be resumed, so
   * instead back everything up and stop it without one (the `recycle` path);
   * the control plane re-warms it on the current image (placement `refresh`).
   * A recycle that refuses (busy, a backup failed) falls back to a plain
   * suspend, which keeps today's behavior: the work is safe either way.
   */
  async suspendOrRetire(projectId: string, opts: { reason?: SuspendReason } = {}): Promise<SuspendOutcome> {
    const a = this.assigned.get(projectId)
    if (a && this.rootfsGeneration(this.bootRootfsIdentity(a), a.handle.vmClass) === 'stale') {
      const r = await this.recycle(projectId, { reason: 'stale-rootfs' })
      if (!r.aborted) {
        metrics.inc(M.suspendRetiredStale)
        console.log(`[pool] retired ${projectId}: booted from superseded rootfs ${this.bootRootfsIdentity(a)}`)
        return { kind: 'retired' }
      }
      console.warn(`[pool] retiring ${projectId} aborted (${JSON.stringify(r.steps.at(-1))}) — suspending instead`)
    }
    try {
      const s = await this.suspend(projectId, opts)
      return { kind: 'suspended', s, staged: this.stagedSuspended.get(projectId) === s }
    } catch (err) {
      // A refused stop is an answer, not an error: the VM keeps running and the
      // control plane must not treat it as stopped (SHO-442).
      if (err instanceof RepoNotDurableError) return { kind: 'refused', reason: err.message }
      throw err
    }
  }

  private writeIndex(s: SuspendedVm, index = this.index): void {
    const vmClass = s.snapshot.vmClass ?? 'standard'
    const e: CacheEntry = {
      projectId: s.projectId,
      vmId: s.snapshot.vmId,
      snapshotPath: s.snapshot.snapshotPath,
      memFilePath: s.snapshot.memFilePath,
      rootfs: s.snapshot.rootfs,
      net: s.snapshot.net,
      vcpus: s.snapshot.vcpus,
      memoryMB: s.snapshot.memoryMB,
      bytesMem: s.snapshot.bytesMem,
      bytesState: s.snapshot.bytesState,
      bytesRootfs: s.snapshot.bytesRootfs,
      createdAt: s.snapshot.createdAt,
      suspendedAt: s.suspendedAt,
      lastAccessAt: s.lastAccessAt,
      rootfsIdentity: s.rootfsIdentity ?? this.classRootfsIdentity(vmClass),
      vmClass,
      dataDrive: s.snapshot.dataDrive,
      workspaceDrive: s.snapshot.workspaceDrive,
      backupEtag: s.backupEtag,
      dataEtag: s.dataEtag,
      homeEtag: s.homeEtag,
      publishedDataLoaded: s.publishedDataLoaded,
      memberDataEtags: s.memberDataEtags,
      memberSourceEtags: s.memberSourceEtags,
      repoEtag: s.repoEtag,
      workspaceOrigin: s.workspaceOrigin,
      durablePending: s.durablePending,
      suspendReason: s.suspendReason,
      v: 1,
    }
    index.put(e)
  }

  /** True if the project can be woken here — hot locally OR in the durable store. */
  async canResume(projectId: string): Promise<boolean> {
    if (this.suspended.has(projectId)) return true
    if (this.store.kind === 'none') return false
    return (await this.store.head(projectId)) != null
  }

  /**
   * A locally-cached snapshot is resumable only if it was taken against the
   * SAME golden rootfs this agent now runs. After a rootfs rebuild the stamped
   * identity no longer matches, so restoring it would thaw the OLD guest
   * userspace (e.g. a pre-update agent-runtime) — we must cold-boot instead.
   * A missing identity (legacy entry) is treated as compatible so the first
   * deploy that ships this gate doesn't cold-boot the whole cache at once.
   */
  private localSnapshotIsStale(s: SuspendedVm): boolean {
    return !!s.rootfsIdentity && s.rootfsIdentity !== this.classRootfsIdentity(s.snapshot.vmClass ?? 'standard')
  }

  /**
   * Rootfs identities a rollback could restore — empty unless a watch is open
   * (SHO-552). An image is only restorable while it is still the one at
   * `<base>.prev`, and those identities come from the marker written before the
   * activation renamed it there.
   *
   * Snapshots for these are stale relative to the LIVE rootfs, so reclaim would
   * drop them: the fleet would come back from a rollback with an empty cache and
   * cold-boot everything, which is the cost the rollback exists to avoid.
   */
  private rollbackSnapshotIdentities(): Set<string> {
    if (!getRootfsWatch()) return new Set()
    const prev = getRootfsPrev()
    if (!prev) return new Set()
    return new Set(Object.values(prev.identities).filter((id): id is string => !!id))
  }

  /** Whether a snapshot taken from this VM right now could never be pushed. */
  private bootSnapshotIsStale(a: AssignedVm): boolean {
    const identity = this.bootRootfsIdentity(a)
    return !!identity && identity !== this.classRootfsIdentity(a.handle.vmClass)
  }

  /**
   * Whether durable storage has moved past a snapshot. A snapshot records the
   * ETags of the source / repo / data archives current when it was taken. The
   * only thing that overwrites them afterwards is a VM that ran from that
   * snapshot and then died without suspending (periodic exports, or a rescue)
   * — and its work is in storage, not in the snapshot. Resuming the snapshot
   * anyway is what silently rolled projects back to their last suspend.
   *
   * Returns a reason when stale, else null. Unstamped archives are not
   * compared (legacy snapshots), and an unreachable store does not block a
   * resume.
   */
  protected async snapshotBehindStore(projectId: string, stamps: SnapshotStamps): Promise<string | null> {
    return (await this.snapshotDrift(projectId, stamps))[0]?.detail ?? null
  }

  /**
   * Every archive that has moved past the snapshot, in check order. Member
   * archives are also written by sibling runtimes that mount the same project
   * (a workspace session and its project previews), so member data drift is
   * routine rather than a sign this snapshot's VM died unsuspended.
   */
  protected async snapshotDrift(projectId: string, stamps: SnapshotStamps): Promise<SnapshotDrift[]> {
    const norm = (e?: string | null) => (e ? e.replace(/"/g, '') : undefined)
    type Check = { kind: StaleReason; what: string; stamped?: string; memberId?: string; ref: () => Promise<ArchiveRef | null> }
    const checks: Check[] = [
      { kind: 'source', what: 'source', stamped: stamps.backupEtag, ref: () => this.sourceRef(publishedSourceId(projectId) ?? projectId) },
      { kind: 'repo', what: 'repo', stamped: stamps.repoEtag, ref: () => this.repoStampRef(projectId) },
      { kind: 'data', what: 'data', stamped: stamps.dataEtag, ref: () => this.projectDataRef(projectId) },
      { kind: 'home', what: 'home', stamped: stamps.homeEtag, ref: () => this.homeStateRef(projectId) },
      ...Object.entries(stamps.memberDataEtags ?? {}).map(([memberId, etag]): Check => ({
        kind: 'member_data',
        what: `member ${memberId} data`,
        stamped: etag,
        memberId,
        ref: () => this.projectDataRef(memberId),
      })),
      ...Object.entries(stamps.memberSourceEtags ?? {}).map(([memberId, etag]): Check => ({
        kind: 'member_source',
        what: `member ${memberId} source`,
        stamped: etag,
        memberId,
        ref: () => this.sourceRef(memberId),
      })),
    ]
    const results = await Promise.all(
      checks
        .filter((c) => c.stamped)
        .map(async (c): Promise<SnapshotDrift | null> => {
          let current: string | undefined
          try {
            current = norm((await c.ref())?.etag)
          } catch {
            return null
          }
          if (!current || current === norm(c.stamped)) return null
          return {
            kind: c.kind,
            memberId: c.memberId,
            detail: `${c.what} archive (etag=${current}) is newer than the snapshot's (etag=${norm(c.stamped)})`,
          }
        }),
    )
    return results.filter((d): d is SnapshotDrift => d !== null)
  }

  /**
   * Drift a resume can repair in place by re-applying just that archive, as a
   * cold boot would, instead of discarding the whole snapshot. Writable state
   * only: the guest's sidecars are still quiesced from the snapshot, and the
   * archive overlays a database and uploads without touching source or `.git`.
   */
  private repairableDrift(projectId: string, drift: SnapshotDrift[]): boolean {
    return drift.every(
      (d) =>
        d.kind === 'member_data' ||
        (d.kind === 'data' && !projectId.startsWith('ws:') && !publishedSourceId(projectId)),
    )
  }

  private async repairDrift(a: AssignedVm, env: Record<string, string>, drift: SnapshotDrift[]): Promise<void> {
    for (const d of drift) {
      if (d.kind === 'member_data' && d.memberId) {
        await this.hydrateMemberData(a, env, d.memberId, `/app/workspace/${d.memberId}`)
      } else if (d.kind === 'data') {
        try {
          const r = await this.hydrateProjectData(a.projectId, a.handle, env)
          if (r.hydrated) a.dataParentEtag = r.parentEtag
        } catch (err: any) {
          this.distrustData(a, `writable-state re-hydrate failed at resume (${err?.message ?? err})`)
          console.error(`[pool] writable-state re-hydrate failed for ${a.projectId} at resume:`, err?.message ?? err)
        }
      }
    }
    metrics.inc(M.snapshotDriftRepaired)
    this.writeLive(a)
  }

  /**
   * Resume a suspended project. Prefers the hot local snapshot (sub-second);
   * on a local miss (node-agent restarted, or the project was suspended on
   * another host) it pulls from the durable store, discarding it as stale if
   * the rootfs identity no longer matches. Returns null on a cold miss so the
   * caller can fall back to a fresh assign. On success, returns the restore→
   * ready latency (the user-facing "wake" cost) and rehydrates the guest.
   */
  async resume(
    projectId: string,
    env: Record<string, string> = {},
    timer = new PhaseTimer(),
    cause: VmCause = 'user_open',
  ): Promise<{
    assigned: AssignedVm
    apiMs: number
    readyMs: number
    source: 'local' | 'store'
    /** Why the snapshot was taken: the idle window, or an on-demand eviction. */
    suspendReason?: SuspendReason
    /** Workspace-drive size (MiB) re-asserted after the restore, when requested. */
    drive?: number | null
  } | null> {
    ;({ env } = this.ownMembersOnly(projectId, env))
    // Make room before restoring: a resume is a VM coming back onto this host,
    // so it needs the same slot/RAM an assign does (SHO-444). The snapshot's own
    // size is not known until it is pulled, so the class default is the estimate
    // — close enough for a reserve, and the memory trigger is off by default.
    await timer.time('evict_wait', () =>
      this.makeRoom({
        exclude: projectId,
        vmMemMiB: classConfig(this.cfg, vmClassFromEnv(env)).memMiB,
      }),
    )
    let s = this.suspended.get(projectId)
    let source: 'local' | 'store' = 'local'
    let repair: SnapshotDrift[] = []
    const skipStale = (reason: StaleReason) => {
      metrics.inc(M.staleSnapshotSkipped)
      metrics.inc(`${M.staleSnapshotSkippedByReason}{reason="${reason}"}`)
      this.lastStaleReason.set(projectId, reason)
    }
    this.lastStaleReason.delete(projectId)

    // Rootfs-identity gate for the hot local copy (mirrors the durable pull()).
    // A snapshot from a different golden rootfs would restore stale guest code,
    // so drop it — reclaiming NVMe — and fall through to the durable pull (also
    // identity-gated) / cold boot, which brings the project up on new guest code.
    if (s && this.localSnapshotIsStale(s)) {
      console.log(
        `[pool] local snapshot for ${projectId} is stale (rootfs ${s.rootfsIdentity} != ` +
          `${this.classRootfsIdentity(s.snapshot.vmClass ?? 'standard')}) — evicting and cold-booting for fresh guest code`,
      )
      this.lastStaleReason.set(projectId, 'rootfs')
      await this.evictLocal(projectId)
      s = undefined
    }

    if (s) {
      const foreign = foreignStampedMembers(projectId, s)
      if (foreign.length) {
        skipStale('foreign_members')
        console.warn(
          `[pool] local snapshot for ${projectId} holds foreign workspace members ${foreign.join(',')}; evicting it`,
        )
        await this.evictLocal(projectId)
        s = undefined
      }
    }

    if (s) {
      const local = s
      const drift = await timer.time('stale_check', () => this.snapshotDrift(projectId, local))
      if (drift.length && this.repairableDrift(projectId, drift)) {
        repair = drift
        console.log(`[pool] local snapshot for ${projectId} drifted (${drift.map((d) => d.detail).join('; ')}) — resuming and re-applying`)
      } else if (drift.length) {
        skipStale(drift[0].kind)
        console.warn(`[pool] local snapshot for ${projectId} is behind durable storage — ${drift[0].detail}; evicting it`)
        await this.evictLocal(projectId)
        s = undefined
      }
    }

    if (!s) {
      if (this.store.kind === 'none') {
        metrics.inc(M.resumeColdMiss)
        return null
      }
      const meta = await timer.time('store_head', () => this.store.head(projectId))
      const foreign = meta ? foreignStampedMembers(projectId, meta) : []
      if (foreign.length) {
        skipStale('foreign_members')
        console.warn(
          `[pool] durable snapshot for ${projectId} holds foreign workspace members ${foreign.join(',')}; cold-booting instead`,
        )
        metrics.inc(M.resumeColdMiss)
        return null
      }
      const drift = meta ? await timer.time('stale_check', () => this.snapshotDrift(projectId, meta)) : []
      if (drift.length && !this.repairableDrift(projectId, drift)) {
        skipStale(drift[0].kind)
        console.warn(`[pool] durable snapshot for ${projectId} is behind durable storage — ${drift[0].detail}; cold-booting instead`)
        metrics.inc(M.resumeColdMiss)
        return null
      }
      repair = drift
      // The durable store has no local entry to read a class off of yet, so the
      // freshness check validates against whatever class THIS open/resume call
      // was told to expect (env.SHOGO_RUNTIME_CLASS, same source of truth the
      // control plane used at the original assign). A caller that omits env
      // (e.g. a bare POST /resume) defaults to 'standard' and, for a genuinely
      // docker-class project, degrades safely to an unnecessary cold boot
      // rather than any risk of restoring against the wrong golden image.
      const requestedClass = vmClassFromEnv(env)
      const pullT0 = performance.now()
      let pullWait = 0
      const pulled = await this.heavy.run(
        () => this.store.pull(projectId, this.cfg.snapDir, this.classRootfsIdentity(requestedClass)),
        (ms) => {
          pullWait = ms
          timer.add('heavy_wait', ms)
        },
      )
      timer.add('store_pull', performance.now() - pullT0 - pullWait)
      if (!pulled) {
        metrics.inc(M.resumeColdMiss)
        if (meta) {
          // Label the miss honestly: only an identity mismatch is a rootfs
          // problem. Everything else used to be reported as 'rootfs' too, which
          // inflated the release cold-boot wave (2,250 US boots in 14 days) and
          // sent rewarm tuning after the wrong cause.
          const why = (await this.store.missReason?.(projectId, this.classRootfsIdentity(requestedClass))) ?? 'rootfs'
          this.lastStaleReason.set(projectId, why === 'rootfs' ? 'rootfs' : 'store_miss')
        }
        return null // absent or stale → cold boot
      }
      await assertArtifacts(pulled.files)
      const vmClass = pulled.meta.vmClass ?? requestedClass
      // The data drive's CONTENTS are never pushed to the durable store (see
      // data-drive.ts) — a cross-host / cache-miss resume of a docker-class
      // project provisions a FRESH, empty drive of the recorded size rather
      // than fail the whole resume over a file that was never going to be here.
      const dataDrive =
        pulled.meta.dataDriveMiB && pulled.meta.dataDriveMiB > 0
          ? await this.mgr.provisionFreshDataDrive(
              `restored-${projectId}-${Date.now().toString(36)}`,
              pulled.meta.dataDriveMiB,
            )
          : undefined
      const snapshot: FcSnapshot = {
        vmId: `restored-${projectId}`,
        snapshotPath: pulled.files.vmstate,
        memFilePath: pulled.files.mem,
        // The vmstate-baked backing path (dm device / image file), which
        // prepareRestore rebuilds from the pulled artifact (CoW diff / image).
        rootfs: pulled.meta.rootfsPath,
        net: pulled.meta.net,
        vcpus: pulled.meta.vcpus,
        memoryMB: pulled.meta.memoryMB,
        createdAt: pulled.meta.createdAt,
        bytesMem: pulled.meta.bytesMem,
        bytesState: pulled.meta.bytesState,
        bytesRootfs:
          allocatedBytes(pulled.files.rootfs) +
          (pulled.files.workspaceDrive ? allocatedBytes(pulled.files.workspaceDrive) : 0),
        vmClass,
        dataDrive,
        workspaceDrive: pulled.files.workspaceDrive,
      }
      s = {
        projectId,
        snapshot,
        suspendedAt: pulled.meta.createdAt,
        lastAccessAt: Date.now(),
        rootfsIdentity: pulled.meta.rootfsIdentity,
        backupEtag: pulled.meta.backupEtag,
        dataEtag: pulled.meta.dataEtag,
        homeEtag: pulled.meta.homeEtag,
        publishedDataLoaded: pulled.meta.publishedDataLoaded,
        memberDataEtags: pulled.meta.memberDataEtags,
        memberSourceEtags: pulled.meta.memberSourceEtags,
        repoEtag: pulled.meta.repoEtag,
      }
      source = 'store'
    }

    const t0 = performance.now()
    let restoreWait = 0
    const handle = await this.heavy.run(
      () => this.mgr.restoreVM(s!.snapshot),
      (ms) => {
        restoreWait = ms
        timer.add('heavy_wait', ms)
      },
    )
    const apiMs = performance.now() - t0 - restoreWait
    timer.add('restore', apiMs)
    // restoreVM self-cleans a partial restore; but a VM that restores yet never
    // becomes healthy (or fails rehydrate) is untracked here — stop it so the FC
    // process doesn't leak before open() falls back to a cold boot.
    this.inFlight.add(handle.id)
    let readyMs: number
    try {
      readyMs = await this.waitForHealth(handle, () => this.mgr.isRunning(handle))
      timer.add('health', readyMs)
    } catch (err) {
      await this.mgr.stopVM(handle).catch(() => {})
      throw err
    } finally {
      this.inFlight.delete(handle.id)
    }

    // The first health check after the restore is also the only cheap place to
    // see whether the guest came back with a frozen clock — the rehydrate hook
    // below corrects it, so measure now, before the correction, and make a
    // snapshot that still comes back skewed visible in metrics instead of only
    // in a guest's TLS errors later.
    const skewMs = await probeGuestClockSkew(handle.agentUrl)
    if (skewMs !== null) {
      const abs = Math.abs(skewMs)
      metrics.gauge(M.guestClockSkewMs, Math.max(abs, metrics.getGauge(M.guestClockSkewMs)))
      if (abs > GUEST_CLOCK_SKEW_ALERT_MS) {
        metrics.inc(M.guestClockSkewAfterRestore)
        console.warn(`[pool] guest clock skew ${skewMs}ms after restore ${handle.id} (project=${projectId})`)
      }
    }

    // Now live (assigned), not a cache entry: drop the suspended entry + index.
    this.suspended.delete(projectId)
    this.index.remove(projectId)
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle,
      assignedAt: now,
      cause,
      meter: { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: now },
      lastTouchedAt: now,
      lastRealActivityAt: now,
      lastUserActivityAt: now,
      // Same rule as assign: a resume nobody asked for (schedule / agent_wake /
      // rewarm / prewarm) does not buy the relaxed window (SHO-533).
      userSeenSinceAssign: cause === 'user_open' || cause === 'published',
      restoredFrom: { vmstate: s.snapshot.snapshotPath, mem: s.snapshot.memFilePath },
      // The restored guest runs the image its snapshot was taken on (already
      // gated fresh above); unstamped legacy snapshots count as current.
      bootRootfsIdentity: s.rootfsIdentity ?? this.classRootfsIdentity(s.snapshot.vmClass ?? 'standard'),
      // Carry the runtime token so /pool/export (source backup on suspend) and
      // adopt-on-restart keep working after a resume, not just after an assign.
      runtimeToken: env.RUNTIME_AUTH_SECRET || undefined,
      workspaceMemberIds: workspaceMemberIdsFromEnv(env),
      // Carry the published marker so a resumed server-backed site keeps
      // exporting its writable state (the resume env re-asserts it).
      publishedSubdomain: publishedSubdomainFromEnv(env),
      // A restored workspace descends from the backup that was current when the
      // snapshot was taken. Carry that lineage so the next suspend can safely
      // overwrite it; a legacy snapshot with no stamped ETag stays unknown
      // (saveBackupToStore's `adoptWhenUnknown` handles that migration case).
      workspaceOrigin: 'snapshot',
      backupParentEtag: s.backupEtag,
      // The resumed guest's database is the one frozen in the snapshot, which
      // descends from this archive — so its next export may overwrite it.
      dataParentEtag: s.dataEtag,
      // Likewise the home directory frozen in the snapshot.
      homeParentEtag: s.homeEtag,
      publishedDataLoaded: s.publishedDataLoaded,
      memberData: resumedMemberData(s),
      repoParentEtag: s.repoEtag,
      stateSince: s.suspendedAt,
      // A restore is an open too: the guest hooks below (rehydrate, drift
      // repair, drive growth) have not run yet, so an adopt before they finish
      // must not treat this as a normal VM (SHO-584).
      openState: 'opening',
    }
    this.assigned.set(projectId, a)
    this.writeLive(a)
    // Re-apply the injected env to the restored guest. A snapshot restore
    // brings back the process with the env baked at first assign, so any change
    // since then (AI-proxy URL/token, SHOGO_API_URL, rotated secrets) would be
    // stale until a cold boot — the root cause of the "provider connection
    // errors" incidents. Best-effort: a guest that predates /pool/refresh-env
    // 404s and keeps serving with its prior env.
    await timer
      .time('refresh_env', () => this.refreshGuestEnv(handle, projectId, env))
      .catch((err) =>
        console.error(
          `[pool] env refresh for ${projectId} failed (serving with prior env):`,
          err?.message ?? err,
        ),
      )
    // Before the rehydrate hook, while the sidecars are still quiesced.
    if (repair.length) await timer.time('repair_drift', () => this.repairDrift(a, env, repair))
    // After the env refresh, so restarted sidecars start with the fresh env.
    await timer.time('rehydrate', () =>
      this.callGuestHook(handle.agentUrl, 'rehydrate', this.cfg.rehydrateTimeoutMs, a.runtimeToken),
    )
    // The drive came back with the snapshot at whatever size it was suspended
    // with — grow it to what the project asks for now (SHO-349). A no-op when
    // the sizes already match.
    const wantDriveMiB = workspaceDriveMiBFromEnv(env)
    if (wantDriveMiB !== undefined) {
      await timer
        .time('workspace_drive', () => this.ensureWorkspaceDriveSize(a, wantDriveMiB))
        .catch((err: any) =>
          console.warn(`[pool] resume: workspace-drive grow failed for ${projectId}:`, err?.message ?? err),
        )
    }
    metrics.inc(source === 'local' ? M.resumeLocalHits : M.resumeStoreHits)
    // The restore is complete, so an adopt from here on is a normal VM (SHO-584).
    a.openState = 'ready'
    this.writeLive(a)
    return { assigned: a, apiMs, readyMs: apiMs + readyMs, source, suspendReason: s.suspendReason, drive: wantDriveMiB ?? null }
  }

  /**
   * Record when a runtime's project API sidecar went unhealthy: not ready and
   * not simply absent (`idle`) or deliberately stopped. A guest that does not
   * report `previewHealth` is treated as healthy.
   */
  private trackApiHealth(
    a: AssignedVm,
    health: Array<{ projectId: string; apiPhase: string; apiReady: boolean }> | undefined,
    now: number,
  ): void {
    const bad = Array.isArray(health)
      ? health.filter((p) => p.apiReady === false && p.apiPhase !== 'idle' && p.apiPhase !== 'stopped')
      : []
    if (bad.length === 0) {
      a.apiUnhealthySince = undefined
      a.apiUnhealthyProjects = undefined
      a.apiWatchdogObserved = undefined
      return
    }
    a.apiUnhealthySince ??= now
    a.apiUnhealthyProjects = bad.map((p) => `${p.projectId}:${p.apiPhase}`)
  }

  /**
   * Recycle runtimes whose API sidecar has been unhealthy past
   * `apiUnhealthyRecycleMs` — the self-heal for a sidecar wedged on its port,
   * which no amount of restarting inside the VM fixes. Skips runtimes with an
   * agent turn in flight, and caps attempts per runtime (one per hour, two per
   * day) so a project that is broken in its own code is not recycled forever.
   * A recycle whose backups fail aborts with nothing removed. Returns the
   * runtime keys actually recycled.
   */
  async autoRecycleUnhealthy(now = Date.now()): Promise<string[]> {
    const live = [...this.assigned.values()]
    metrics.gauge(M.apiUnhealthy, live.filter((a) => a.apiUnhealthySince !== undefined).length)
    const mode = this.cfg.apiWatchdogMode
    if (mode === 'off') return []
    const recycled: string[] = []
    for (const a of live) {
      if (a.apiUnhealthySince === undefined) continue
      const forMs = now - a.apiUnhealthySince
      if (forMs < this.cfg.apiUnhealthyRecycleMs) continue
      if (this.vmBusy(a)) continue
      const reason = `api unhealthy for ${Math.round(forMs / 60_000)}m (${(a.apiUnhealthyProjects ?? []).join(', ')})`
      if (mode === 'observe') {
        if (!a.apiWatchdogObserved) {
          a.apiWatchdogObserved = true
          metrics.inc(M.autoRecycleObserved)
          console.warn(`[pool] watchdog (observe): would recycle ${a.projectId} — ${reason}`)
        }
        continue
      }
      if (!this.takeAutoRecycleSlot(a.projectId, now)) {
        metrics.inc(M.autoRecycleRateLimited)
        continue
      }
      console.warn(`[pool] watchdog: recycling ${a.projectId} — ${reason}`)
      const r = await this.recycle(a.projectId, { reason: `watchdog: ${reason}` }).catch((err) => {
        console.error(`[pool] watchdog recycle of ${a.projectId} failed:`, err?.message ?? err)
        return null
      })
      if (r && !r.aborted) {
        metrics.inc(M.autoRecycleOk)
        recycled.push(a.projectId)
      } else {
        metrics.inc(M.autoRecycleAborted)
      }
    }
    return recycled
  }

  /** Per-runtime cap on watchdog recycles: one per hour, two per rolling day. */
  private takeAutoRecycleSlot(runtimeKey: string, now: number): boolean {
    const HOUR = 60 * 60 * 1000
    const history = (this.autoRecycleHistory.get(runtimeKey) ?? []).filter((t) => now - t < 24 * HOUR)
    if (history.length >= 2 || history.some((t) => now - t < HOUR)) {
      this.autoRecycleHistory.set(runtimeKey, history)
      return false
    }
    history.push(now)
    this.autoRecycleHistory.set(runtimeKey, history)
    return true
  }

  /** Mark a project as active so the idle reaper doesn't suspend it. */
  touch(projectId: string): void {
    const a = this.assigned.get(projectId)
    if (!a) return
    a.lastTouchedAt = Date.now()
    // Every proxied request lands here, so this is where an idle-reclaimed VM
    // gets its RAM back before the request reaches the guest. Fire-and-forget:
    // a `deflate_on_oom` balloon already hands pages back under pressure, so no
    // request may wait on (or fail because of) the PATCH.
    this.deflateReclaimed(a, 'request')
  }

  /**
   * Hand a reclaimed VM's RAM back to the guest. Never throws and never awaited
   * by the request or poll that calls it — the balloon's `deflate_on_oom` is the
   * safety net if the PATCH is slow or lost — but always clears the accounting
   * first, so a burst of requests cannot queue up N deflates.
   *
   * `lastBalloonAt` is the hysteresis: the VM is not reclaimed again until a
   * full `METAL_IDLE_RECLAIM_MS` passes, so a request every few seconds cannot
   * flap the balloon (each inflate/deflate costs the guest real work).
   */
  private deflateReclaimed(a: AssignedVm, why: string): void {
    if (a.balloonedMiB === undefined) return
    const reclaimedMiB = a.balloonedMiB
    a.balloonedMiB = undefined
    a.lastBalloonAt = Date.now()
    const started = performance.now()
    void this.mgr
      .deflate(a.handle)
      .then(() => {
        metrics.gauge(M.idleReclaimDeflateMs, +(performance.now() - started).toFixed(1))
      })
      .catch((err: any) => {
        console.error(
          `[pool] balloon deflate (${why}) failed for ${a.projectId}:`,
          err?.message ?? err,
        )
      })
    metrics.inc(M.balloonDeflated)
    console.log(`[pool] balloon deflated ${reclaimedMiB} MiB (${why}): ${a.projectId}`)
  }

  /**
   * Fold real user traffic into idle tracking. User requests reach the guest
   * over DNAT and never touch the node-agent, so without this the reaper/GC
   * would suspend or evict busy projects. Best-effort; a guest without the
   * endpoint is treated as quietly active only when the poll times out, not on a
   * clean 404.
   *
   * Two clocks come out of this, and the difference is the whole point:
   *   - `lastTouchedAt` moves on ANY sign of life, including a failed poll
   *     (fail open) and the guest's catch-all `lastRequestAt`.
   *   - `lastRealActivityAt` — what the reaper gates on — moves only on the
   *     guest's per-class user signals. `lastRequestAt` cannot move it, because
   *     the host's own export sweeps hit every assigned VM every 120s and would
   *     hold the entire fleet resident forever.
   */
  async pollActivity(): Promise<void> {
    if (!this.cfg.activityPoll) return
    const now = Date.now()
    await Promise.all(
      [...this.assigned.values()].map(async (a) => {
        try {
          const res = await fetch(`${a.handle.agentUrl}/pool/activity`, {
            signal: AbortSignal.timeout(this.cfg.activityTimeoutMs),
          })
          if (res.status === 404) return // guest opts out; rely on explicit touch
          if (!res.ok) {
            a.lastTouchedAt = now // fail open
            return
          }
          const body = (await res.json()) as {
            lastRequestAt?: number
            activeStreams?: number
            busy?: boolean
            activeTurns?: number
            liveStreams?: number
            lastAppRequestAt?: number | null
            appRequestCount?: number
            lastAgentRequestAt?: number | null
            repoHeadSha?: string | null
            repoPresent?: boolean
            previewHealth?: Array<{ projectId: string; apiPhase: string; apiReady: boolean }>
          }
          a.lastHealthOk = true
          a.activityPollFailedAt = undefined
          this.trackApiHealth(a, body.previewHealth, now)
          const last = typeof body.lastRequestAt === 'number' ? body.lastRequestAt : 0
          // Cache live-stream count so reapIdle can skip a project mid-generation
          // even when no new HTTP request has bumped lastRequestAt for a while.
          a.activeStreams = typeof body.activeStreams === 'number' ? body.activeStreams : 0
          // The guest's own busy verdict, when it reports one. `activeStreams`
          // alone can outlive its turn (a stopped or frozen stream), which is
          // what pinned guests busy for hours (SHO-348).
          a.busy = typeof body.busy === 'boolean' ? body.busy : undefined
          // The breakdown behind `busy`, so a rotation past the deadline can ask
          // the narrower question "is a turn actually in flight?" instead of
          // trusting a counter a stray background task keeps above zero (§2,
          // SHO-399). `undefined` on a guest too old to report them.
          a.activeTurns = typeof body.activeTurns === 'number' ? body.activeTurns : undefined
          a.liveStreams = typeof body.liveStreams === 'number' ? body.liveStreams : undefined
          // A busy guest — a turn, a background task, a heartbeat run — is NOT
          // activity in the reaper's sense, so it no longer moves
          // `lastRealActivityAt` (SHO-533). It used to, on every poll, and since
          // the recipes tick every 10-60 min the window never elapsed: 120-190
          // VMs stayed resident for 13-24h while the meter billed them idles.
          // `vmBusy` still blocks suspension (see `reapIdle`), so a real turn is
          // never snapshotted away; it just cannot buy another full window. The
          // reaper's clock moves below, only when `vmLiveness` says someone is
          // using this VM.
          // Did the catch-all counter move since the previous poll? Captured
          // before we overwrite it, because the legacy fallback below needs it.
          const prevSeen = a.lastActivityAt
          const catchAllAdvanced = prevSeen !== undefined && last > prevSeen
          a.lastActivityAt = last
          if (catchAllAdvanced) {
            a.lastTouchedAt = now // something reached the guest since we last looked
          }

          // Per-class liveness. `lastRequestAt` above counts EVERY request the
          // guest served, which includes our own export sweeps hitting every VM
          // every 120s — so it can only move `lastTouchedAt`, never the reaper's
          // clock. These two fields are the guest's own "a user did this"
          // classification, and they are what gates suspension.
          //
          // `null` = supported but never happened; absent = an older runtime that
          // cannot classify, in which case fall back to the catch-all so we never
          // suspend a VM that might be serving users we cannot see.
          const appAt = body.lastAppRequestAt
          const agentAt = body.lastAgentRequestAt
          const reportsPerClass = appAt !== undefined || agentAt !== undefined
          // First look at this guest (fresh assign, or adopt after a restart):
          // record the baseline WITHOUT counting it. A two-day-old app request is
          // history, not activity, and treating it as the latter would hand every
          // VM a fresh window on every agent restart.
          const baselining = reportsPerClass && a.perClassActivity !== true
          if (reportsPerClass) a.perClassActivity = true
          if (baselining && a.needsUserActivityBaseline) {
            // Only an ADOPTED VM needs this. The registry does not carry the
            // guest's real-activity history across a restart, so adopt seeded
            // lastUserActivityAt to `now`; without this correction every deploy
            // would hand a VM that has been idle for days another full ceiling.
            // A fresh assign or a resume is a user action happening now, so its
            // `now` seed is already the truth — correcting it from the
            // snapshot's frozen timestamps would suspend the VM on the very
            // first reaper pass after it came back (SHO-420 QA round 1).
            // Guest clock skew is seconds; the ceiling is hours.
            const reported = [appAt, agentAt].filter((t): t is number => typeof t === 'number')
            if (reported.length) a.lastUserActivityAt = Math.min(now, Math.max(...reported))
            // The streak's start did not survive the restart either. A guest
            // busy now with no user since the baseline is assumed busy since
            // then; otherwise every deploy restarts a stuck guest's streak.
            if (this.vmBusy(a) && a.busySince === undefined) a.busySince = a.lastUserActivityAt
          }
          if (reportsPerClass) a.needsUserActivityBaseline = false
          if (this.vmBusy(a)) a.busySince ??= now
          else a.busySince = undefined

          if (typeof appAt === 'number') {
            const advanced = appAt > (a.lastAppRequestAt ?? 0)
            a.lastAppRequestAt = appAt
            if (advanced && !baselining) {
              a.lastTouchedAt = now
              a.lastRealActivityAt = now // an end user hit the app
              a.lastUserActivityAt = now
              this.noteUserSeen(a)
            }
          }
          if (typeof agentAt === 'number') {
            const advanced = agentAt > (a.lastAgentRequestAt ?? 0)
            a.lastAgentRequestAt = agentAt
            if (advanced && !baselining) {
              a.lastTouchedAt = now
              a.lastRealActivityAt = now // someone talked to the agent
              a.lastUserActivityAt = now
              this.noteUserSeen(a)
            }
          }
          // The one clock the reaper, the meter and the fleet gauges share
          // (`vmLiveness`). A live streamed turn or a request of either class
          // inside the activity window is "someone is using this"; anything
          // else — a heartbeat run, a background task, an export sweep — is not,
          // however busy it makes the guest look.
          if (this.vmLiveness(a, now) !== 'idle') {
            a.lastTouchedAt = now
            a.lastRealActivityAt = now
            // Someone is using it: hand back any RAM the idle pass reclaimed.
            this.deflateReclaimed(a, 'activity')
          } else if (this.vmBusy(a)) {
            // Nobody is using it, but the guest is doing real work (a background
            // task, a scheduled run). It needs the RAM it has, so give it back
            // too — reclaim only ever targets a VM that is doing nothing.
            this.deflateReclaimed(a, 'busy')
          }
          if (typeof body.appRequestCount === 'number') a.appRequestCount = body.appRequestCount

          // A guest whose root has no repo says so: nothing to export, and a
          // HEAD cached from an earlier boot must not pin it as undurable for
          // the rest of its life (SHO-540).
          if (body.repoPresent === false) {
            a.repoAbsent = true
            if (a.repoHeadSha) {
              a.repoHeadSha = undefined
              a.repoExportedHeadSha = undefined
            }
          } else if (body.repoPresent === true) {
            a.repoAbsent = false
          }
          const sha = typeof body.repoHeadSha === 'string' && body.repoHeadSha ? body.repoHeadSha : undefined
          if (sha && sha !== a.repoHeadSha) {
            a.repoHeadSha = sha
            void this.saveRepoToStore(a).catch((err) =>
              console.error(`[pool] repo export on HEAD change failed for ${a.projectId}:`, err?.message ?? err),
            )
          }

          // Legacy runtime: no per-class signal exists, so the catch-all is the
          // best available proxy for a user and must keep the VM alive.
          if (!a.perClassActivity && catchAllAdvanced) {
            a.lastRealActivityAt = now
            a.lastUserActivityAt = now
            this.noteUserSeen(a)
          }
        } catch {
          a.lastTouchedAt = now // fail open: never evict on missing data
          a.lastHealthOk = false
          a.activityPollFailedAt = a.activityPollFailedAt ?? now
          // A leftover activeStreams from the last successful poll pins the VM
          // as busy forever while the guest is mute. Expire it.
          if (now - a.activityPollFailedAt >= STALE_STREAM_TTL_MS) {
            a.activeStreams = 0
            a.busy = undefined
          }
        }
      }),
    )
  }

  /**
   * Whether this guest is doing real work, as far as the last activity poll can
   * tell. The guest's own `busy` verdict wins when it reports one; older guests
   * fall back to the raw `activeStreams` counter, which is what this used to be.
   *
   * Every idle/lifecycle gate (reaper, rootfs rotation, API watchdog, recycle)
   * goes through here, so a stream that outlived its turn can no longer keep a
   * VM resident forever — that pin is why an expired AI_PROXY_TOKEN never
   * refreshed on metal (SHO-348).
   */
  private vmBusy(a: AssignedVm): boolean {
    return a.busy ?? (a.activeStreams ?? 0) > 0
  }

  /**
   * Whether a person is waiting on this guest right now: an agent turn is in
   * flight, or a stream still holds its turn.
   *
   * This is the only thing that may block a rootfs rotation once the rollout
   * deadline has passed (SHO-399). `vmBusy` is a superset — a background task
   * that never ends, or an API-side card watch mirrored into the task list, also
   * makes the guest "busy" — and gating rotation on it meant a VM could sit on a
   * superseded image forever (Samsara pinned for 19 h by a `while pgrep` loop,
   * KIF by two card watches). A turn, by contrast, ends.
   *
   * Falls back to `vmBusy` for a guest too old to break its own count down: we
   * cannot tell a turn from a task there, so the safe reading is the old one.
   */
  private vmInTurn(a: AssignedVm): boolean {
    if (a.activeTurns === undefined && a.liveStreams === undefined) return this.vmBusy(a)
    return (a.activeTurns ?? 0) > 0 || (a.liveStreams ?? 0) > 0
  }

  /**
   * Is this guest mid-generation, asked live rather than from the last cached
   * poll — the explicit `POST /stop` consults this before suspending, so it must
   * not act on a 30s-old answer. Reads the same guest verdict `vmBusy` reads:
   * `busy` (the guest's own count, which excludes a leaked `activeStreams`) and
   * the counter only as the fallback for an older guest.
   *
   * Fail-SAFE: an unreachable guest is busy (don't snapshot a turn we cannot
   * see), except a mute guest whose last agent turn is old — then it is safe to
   * stop. A clean 404 (guest opts out) is not busy. Only assigned VMs can be.
   */
  async isBusy(projectId: string): Promise<boolean> {
    const a = this.assigned.get(projectId)
    if (!a) return false
    try {
      const res = await fetch(`${a.handle.agentUrl}/pool/activity`, {
        signal: AbortSignal.timeout(this.cfg.activityTimeoutMs),
      })
      if (res.status === 404) return false // guest opts out of activity reporting
      if (!res.ok) return true // unknown state → don't risk killing a live turn
      const body = (await res.json()) as { activeStreams?: number; busy?: boolean }
      // `busy` is the guest's own verdict and excludes a leaked stream counter;
      // older guests only report `activeStreams`.
      return body.busy ?? (body.activeStreams ?? 0) > 0
    } catch {
      const now = Date.now()
      a.lastHealthOk = false
      a.activityPollFailedAt = a.activityPollFailedAt ?? now
      const failedFor = now - a.activityPollFailedAt
      const agentIdle = a.lastAgentRequestAt ? now - a.lastAgentRequestAt : now - a.assignedAt
      // Mute guest: poll has been failing and the last agent turn is old.
      // Force-suspend is safe — this is not a live turn we cannot see.
      if (failedFor >= STALE_STREAM_TTL_MS && agentIdle >= MUTE_AGENT_IDLE_MS) return false
      return true // can't confirm idleness → fail safe (don't suspend)
    }
  }

  /**
   * Whether this VM is past the busy-idle ceiling: it reports busy, but no
   * person has used it for `busyIdleCeilingMs`. This is the escape hatch for a
   * guest that wrongly reports `busy: true` (or leaks `activeStreams`) — it
   * would otherwise never be idle-suspended, never rotate onto a fixed image,
   * and hold host RAM forever (SHO-420).
   *
   * Deliberately excluded:
   *   - `alwaysOn` VMs (paid, never idle-suspended).
   *   - guests without per-class activity: their only signal is the catch-all,
   *     which our own export sweeps move, so idle cannot be told from used.
   *   - `busyIdleCeilingMs <= 0` (operator disabled it).
   */
  private pastBusyIdleCeiling(a: AssignedVm, now = Date.now()): boolean {
    const ceiling = this.cfg.busyIdleCeilingMs
    if (!(ceiling > 0)) return false
    if (a.alwaysOn || a.perClassActivity !== true) return false
    if (!this.vmBusy(a)) return false
    const userIdleAt = a.lastUserActivityAt ?? a.assignedAt
    // Both clocks: no person for the ceiling AND busy without a break for it.
    // A turn that started recently (a project call, a hook, a webchat message)
    // is real work even when no person has used the VM for hours.
    return now - userIdleAt >= ceiling && now - (a.busySince ?? userIdleAt) >= ceiling
  }

  /**
   * The idle window this VM gets, given the window the reaper is applying on
   * this pass.
   *
   * A VM the platform started on its own initiative — a schedule tick, an agent
   * wake, a `rewarm`/`prewarm` — has not been asked for by any person yet, so it
   * only gets the aggressive window (`METAL_IDLE_SUSPEND_MS`) even while the
   * region's directive says relaxed. An automated wake buying four hours of
   * resident RAM nobody wanted is a large share of the idle bill (SHO-533). The
   * first real app/agent request lifts the narrowing (`userSeenSinceAssign`).
   */
  private idleWindowFor(a: AssignedVm, windowMs: number): number {
    if (a.userSeenSinceAssign === false && this.cfg.idleSuspendMs > 0) {
      return Math.min(windowMs, this.cfg.idleSuspendMs)
    }
    return windowMs
  }

  /** Retry delay after the Nth consecutive idle-suspend refusal: 1m doubling to 1h. */
  private refuseBackoffMs(count: number): number {
    return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(Math.max(count, 1) - 1, 6))
  }

  /** Whether this VM is in its refusal backoff window (don't attempt it again yet). */
  private refuseBackoffActive(a: AssignedVm, now = Date.now()): boolean {
    return a.refuseRetryAt !== undefined && a.refuseRetryAt > now
  }

  /**
   * Reclaim the host RAM of VMs nobody is using, without suspending them
   * (SHO-534). Driven by the same reaper tick as `reapIdle`, immediately after
   * the activity poll and before it, so an idle VM gets small long before it is
   * ever snapshotted — and an always-on VM, which is never suspended at all, is
   * the case this exists for.
   *
   * "Idle" is `vmLiveness` — the one classifier the reaper, the meter and the
   * fleet gauges share — not a second opinion about who is using a VM. On top of
   * it: the guest must not be busy (`vmBusy`; a background task or heartbeat run
   * needs its RAM), the full `METAL_IDLE_RECLAIM_MS` window must have passed
   * since the last real user activity, and the VM must not have been deflated
   * within that window (hysteresis, so a request every few seconds cannot make
   * the balloon flap).
   *
   * The inflate itself is stats-guided and bounded: `maxWaitMs: 0` sets the
   * target and returns, because a reaper tick must never sit through GiB-scale
   * inflation. A VM whose agent has no balloon statistics is marked and skipped
   * for good — never blind-inflated.
   */
  async reclaimIdleVms(now = Date.now()): Promise<string[]> {
    if (!this.cfg.idleReclaim) return []
    const windowMs = this.cfg.idleReclaimMs
    if (!(windowMs > 0)) return []

    const picked: AssignedVm[] = []
    for (const a of this.assigned.values()) {
      if (picked.length >= MAX_IDLE_RECLAIMS_PER_PASS) break
      if (a.balloonedMiB !== undefined || a.balloonUnsupported) continue
      if (this.vmLiveness(a, now) !== 'idle') continue
      if (this.vmBusy(a)) continue
      if (now - (a.lastRealActivityAt ?? a.assignedAt) < windowMs) continue
      if (a.lastBalloonAt !== undefined && now - a.lastBalloonAt < windowMs) continue
      picked.push(a)
    }
    if (!picked.length) return []

    const reclaimed: string[] = []
    for (const a of picked) {
      try {
        const r = await this.mgr.reclaimIdle(a.handle, {
          floorMiB: this.cfg.idleReclaimFloorMiB,
          maxWaitMs: 0,
        })
        if (!r.statsAvailable) {
          a.balloonUnsupported = true
          continue
        }
        // Either way the balloon has been looked at: a guest with nothing above
        // the floor is not re-probed on every tick, and one that was reclaimed
        // earlier (before an agent restart lost the accounting) is re-adopted
        // rather than counted twice.
        a.lastBalloonAt = now
        if (r.reclaimedMiB <= 0) continue
        const already = a.balloonedMiB !== undefined
        a.balloonedMiB = r.reclaimedMiB
        metrics.inc(M.balloonReclaimedMiB, r.increasedMiB)
        if (already) continue
        reclaimed.push(a.projectId)
        const idleMin = Math.round((now - (a.lastRealActivityAt ?? a.assignedAt)) / 60_000)
        console.log(
          `[pool] idle reclaim: ballooned ${r.reclaimedMiB} MiB on ${a.projectId} ` +
            `(idle ${idleMin}m${a.alwaysOn ? ', always-on' : ''})`,
        )
      } catch (err: any) {
        console.error(`[pool] idle reclaim failed for ${a.projectId}:`, err?.message ?? err)
      }
    }
    return reclaimed
  }

  /**
   * Suspend assigned VMs that have been idle past the threshold. Driven by the
   * reaper timer in server.ts. Returns the projectIds that were suspended.
   */
  async reapIdle(
    idleMs = this.cfg.idleSuspendMs,
    opts: { maxPerPass?: number; tier?: string; retired?: string[] } = {},
  ): Promise<string[]> {
    if (idleMs <= 0) {
      metrics.gauge(M.busyIdleVms, 0)
      return []
    }
    const now = Date.now()
    // What `status()` reports as each VM's `holdReason`, so "why is this one
    // still resident" is answerable from the window the reaper actually used.
    this.reapWindowMs = idleMs
    // Final tick before anything is suspended: a VM's last running seconds are
    // metered while it is still assigned, so suspending it never loses billable
    // time (`closeMeter` is the belt to this braces).
    this.advanceMeters(now)
    const idleFor = (a: AssignedVm) => now - (a.lastRealActivityAt ?? a.assignedAt)
    // Always-on projects (paid tiers) are never idle-suspended — the parity for
    // Knative's min-scale=1. They still resume fine if the agent restarts, but
    // during normal operation they stay resident.
    // Gate on guest-observed activity, not lastTouchedAt: see
    // `AssignedVm.lastRealActivityAt`. Falling back to assignedAt keeps a VM
    // that has never reported activity on a window measured from placement.
    // A long-running generation can outlast the idle window without any new
    // external request bumping lastTouchedAt, so also skip any VM the last
    // activity poll saw mid-stream — never snapshot away an active agent
    // message. (The reaper timer polls activity immediately before this.)
    //
    // `vmBusy` blocks the suspend but no longer extends the window: once the
    // window has passed, the VM goes on the first quiet poll between two
    // heartbeat ticks (SHO-533). A continuously busy guest is still caught by
    // the busy-idle ceiling — the second clause, which overrides `busy`,
    // `activeStreams`, `activeTurns` and tasks.
    // A VM whose HEAD could not be made durable is not suspendable, and every
    // attempt pays a full repo export. Retrying it on every scan starves the pass
    // every other idle VM needs (SHO-533: one VM on dal-1 was refused 2,367 times
    // in 24h), so it sits out its backoff — and it is dropped here, BEFORE the
    // per-pass cap. Filtering it after the cap was worse than not filtering at
    // all: refused VMs have the longest `idleFor`, so they sort to the head, take
    // every slot, and a host whose refused set reached `METAL_REAP_MAX_PER_PASS`
    // would suspend nothing, ever (QA round 1).
    const candidates = [...this.assigned.values()].filter(
      (a) =>
        !a.alwaysOn &&
        ((idleFor(a) >= this.idleWindowFor(a, idleMs) && !this.vmBusy(a)) ||
          this.pastBusyIdleCeiling(a, now)),
    )
    const backingOff = candidates.filter((a) => this.refuseBackoffActive(a, now))
    if (backingOff.length) metrics.inc(M.idleReapRefusedBackoff, backingOff.length)
    const stale = candidates
      .filter((a) => !this.refuseBackoffActive(a, now))
      .sort((x, y) => idleFor(y) - idleFor(x))
    // VMs the reaper would have suspended if their guest did not report busy.
    metrics.gauge(
      M.busyIdleVms,
      [...this.assigned.values()].filter(
        (a) => !a.alwaysOn && this.vmBusy(a) && now - (a.lastUserActivityAt ?? a.assignedAt) >= idleMs,
      ).length,
    )
    metrics.gauge(
      M.idleSuspendRefusedVms,
      [...this.assigned.values()].filter((a) => this.refuseBackoffActive(a, now)).length,
    )
    for (const id of this.busyIdleCeilingLogged) if (!this.assigned.has(id)) this.busyIdleCeilingLogged.delete(id)
    const cap = opts.maxPerPass ?? this.cfg.reapMaxPerPass ?? 0
    if (cap > 0 && stale.length > cap) {
      metrics.inc(M.idleReapDeferred, stale.length - cap)
      stale.length = cap
    }
    const done: string[] = []
    for (const a of stale) {
      const byCeiling = this.pastBusyIdleCeiling(a, now)
      if (byCeiling && !this.busyIdleCeilingLogged.has(a.projectId)) {
        this.busyIdleCeilingLogged.add(a.projectId)
        const hours = (ms: number) => (ms / 3_600_000).toFixed(1)
        console.warn(
          `[pool] busy-idle ceiling: suspending ${a.projectId} — reports busy ` +
            `(busy=${a.busy}, activeStreams=${a.activeStreams ?? 0}, activeTurns=${a.activeTurns}) ` +
            `but no user activity for ${hours(now - (a.lastUserActivityAt ?? a.assignedAt))}h ` +
            `(ceiling ${hours(this.cfg.busyIdleCeilingMs)}h)`,
        )
      }
      try {
        const outcome = await this.suspendOrRetire(a.projectId, { reason: 'idle' })
        if (outcome.kind === 'retired') opts.retired?.push(a.projectId)
        else if (outcome.kind === 'refused') {
          // Not stopped: its HEAD is not durable yet (SHO-442). Leave it running,
          // but back off — a refusal costs a full repo export (seconds to a
          // minute), so retrying it every scan is what starved the reaper of the
          // passes every OTHER idle VM needed (SHO-533).
          this.noteSuspendRefused(a, outcome.reason, now)
          continue
        } else done.push(a.projectId)
        this.clearSuspendRefusal(a)
        metrics.inc(`${M.idleSuspendedByTier}{tier="${opts.tier ?? 'static'}"}`)
        if (byCeiling) metrics.inc(M.busyIdleCeilingSuspended)
      } catch (err: any) {
        console.error(`[pool] idle-suspend failed for ${a.projectId}:`, err?.message ?? err)
      }
    }
    return done
  }

  /**
   * Record one more consecutive idle-suspend refusal on this VM and back its next
   * attempt off. Warns once per VM with the reason and how long it has been
   * refused: the underlying export path already logs every attempt, and with the
   * backoff that is now once an hour instead of once a scan.
   */
  private noteSuspendRefused(a: AssignedVm, reason: string, now: number): void {
    a.refuseCount = (a.refuseCount ?? 0) + 1
    a.refusedSince ??= now
    // A corrupt `.git` will not be durable no matter how often this is retried,
    // so it backs off like a blocked rotation (six hours), not like a HEAD that
    // simply has not been exported yet (SHO-584).
    const backoff = a.repoCorruptFailure ? ROTATE_BLOCKED_RETRY_MS : this.refuseBackoffMs(a.refuseCount)
    a.refuseRetryAt = now + backoff
    this.writeLive(a)
    metrics.inc(M.idleSuspendRefused)
    if (!a.refusalLogged) {
      a.refusalLogged = true
      console.warn(
        `[pool] idle-suspend is HELD for ${a.projectId} by a non-durable HEAD: ${reason}. ` +
          `Backing off ${Math.round(backoff / 60_000)}m per attempt ` +
          `(refused since ${new Date(a.refusedSince).toISOString()}); counted in ${M.idleSuspendRefused}.`,
      )
    }
  }

  private clearSuspendRefusal(a: AssignedVm): void {
    a.refuseCount = undefined
    a.refusedSince = undefined
    a.refuseRetryAt = undefined
    a.refusalLogged = undefined
    // Deliberately no `writeLive`: this runs after the VM left the assigned set,
    // and writing an entry back would resurrect it in the adopt-on-restart
    // registry for a process that is gone.
  }

  /**
   * Make room for one more VM on this host by suspending the longest-idle
   * evictable ones (SHO-444).
   *
   * Called at the top of `assign()` and `resume()`, before the VM is claimed or
   * restored, so a full host serves the incoming project instead of the control
   * plane buying another host to hold VMs nobody is using. Also called by the
   * reaper's headroom pass, which keeps most assigns from ever paying for this.
   *
   * Never fails an assign: if nothing is evictable the caller proceeds exactly
   * as before (the host has always accepted an assign it has no room for) and
   * `evict_none_available` increments, which is the signal that the host is
   * genuinely full of work rather than of warm VMs.
   *
   * Returns the projectIds actually suspended.
   */
  async makeRoom(opts: {
    /** The project being assigned/resumed — never evict it. */
    exclude: string
    /** RAM the incoming VM will occupy, for the memory trigger. */
    vmMemMiB: number
    /**
     * Metric label for the eviction. Defaults to the fullness trigger
     * (`mem` | `slots`); the headroom pass passes `headroom` so its evictions
     * are distinguishable from ones an assign had to pay for.
     */
    label?: 'mem' | 'slots' | 'headroom'
    /** Cap on evictions for this call; defaults to METAL_EVICT_MAX_PER_ASSIGN. */
    max?: number
    /**
     * Keep this many VMs' worth of room free rather than just one VM's (the
     * reaper's headroom pass). 0 = make room for exactly the incoming VM.
     */
    headroomSlots?: number
  }): Promise<string[]> {
    const cap = opts.max ?? this.cfg.evictMaxPerAssign
    if (!(cap > 0)) return []
    const headroom = Math.max(0, opts.headroomSlots ?? 0)
    const mem = this.hostMemoryNow()
    const reserve = resolveMemReserveMiB(this.cfg.evictMemReserveMiB, mem?.totalMiB)
    const evicted: string[] = []
    // VMs this call must not pick again. `evicting` only covers the duration of
    // one attempt, so a refused or failed stop would otherwise be re-selected
    // on the next iteration and burn the whole cap on one VM (SHO-444).
    const skip = new Set([opts.exclude])
    for (let i = 0; i < cap; i++) {
      const full = hostFullness({
        resident: this.assigned.size + headroom,
        residentCap: this.cfg.maxResidentVmsPerHost,
        memAvailableMiB: mem?.availableMiB,
        vmMemMiB: opts.vmMemMiB * (1 + headroom),
        memReserveMiB: reserve,
      })
      if (!full.full) break
      const now = Date.now()
      const candidates = [...this.assigned.values()]
        .filter((a) => this.vmResidency(a, now) === 'evictable')
        .map((a) => ({ projectId: a.projectId, idleMs: now - (a.lastRealActivityAt ?? a.assignedAt) }))
      const victim = selectEvictionVictim({
        candidates,
        exclude: skip,
        evicting: this.evicting,
      })
      if (!victim) {
        metrics.inc(M.evictNoneAvailable)
        console.warn(
          `[pool] host full (${full.reason}) for ${opts.exclude} but nothing is evictable — ` +
            `${this.assigned.size} resident, all active`,
        )
        break
      }
      this.evicting.add(victim.projectId)
      try {
        // Re-check immediately before suspending: the VM may have become active
        // between selection and here (a user clicked, a turn started). Skipping
        // it costs one loop iteration; suspending it would drop live work.
        const a = this.assigned.get(victim.projectId)
        if (!a || this.vmResidency(a, Date.now()) !== 'evictable') continue
        const outcome = await this.suspendOrRetire(victim.projectId, { reason: 'evicted' })
        if (outcome.kind === 'retired') {
          // Retired off a superseded rootfs: the control plane re-warms it, so
          // it is not a suspend and must not be counted as one.
          metrics.inc(`${M.evictions}{reason="retired"}`)
        } else if (outcome.kind === 'refused') {
          // SHO-442: the VM's git history is not durable yet, so the stop was
          // refused and it is still running. Not an eviction — try the next
          // candidate rather than counting a VM that never left.
          skip.add(victim.projectId)
          console.warn(`[pool] eviction of ${victim.projectId} refused (${outcome.reason}) — trying the next`)
          continue
        } else {
          evicted.push(victim.projectId)
          metrics.inc(`${M.evictions}{reason="${opts.label ?? full.reason}"}`)
          console.log(
            `[pool] evicted ${victim.projectId} (idle ${Math.round(victim.idleMs / 1000)}s) ` +
              `to make room for ${opts.exclude} — host full on ${full.reason}`,
          )
        }
        this.onEvicted?.(victim.projectId)
      } catch (err: any) {
        // A suspend that refuses (e.g. SHO-442's "HEAD not durable") must not
        // fail the incoming assign: try the next candidate.
        skip.add(victim.projectId)
        console.warn(`[pool] eviction of ${victim.projectId} failed, trying the next:`, err?.message ?? err)
      } finally {
        this.evicting.delete(victim.projectId)
      }
    }
    return evicted
  }

  /**
   * Called after an on-demand eviction suspends a VM, so the host can drop its
   * DNAT forward and tell the control plane the project is no longer resident
   * here. A callback because pool.ts must not import register.ts (which imports
   * pool.ts); server.ts wires it to `fwd.remove` + `reportPlacement`.
   */
  onEvicted?: (projectId: string) => void

  /**
   * The host's memory as the eviction policy sees it. A seam so a test can
   * inject a meminfo instead of needing a Linux host.
   */
  protected hostMemoryNow(): { totalMiB: number; availableMiB: number } | undefined {
    return hostMemory()
  }

  /** KSM counters for the host gauges; `undefined` off Linux or with no KSM. */
  protected hostKsmNow():
    | (KsmCounters & { ksmdCpuPct?: number; ksmdCpuWindowMs?: number })
    | undefined {
    return hostKsm()
  }

  /**
   * The reaper's proactive headroom pass: keep `METAL_EVICT_HEADROOM_SLOTS`
   * VMs' worth of room free so most assigns never pay for an on-demand
   * eviction (a backup + snapshot on the incoming open's path).
   *
   * Counted against the same per-pass cap as `reapIdle`, so a host that is
   * suddenly over-full cannot spend one pass evicting everything.
   */
  async evictForHeadroom(): Promise<string[]> {
    const slots = this.cfg.evictHeadroomSlots
    if (!(slots > 0)) return []
    const cap = this.cfg.reapMaxPerPass > 0 ? Math.min(this.cfg.reapMaxPerPass, slots) : slots
    return this.makeRoom({
      exclude: '',
      vmMemMiB: this.cfg.memMiB,
      label: 'headroom',
      max: cap,
      headroomSlots: slots,
    })
  }

  /**
   * Rootfs rollout: retire assigned VMs still on a superseded image (backed up,
   * stopped without a snapshot) so the control plane warms them on the current
   * one. A VM goes once it has been idle for `rolloutIdleMs`, or
   * `rolloutDeadlineMs` after this host first saw it stale, and never during an
   * agent turn. Unlike `reapIdle`, always-on VMs rotate too; they come back
   * separately because the control plane boots them again instead of leaving
   * them suspended.
   *
   * A failed backup blocks rotation, and it blocked it FOREVER and silently:
   * one database that could not be snapshotted kept its VM on a
   * pre-SHO-485/514 runtime for four days while the rotation re-uploaded a
   * 1.7 GB source bundle every ten minutes (SHO-541). It still refuses to
   * rotate — there is no way to prove the durable archive already holds a
   * database nobody can read — but it now names the failure on the VM's status
   * as `stale_rootfs_blocked`, alerts once, and backs off to
   * {@link ROTATE_BLOCKED_RETRY_MS} instead of hammering the host.
   */
  async rotateStale(now = Date.now()): Promise<{ retired: string[]; alwaysOn: string[] }> {
    const out = { retired: [] as string[], alwaysOn: [] as string[] }
    if (!(this.cfg.rolloutIdleMs > 0)) return out
    const stale = [...this.assigned.values()].filter(
      (a) => this.rootfsGeneration(this.bootRootfsIdentity(a), a.handle.vmClass) === 'stale',
    )
    const staleIds = new Set(stale.map((a) => a.projectId))
    for (const id of this.staleSince.keys()) if (!staleIds.has(id)) this.staleSince.delete(id)
    for (const a of stale) if (!this.staleSince.has(a.projectId)) this.staleSince.set(a.projectId, now)

    const due = stale.filter((a) => {
      if (now < (a.rotateRetryAt ?? 0)) return false
      // A corrupt `.git` blocks rotation on its own clock, persisted with the VM:
      // a rotation that cannot back up must not be retried after every deploy
      // just because `rotateRetryAt` was in memory (SHO-584).
      if (a.repoCorruptFailure && now < a.repoCorruptFailure.retryAt) return false
      const idleFor = now - (a.lastRealActivityAt ?? a.assignedAt)
      const pastDeadline = now - this.staleSince.get(a.projectId)! >= this.cfg.rolloutDeadlineMs
      // Past the deadline a turn is the only thing that still blocks rotation:
      // a background task or a card-watch mirror must not pin a VM to a
      // superseded rootfs forever (SHO-399). Before it, nothing changes.
      if (pastDeadline ? this.vmInTurn(a) : this.vmBusy(a)) return false
      return idleFor >= this.cfg.rolloutIdleMs || pastDeadline
    })
    const cap = this.cfg.reapMaxPerPass ?? 0
    if (cap > 0 && due.length > cap) due.length = cap
    for (const a of due) {
      const alwaysOn = !!a.alwaysOn
      try {
        const r = await this.recycle(a.projectId, {
          reason: 'stale-rootfs',
          // Tell the guest why it is going away so every stopped task carries
          // the release as its reason, not a generic restart; the guest settles
          // them `interrupted` and the owner hears about it after the recycle.
          stopBackgroundTasks: true,
        })
        if (r.aborted) {
          const failed = r.steps.filter((s) => !s.ok)
          const detail = failed.map((s) => `${s.step}: ${s.detail ?? 'failed'}`).join('; ') || 'no step failed'
          // A database nobody can snapshot is not going to become snapshot-able
          // by retrying, and rotating anyway would replace it with whatever the
          // durable archive happens to hold. Name the state it is stuck in, alert
          // once, and stop burning a 1.7 GB source export every ten minutes on a
          // rotation that cannot succeed (SHO-541: four days of exactly that).
          const dataOnly = failed.length > 0 && failed.every((s) => s.step === 'data') && !!a.dataSnapshotFailure
          // A corrupt `.git` is the same shape of dead end as an un-snapshottable
          // database: no retry repairs it, and every attempt runs the backup (and
          // used to re-quarantine the source) before aborting. Block it for the
          // same six hours instead of every ten minutes (SHO-584).
          const repoCorrupt = !!a.repoCorruptFailure && failed.some((s) => s.step === 'repo')
          if (dataOnly || repoCorrupt) {
            this.markRotationBlocked(
              a,
              dataOnly
                ? `its database cannot be snapshotted (${a.dataSnapshotFailure!.message}), so the final backup ` +
                    `rotation requires will not happen; the VM stays on its current runtime`
                : `its git repository is corrupt (${a.repoCorruptFailure!.message}), so the final repo backup ` +
                    `rotation requires will not happen; the VM stays on its current runtime`,
            )
            a.rotateRetryAt = now + ROTATE_BLOCKED_RETRY_MS
            this.writeLive(a)
            console.warn(
              `[pool] rollout rotation of ${a.projectId} BLOCKED (${detail}); ` +
                `retrying in ${ROTATE_BLOCKED_RETRY_MS / 3_600_000}h`,
            )
          } else {
            a.rotateRetryAt = now + ROTATE_RETRY_MS
            this.writeLive(a)
            console.warn(
              `[pool] rollout rotation of ${a.projectId} aborted (${detail}); ` +
                `retrying in ${ROTATE_RETRY_MS / 60_000}m`,
            )
          }
          continue
        }
      } catch (err: any) {
        a.rotateRetryAt = now + ROTATE_RETRY_MS
        this.writeLive(a)
        console.error(`[pool] rollout rotation failed for ${a.projectId}:`, err?.message ?? err)
        continue
      }
      this.staleSince.delete(a.projectId)
      a.rotateRetryAt = undefined
      a.rotationBlocked = undefined
      this.writeLive(a)
      metrics.inc(M.rolloutRotated)
      ;(alwaysOn ? out.alwaysOn : out.retired).push(a.projectId)
    }
    return out
  }

  /**
   * This VM's database durability for the status surfaces: how long the
   * current snapshot-failure streak has run, or nothing when it is healthy.
   */
  private dataHealthOf(a: AssignedVm, now = Date.now()): (DataSnapshotFailure & { failingMs: number }) | undefined {
    const f = a.dataSnapshotFailure
    return f ? { ...f, failingMs: Math.max(0, now - f.since) } : undefined
  }

  /** Why rotation gave up on this project's VM, if it did. */
  private rotationBlockedOf(projectId: string): RotationBlocked | undefined {
    const b = this.assigned.get(projectId)?.rotationBlocked
    return b ? { code: 'stale_rootfs_blocked', reason: b.reason, since: b.since } : undefined
  }

  /** When this host first saw each assigned VM on a superseded rootfs (see `rotateStale`). */
  private staleSince = new Map<string, number>()
  // `rotateRetryAt` and `rotationBlocked` live on the AssignedVm (and in its live
  // registry entry), not in maps: a restart used to reset them to "retry now",
  // which is why a rotation that could never succeed retried on every deploy —
  // ~12 times a day (SHO-584).

  /**
   * Record — and report once — that a VM cannot leave a superseded rootfs.
   * The alternative was a journal line every ten minutes and nothing else;
   * the status field is what the pool and Ops views read (SHO-541).
   */
  private markRotationBlocked(a: AssignedVm, reason: string): void {
    const prev = a.rotationBlocked
    if (prev && prev.reason === reason) return
    a.rotationBlocked = { reason, since: prev?.since ?? Date.now() }
    this.writeLive(a)
    metrics.inc(M.rotationBlocked)
    console.error(
      `[pool] stale_rootfs_blocked: ${a.projectId} is on a superseded rootfs and rotation cannot take it — ` +
        `${reason}. It stays on the old runtime until this is resolved.`,
    )
  }
  /** VMs already reported by the busy-idle ceiling, so a failed suspend logs once, not every pass. */
  private busyIdleCeilingLogged = new Set<string>()
  /**
   * The idle window the last reaper pass applied (see `idleWindowFor`): the
   * control plane's relaxed directive when it has one, else the aggressive
   * `METAL_IDLE_SUSPEND_MS`. `status()` reports each VM's `holdReason` against
   * it, so "why is this one still resident" answers against the window that
   * actually kept it, not the configured one.
   */
  private reapWindowMs?: number

  /**
   * Tear down a tracked VM: drop it from the assigned map + adopt-on-restart
   * registry, then stopVM to reclaim tap/socket/rootfs. Shared by the open()
   * liveness/health gate (dead FC process OR mute guest) and the dead-VM reaper.
   * For a mute guest the Firecracker process is still alive — stopVM kills it,
   * which is the intended self-heal once durability has a current copy.
   */
  private async discardDeadVm(a: AssignedVm, why: string): Promise<void> {
    this.closeMeter(a)
    this.assigned.delete(a.projectId)
    this.live.remove(a.projectId)
    await this.rescueWorkspace(a, why)
  }

  /**
   * Save a VM's workspace before it is thrown away. Everything since the last
   * suspend lives only on this VM (source is backed up at suspend; `.git` and
   * writable state every couple of minutes), so a plain stop is data loss.
   *
   *   1. Guest still running → ask it to export (bounded: a guest under memory
   *      pressure is often slow, not dead).
   *   2. Otherwise stop it WITHOUT releasing its disk, mount the rootfs
   *      read-only on the host, and pack `/app/workspace` directly.
   *   3. If that fails too, keep the disk in quarantine and alert. Never just
   *      release it: the next open would silently restore an older state.
   */
  protected async rescueWorkspace(a: AssignedVm, why: string): Promise<void> {
    if (this.mgr.isRunning(a.handle) && (await this.rescueFromGuest(a))) {
      metrics.inc(M.rescueGuest)
      console.log(`[pool] rescued ${a.projectId} via guest export before discard (${why})`)
      await this.mgr.stopVM(a.handle).catch(() => {})
      return
    }
    await this.mgr.stopVM(a.handle, { keepRootfs: true }).catch(() => {})
    if (!a.projectId.startsWith('ws:')) {
      try {
        if (await this.rescueFromDisk(a)) {
          metrics.inc(M.rescueDisk)
          console.log(`[pool] rescued ${a.projectId} from its disk before discard (${why})`)
          try { await this.mgr.releaseRootfs(a.handle.rootfs) } catch { /* GC reclaims it */ }
          if (a.handle.workspaceDrive) {
            try { this.mgr.releaseDataDrive(a.handle.workspaceDrive) } catch { /* GC reclaims it */ }
          }
          return
        }
      } catch (err: any) {
        console.error(`[pool] disk rescue failed for ${a.projectId}:`, err?.message ?? err)
      }
    }
    metrics.inc(M.rescueFailed)
    const label = `${a.projectId}-${Date.now()}`
    let kept: string | null = null
    // The workspace lives on the drive when there is one, so that is the disk
    // worth keeping; the rootfs is still kept for anything written outside it.
    let keptDrive: string | null = null
    if (a.handle.workspaceDrive) {
      try { keptDrive = this.mgr.quarantineWorkspaceDrive(a.handle.workspaceDrive, label) } catch { /* reported below */ }
    }
    try { kept = await this.mgr.quarantineRootfs(a.handle.rootfs, label) } catch { /* reported below */ }
    if (keptDrive && !kept) kept = keptDrive
    if (kept) {
      try {
        writeFileSync(
          `${kept}.json`,
          JSON.stringify({
            projectId: a.projectId,
            why,
            at: new Date().toISOString(),
            rootfsIdentity: this.bootRootfsIdentity(a),
            backupParentEtag: a.backupParentEtag,
            repoParentEtag: a.repoParentEtag,
            workspaceDrive: keptDrive ?? undefined,
          }),
        )
      } catch { /* the disk itself is what matters */ }
    }
    console.error(
      `[pool] RESCUE FAILED for ${a.projectId} (${why}) — its unsaved workspace is ONLY on ` +
        `${keptDrive ?? kept ?? `${a.handle.workspaceDrive ?? a.handle.rootfs} (quarantine failed; left in place)`}. ` +
        `Recover it before it is lost.`,
    )
  }

  private async rescueFromGuest(a: AssignedVm): Promise<boolean> {
    const bounded = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        Bun.sleep(this.cfg.rescueGuestTimeoutMs).then(() => {
          throw new Error(`guest export timed out after ${this.cfg.rescueGuestTimeoutMs}ms`)
        }),
      ])
    try {
      if (a.projectId.startsWith('ws:')) {
        await bounded(this.saveWorkspaceMembersToStore(a))
        await bounded(this.saveHomeStateToStore(a, { final: true })).catch((err: any) =>
          console.warn(`[pool] home-directory rescue for ${a.projectId} failed:`, err?.message ?? err),
        )
        return true
      }
      // `.git` first: it is small and, once git works, carries every commit.
      await bounded(this.saveRepoToStore(a))
      await bounded(this.saveBackupToStore(a))
      await bounded(this.saveProjectDataToStore(a, { final: true }))
      await bounded(this.saveHomeStateToStore(a, { final: true })).catch((err: any) =>
        console.warn(`[pool] home-directory rescue for ${a.projectId} failed:`, err?.message ?? err),
      )
      return true
    } catch (err: any) {
      console.warn(`[pool] guest export for ${a.projectId} failed, falling back to disk:`, err?.message ?? err)
      return false
    }
  }

  /** True when every artifact found on the disk is durable (written or quarantined). */
  private async rescueFromDisk(a: AssignedVm): Promise<boolean> {
    const outDir = mkdtempSync(join(this.cfg.runDir, 'rescue-out-'))
    try {
      const { source, repo } = await this.mgr.extractWorkspace(
        { rootfs: a.handle.rootfs, workspaceDrive: a.handle.workspaceDrive },
        outDir,
      )
      let ok = true
      if (repo) ok = (await this.storeRepoBytes(a, Bun.file(repo), null)) !== 'lost' && ok
      if (source) ok = (await this.storeSourceBytesFromDisk(a, source)) && ok
      return ok
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  }

  /**
   * Reap assigned VMs whose firecracker process has died. The idle reaper only
   * suspends VMs that have gone QUIET, but a dead VM under a continuous wake
   * poll never goes idle — every poll's assign/touch bumps `lastTouchedAt` — so
   * it lingers forever as a phantom "live" entry whose guest URL refuses every
   * connection (the "Unable to connect" 502 loop). This liveness sweep clears
   * such entries regardless of idle time so routing stops resolving to the dead
   * box; the control plane re-places / cold-boots on the next assign. Returns
   * the reaped projectIds so the caller can drop their DNAT forwards + report
   * the placement as gone. Driven by the reaper timer in server.ts.
   */
  async reapDeadAssigned(): Promise<string[]> {
    // A suspend stops the Firecracker process at the snapshot, before it drops
    // the entry from `assigned`; reaping in that window quarantined the disk
    // the suspend was about to upload. Whoever holds the flight owns the VM.
    const dead = [...this.assigned.values()].filter((a) => {
      if (this.mgr.isRunning(a.handle)) return false
      const busy = this.openFlight.has(a.projectId)
        ? 'open'
        : this.suspendFlight.has(a.projectId)
          ? 'suspend'
          : this.recycleFlight.has(a.projectId)
            ? 'recycle'
            : null
      if (busy) console.log(`[pool] dead-VM sweep: leaving ${a.projectId} to its in-flight ${busy}`)
      return !busy
    })
    const reaped: string[] = []
    for (const a of dead) {
      console.warn(`[pool] reaping dead assigned VM ${a.handle.id} for ${a.projectId} (fc process gone)`)
      await this.discardDeadVm(a, 'reaper: fc process gone')
      reaped.push(a.projectId)
    }
    return reaped
  }

  getAssigned(projectId: string): AssignedVm | undefined {
    return this.assigned.get(projectId)
  }

  /**
   * Grow this VM's workspace drive to `targetMiB` live, with the guest frozen
   * (SHO-349). Serialized per VM: two grows of the same drive at once would
   * interleave freeze/thaw.
   *
   *   guest freeze → host ftruncate → PATCH /drives → guest thaw → resize2fs
   *
   * A no-op (`'unchanged'`) when the drive is already at least that big, so it
   * is safe to call on every open. `'unsupported'` when this host runs without a
   * workspace drive (`METAL_WORKSPACE_DRIVE_MIB=0`) or the guest predates the
   * endpoint — neither is an error.
   */
  async ensureWorkspaceDriveSize(a: AssignedVm, targetMiB: number): Promise<DriveResizeResult> {
    if (!this.cfg.workspaceDriveMiB || this.cfg.workspaceDriveMiB <= 0) return 'unsupported'
    const path = a.handle.workspaceDrive
    if (!path || !this.driveProvisioner.exists(path)) return 'unsupported'
    const cap =
      this.cfg.workspaceDriveMaxMiB > 0 ? this.cfg.workspaceDriveMaxMiB : this.cfg.workspaceDriveMiB
    const target = Math.min(Math.floor(targetMiB), cap)
    if (!(target > 0)) return 'unchanged'
    const fromMiB = this.driveProvisioner.sizeMiB(path)
    if (fromMiB >= target) {
      // The file is already big enough — but the guest may never have seen it.
      // A grow whose PATCH /drives failed (SHO-401) leaves the file grown and
      // the guest at the old size, and every later open would otherwise answer
      // 'unchanged' forever. Compare against what the guest actually mounts and
      // converge when it is clearly behind.
      const guest = await this.guestDriveUsage(a)
      if (!guest) return 'unchanged'
      const guestMiB = Math.floor(guest.totalBytes / (1024 * 1024))
      if (!this.guestIsBehind(fromMiB, guestMiB)) return 'unchanged'
      return this.driveLock.run(a.handle.id, async () => {
        const currentFile = this.driveProvisioner.sizeMiB(path)
        const nowGuest = await this.guestDriveUsage(a)
        if (!nowGuest) return 'unchanged'
        const nowGuestMiB = Math.floor(nowGuest.totalBytes / (1024 * 1024))
        if (!this.guestIsBehind(currentFile, nowGuestMiB)) return 'unchanged'

        const t0 = Date.now()
        let frozen = false
        try {
          const freeze = await this.guestDriveOp(a, 'freeze')
          if (freeze === 'unsupported') {
            console.warn(`[pool] guest for ${a.projectId} has no /pool/workspace-drive — not converging the drive`)
            return 'unsupported'
          }
          frozen = true
          // No ftruncate: the file is already the right size. Just tell the VM
          // its backing file changed, then let it resize the filesystem.
          await new FcApi(a.handle.socketPath).patchDrive('workspace', path)
          await this.guestDriveOp(a, 'thaw')
          frozen = false
          await this.guestDriveOp(a, 'resize')
          metrics.inc(`${M.workspaceDriveGrow}{result="converged"}`)
          metrics.gauge(M.workspaceDriveGrowMs, Date.now() - t0)
          console.log(
            `[pool] converged workspace drive for ${a.projectId} ${nowGuestMiB}MiB → ${currentFile}MiB ` +
              `(guest was behind the file, ${Date.now() - t0}ms)`,
          )
          return { fromMiB: nowGuestMiB, toMiB: currentFile }
        } catch (err: any) {
          metrics.inc(`${M.workspaceDriveGrow}{result="error"}`)
          console.error(
            `[pool] workspace-drive converge for ${a.projectId} to ${currentFile}MiB failed:`,
            err?.message ?? err,
          )
          throw err
        } finally {
          if (frozen) {
            await this.guestDriveOp(a, 'thaw').catch(() => {})
          }
        }
      })
    }

    return this.driveLock.run(a.handle.id, async () => {
      // Re-read inside the lock: a queued grow may have already done the work.
      const current = this.driveProvisioner.sizeMiB(path)
      if (current >= target) return 'unchanged'

      const t0 = Date.now()
      let frozen = false
      try {
        const freeze = await this.guestDriveOp(a, 'freeze')
        if (freeze === 'unsupported') {
          console.warn(`[pool] guest for ${a.projectId} has no /pool/workspace-drive — not growing the drive`)
          return 'unsupported'
        }
        frozen = true
        const grew = this.driveProvisioner.grow(path, target)
        if (!grew) return 'unchanged'
        // Tell the running VM its backing file changed. Only legal while the
        // device is idle, which is exactly what the freeze above buys us.
        await new FcApi(a.handle.socketPath).patchDrive('workspace', path)
        await this.guestDriveOp(a, 'thaw')
        frozen = false
        await this.guestDriveOp(a, 'resize')
        const toMiB = this.driveProvisioner.sizeMiB(path)
        metrics.inc(`${M.workspaceDriveGrow}{result="ok"}`)
        metrics.gauge(M.workspaceDriveGrowMs, Date.now() - t0)
        console.log(
          `[pool] grew workspace drive for ${a.projectId} ${grew.fromMiB}MiB → ${grew.toMiB}MiB ` +
            `(file reads ${toMiB}MiB, ${Date.now() - t0}ms)`,
        )
        return { fromMiB: grew.fromMiB, toMiB: grew.toMiB }
      } catch (err: any) {
        metrics.inc(`${M.workspaceDriveGrow}{result="error"}`)
        console.error(
          `[pool] workspace-drive grow for ${a.projectId} to ${target}MiB failed:`,
          err?.message ?? err,
        )
        throw err
      } finally {
        // Never leave the guest's filesystem frozen: a hung freeze means every
        // write in the project blocks forever.
        if (frozen) {
          await this.guestDriveOp(a, 'thaw').catch(() => {})
        }
      }
    })
  }

  /**
   * True when the guest's mounted filesystem is clearly smaller than the
   * backing file — i.e. a grow the VM never saw. ext4 metadata makes the guest
   * total a little under the file size, so only a shortfall of more than 5% or
   * 1 GiB counts (SHO-401).
   */
  private guestIsBehind(fileMiB: number, guestMiB: number): boolean {
    const shortMiB = fileMiB - guestMiB
    return shortMiB > Math.max(0.05 * fileMiB, 1024)
  }

  /** GET /pool/workspace-drive on the guest — the size the VM actually mounts. */
  private async guestDriveUsage(
    a: AssignedVm,
  ): Promise<{ usedBytes: number; totalBytes: number } | null> {
    try {
      const res = await fetch(`${a.handle.agentUrl}/pool/workspace-drive`, {
        headers: { ...(a.runtimeToken ? { Authorization: `Bearer ${a.runtimeToken}` } : {}) },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      const body = (await res.json().catch(() => ({}))) as { usedBytes?: number; totalBytes?: number }
      if (typeof body.usedBytes !== 'number' || typeof body.totalBytes !== 'number') return null
      return { usedBytes: body.usedBytes, totalBytes: body.totalBytes }
    } catch {
      return null
    }
  }

  /** POST /pool/workspace-drive on the guest. `'unsupported'` on 404/409. */
  private async guestDriveOp(
    a: AssignedVm,
    op: 'freeze' | 'thaw' | 'resize',
  ): Promise<'ok' | 'unsupported'> {
    const res = await fetch(`${a.handle.agentUrl}/pool/workspace-drive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(a.runtimeToken ? { Authorization: `Bearer ${a.runtimeToken}` } : {}),
      },
      body: JSON.stringify({ op }),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status === 404 || res.status === 409) return 'unsupported'
    if (!res.ok) throw new Error(`/pool/workspace-drive ${op} failed (${res.status}): ${await res.text()}`)
    return 'ok'
  }

  /**
   * Apply a live instance-tier change to an assigned project. Firecracker can't
   * hot-change vCPU/RAM, so those take effect on the NEXT cold boot/resume (the
   * assign env is re-read then). What we CAN apply immediately is the always-on
   * flag: an upgrade (alwaysOn=true) makes the reaper skip this VM right away, a
   * downgrade re-arms idle-suspend. No-op when the project isn't live on this
   * host. Returns true when a live VM was updated.
   */
  async applyResize(
    projectId: string,
    opts: { alwaysOn?: boolean; workspaceDriveMiB?: number },
  ): Promise<{ applied: boolean; alwaysOn?: boolean; disk: DriveResizeResult }> {
    const a = this.assigned.get(projectId)
    if (!a) return { applied: false, disk: 'unsupported' }
    if (opts.alwaysOn !== undefined && !!a.alwaysOn !== opts.alwaysOn) {
      a.alwaysOn = opts.alwaysOn
      this.writeLive(a)
    }
    let disk: DriveResizeResult = 'unchanged'
    if (opts.workspaceDriveMiB !== undefined) {
      try {
        disk = await this.ensureWorkspaceDriveSize(a, opts.workspaceDriveMiB)
      } catch (err: any) {
        // A failed grow must not fail the tier change: always-on still applied,
        // and the next open re-asserts the size (and retries the grow).
        console.warn(`[pool] resize: workspace-drive grow for ${projectId} failed:`, err?.message ?? err)
        disk = 'unsupported'
      }
    }
    return { applied: true, alwaysOn: !!a.alwaysOn, disk }
  }

  // --- GC / cache management ------------------------------------------------

  /** Bytes a suspended snapshot occupies on local NVMe (CoW-aware rootfs). */
  private entryBytes(s: SuspendedVm): number {
    return (s.snapshot.bytesMem ?? 0) + (s.snapshot.bytesState ?? 0) + (s.snapshot.bytesRootfs ?? 0)
  }

  private cacheBytes(): number {
    let n = 0
    for (const s of this.suspended.values()) n += this.entryBytes(s)
    for (const s of this.stagedSuspended.values()) n += this.entryBytes(s)
    return n
  }

  disk(): DiskUsage {
    return diskUsage(this.cfg.work)
  }

  /**
   * The full GC sweep: reclaim orphaned files, then (if over the high watermark
   * or the byte cap, or forced) evict least-recently-used durably-backed
   * suspended snapshots down to the low watermark. Never touches running VMs,
   * never evicts an un-backed snapshot, never evicts an in-flight project.
   */
  async gcSweep(opts: { force?: boolean } = {}): Promise<GcReport> {
    metrics.inc(M.gcRuns)
    const orphansRemoved = await this.reclaimOrphans()
    const staleReclaim = await this.reclaimStaleSnapshots()

    const disk = this.disk()
    const evict: string[] = []
    const durableRemoved: string[] = []
    let bytesReclaimed = 0

    const canEvictDurably = this.store.kind !== 'none'
    const candidates: EvictionCandidate[] = [...this.suspended.values()].map((s) => ({
      projectId: s.projectId,
      bytes: this.entryBytes(s),
      lastAccessAt: s.lastAccessAt,
      // With no durable store we must not evict live snapshots (only orphans).
      durableBacked: canEvictDurably,
      inFlight: this.openFlight.has(s.projectId) || this.suspendFlight.has(s.projectId),
    }))

    const decision = planEvictions({
      usedBytes: disk.usedBytes,
      totalBytes: disk.totalBytes,
      cacheBytes: this.cacheBytes(),
      candidates,
      highPct: this.cfg.diskHighPct,
      lowPct: this.cfg.diskLowPct,
      cacheMaxBytes: this.cfg.cacheMaxBytes,
      force: opts.force,
    })

    // Under pressure, pre-warmed snapshots go first: they are only an
    // optimisation for the next switch, and losing one costs a cold boot later.
    if (decision.triggered) {
      for (const s of [...this.stagedSuspended.values()]) {
        if (this.openFlight.has(s.projectId) || this.suspendFlight.has(s.projectId)) continue
        bytesReclaimed += this.entryBytes(s)
        await this.dropStaged(s.projectId)
      }
    }

    for (const projectId of decision.evict) {
      const s = this.suspended.get(projectId)
      if (!s) continue
      // Durable-tiering: a project that's been cold longer than the active
      // window loses its live-RAM durable snapshot too (falls back to cold
      // boot from git/S3 workspace), keeping the durable tier small.
      const stale = Date.now() - s.lastAccessAt > this.cfg.durableActiveWindowMs
      const bytes = this.entryBytes(s)
      const ok = await this.evictForGc(projectId, { alsoDurable: stale })
      if (!ok) continue
      evict.push(projectId)
      bytesReclaimed += bytes
      if (stale && this.store.kind !== 'none') durableRemoved.push(projectId)
    }

    bytesReclaimed += staleReclaim.bytes

    metrics.inc(M.gcEvicted, evict.length)
    metrics.inc(M.gcBytesReclaimed, bytesReclaimed)
    metrics.inc(M.gcOrphansRemoved, orphansRemoved)
    metrics.inc(M.gcDurableRemoved, durableRemoved.length)
    metrics.inc(M.gcStaleReclaimed, staleReclaim.projectIds.length)
    this.publishGauges()

    const after = this.disk()
    if (evict.length || orphansRemoved || staleReclaim.projectIds.length) {
      console.log(
        `[pool] gc: evicted=${evict.length} durableDropped=${durableRemoved.length} orphans=${orphansRemoved} ` +
          `staleReclaimed=${staleReclaim.projectIds.length} reclaimed=${(bytesReclaimed / 1e9).toFixed(2)}GB used=${after.usedPct.toFixed(1)}%`,
      )
    }
    return {
      triggered: decision.triggered,
      evicted: evict,
      durableRemoved,
      staleReclaimed: staleReclaim.projectIds,
      orphansRemoved,
      bytesReclaimed,
      disk: after,
    }
  }

  /**
   * Drop locally-cached snapshots that this host can never restore, because
   * they were taken against a different golden rootfs.
   *
   * `resume()` already refuses these one at a time, so nothing here changes
   * what a project does on open — it only stops the corpse from occupying the
   * disk until someone happens to open that particular project. Until now the
   * only other path out was the LRU sweep, which ranks them by last access
   * alongside snapshots that still work: a rootfs rebuild therefore stranded
   * the entire cache, and it drained a project at a time as users returned.
   * Measured across the four production hosts, roughly 90% of every cache was
   * in this state — about 15.9 TB that could not have served a single wake.
   *
   * Only the LOCAL copy goes. The durable store keeps its own identity gate in
   * `pull()`, and dropping S3 objects is a different decision with a different
   * blast radius (`durableActiveWindowMs` owns that one).
   *
   * Bounded per sweep, following `reconcileOrphanDevices`, AND yielding between
   * entries. Dropping one entry is expensive and entirely synchronous — a
   * multi-gigabyte memory file to unlink, then `dmsetup remove --retry`, the
   * loop detach and the tap teardown, each a subprocess — which measured around
   * 180ms on a production host. Taking a batch of 100 straight through therefore
   * pinned the single-threaded agent for up to 18 SECONDS, past every timeout
   * the control plane uses (5s), so opens and heartbeats had to wait behind a
   * disk cleanup. Yielding turns that into ~180ms of latency at worst while
   * draining at the same overall rate.
   *
   * The guard keeps one drain in flight: the sweep timer keeps firing during a
   * long drain, and a second pass over the same entries would be wasted work.
   *
   * One extra skip while a post-activation watch is open (SHO-552): a snapshot
   * taken against the generation we just replaced is exactly what a rollback
   * needs, and reclaiming it would leave a rollback that boots every project
   * cold — or, worse, one that "succeeds" and loses the home states. The watch
   * ends in 15 minutes and normal reclaim resumes; nothing is lost by waiting.
   */
  private async reclaimStaleSnapshots(
    max = STALE_RECLAIM_PER_SWEEP,
  ): Promise<{ projectIds: string[]; bytes: number }> {
    const projectIds: string[] = []
    let bytes = 0
    if (this.staleReclaimRunning) return { projectIds, bytes }
    this.staleReclaimRunning = true
    try {
      // Read once per sweep: one agentDir read pair, not one per snapshot.
      const rollbackTargets = this.rollbackSnapshotIdentities()
      // Snapshot the ids: we await inside the loop, so the live map may gain a
      // freshly-suspended entry underneath us. Anything new is next sweep's.
      for (const id of [...this.suspended.keys()]) {
        if (projectIds.length >= max) break
        // Re-read rather than trust the snapshot — during the awaits this
        // project may have woken and re-suspended onto the CURRENT rootfs.
        const s = this.suspended.get(id)
        if (!s || !this.localSnapshotIsStale(s)) continue
        if (s.rootfsIdentity && rollbackTargets.has(s.rootfsIdentity)) continue
        // Never race the paths that own the entry: a running VM is not suspended
        // at all, and an in-flight open is already deciding this snapshot's fate.
        if (this.assigned.has(id)) continue
        if (this.openFlight.has(id) || this.suspendFlight.has(id) || this.recycleFlight.has(id)) continue
        const b = this.entryBytes(s)
        if (!(await this.evictLocal(id))) continue
        projectIds.push(id)
        bytes += b
        await yieldToEventLoop()
      }
    } finally {
      this.staleReclaimRunning = false
    }
    return { projectIds, bytes }
  }

  /**
   * Guarded eviction of a suspended snapshot's local files. Safe only when a
   * durable copy exists (verified fresh) — else the local copy is the only one
   * and we'd lose it. Optionally also removes the durable copy (durable tiering).
   */
  async evictForGc(projectId: string, opts: { alsoDurable?: boolean } = {}): Promise<boolean> {
    const s = this.suspended.get(projectId)
    if (!s) return false
    if (this.assigned.has(projectId)) return false // running — never evict
    if (this.openFlight.has(projectId) || this.suspendFlight.has(projectId) || this.recycleFlight.has(projectId)) {
      return false // in-flight
    }

    if (!opts.alsoDurable) {
      // Must be durably backed & fresh before we drop the only local copy.
      if (this.store.kind === 'none') return false
      const head = await this.store.head(projectId)
      if (!head || head.rootfsIdentity !== this.classRootfsIdentity(head.vmClass ?? 'standard')) return false
    }

    await this.deleteLocalArtifacts(s.snapshot)
    this.suspended.delete(projectId)
    this.index.remove(projectId)

    if (opts.alsoDurable && this.store.kind !== 'none') {
      await this.store.remove(projectId).catch(() => {})
    }
    return true
  }

  private async deleteLocalArtifacts(snap: FcSnapshot): Promise<void> {
    for (const p of [snap.snapshotPath, snap.memFilePath]) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* ignore */
      }
    }
    // rootfs may be a dm device / cow file — route through the manager so dm
    // resources are torn down correctly. Awaited: `dmsetup remove --retry` is a
    // child process now, and jumping to the next boot's work before it finishes
    // is what starves the socket waiter this whole path was blocking.
    try {
      await this.mgr.releaseRootfs(snap.rootfs)
    } catch {
      /* ignore */
    }
    for (const drive of [snap.dataDrive, snap.workspaceDrive]) {
      if (!drive) continue
      try {
        this.mgr.releaseDataDrive(drive)
      } catch {
        /* ignore */
      }
    }
    // Release the /30 as well. A suspended VM keeps its tap so it can restore
    // onto the same device cheaply, which means dropping the snapshot is the
    // moment that device stops being wanted — and every caller here (eviction,
    // stale reclaim, destroy) previously leaked it. Guarded because a resumed
    // project can still carry a `suspended` entry pointing at the net its LIVE
    // VM restored onto; tearing that down would cut a running guest's network.
    if (!this.tapHeldByRunningVm(snap.net)) {
      try {
        await this.mgr.releaseTap(snap.net)
      } catch {
        /* best-effort; the GC sweep retries from the host side */
      }
    }
  }

  /** Is a warm/assigned (running) VM currently attached to this /30's device? */
  private tapHeldByRunningVm(net: VmNet): boolean {
    const n = tapIndex(net)
    if (n === null) return false
    for (const vm of this.available) if (tapIndex(vm.handle.net) === n) return true
    for (const a of this.assigned.values()) if (tapIndex(a.handle.net) === n) return true
    return false
  }

  /**
   * Delete snapshot/rootfs files that no running VM or cache entry references.
   * These accrue when a project is re-suspended (new VM id → new files, old
   * ones orphaned) or when the index and disk drift. Files backing a running
   * VM's memory mapping or a live cache entry are protected.
   */
  async reclaimOrphans(): Promise<number> {
    const protectedPaths = new Set<string>()
    for (const vm of this.available) {
      protectedPaths.add(vm.handle.rootfs)
      if (vm.handle.dataDrive) protectedPaths.add(vm.handle.dataDrive)
      if (vm.handle.workspaceDrive) protectedPaths.add(vm.handle.workspaceDrive)
    }
    for (const a of this.assigned.values()) {
      protectedPaths.add(a.handle.rootfs)
      if (a.handle.dataDrive) protectedPaths.add(a.handle.dataDrive)
      if (a.handle.workspaceDrive) protectedPaths.add(a.handle.workspaceDrive)
      // A suspend-in-flight writes vmstate/mem to deterministic paths derived
      // from the handle id BEFORE the project lands in `suspended`. Protect
      // those prospective artifacts so a concurrent sweep can't delete a
      // snapshot mid-CreateSnapshot (which would push a torn set durably).
      protectedPaths.add(join(this.cfg.snapDir, `${a.handle.id}.vmstate`))
      protectedPaths.add(join(this.cfg.snapDir, `${a.handle.id}.mem`))
      if (a.restoredFrom) {
        protectedPaths.add(a.restoredFrom.vmstate)
        protectedPaths.add(a.restoredFrom.mem)
      }
    }
    for (const s of [...this.suspended.values(), ...this.stagedSuspended.values()]) {
      protectedPaths.add(s.snapshot.snapshotPath)
      protectedPaths.add(s.snapshot.memFilePath)
      protectedPaths.add(s.snapshot.rootfs)
      if (s.snapshot.dataDrive) protectedPaths.add(s.snapshot.dataDrive)
      if (s.snapshot.workspaceDrive) protectedPaths.add(s.snapshot.workspaceDrive)
    }

    // A cold boot creates a VM's rootfs/CoW, then boots + configures it, and
    // only THEN records it in `assigned`; a suspend snapshots to disk before
    // recording in `suspended`. In those in-flight windows the artifacts belong
    // to no map yet, so a map-only guard would delete a live VM's files
    // mid-flight (the root cause of "artifact missing/empty" torn pushes). A
    // genuine orphan (from a re-suspend's superseded vmId, or index/disk drift)
    // is by definition NOT being written right now, so an age gate reliably
    // separates the two: never reap anything younger than the longest possible
    // boot+assign, regardless of which map does or doesn't reference it.
    const cutoff = Date.now() - ORPHAN_GRACE_MS
    let removed = 0
    const sweepDir = async (
      dir: string,
      match: (name: string) => boolean,
      kind: 'plain' | 'rootfs' | 'dataDrive' = 'plain',
    ): Promise<void> => {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        if (!match(name)) continue
        const full = join(dir, name)
        if (protectedPaths.has(full)) continue
        // dm mode: a CoW store file is a genuine orphan ONLY when its mapper
        // device is gone. While the device is mapped the VM is live — running,
        // suspended-in-place, OR claimed mid-assign (in neither `available` nor
        // `assigned` during the /pool/assign await, with a CoW mtime already
        // past the age gate). Relying on the in-memory maps alone unlinked that
        // live CoW, which then broke both the durable push ("rootfs
        // missing/empty") and the local resume ("dm CoW store missing") and
        // forced a cold boot. The device check closes that gap definitively.
        if (kind === 'rootfs' && this.cfg.rootfsCow === 'dm') {
          const vmId = name.replace(/\.cow$/, '')
          if (protectedPaths.has(`/dev/mapper/mvm-${vmId}`)) continue
          if (await this.mgr.rootfsDeviceMapped(vmId)) continue
        }
        // Age gate: skip artifacts still within the in-flight grace window.
        try {
          if (statSync(full).mtimeMs > cutoff) continue
        } catch {
          continue // vanished under us — nothing to reclaim
        }
        try {
          if (kind === 'rootfs') await this.mgr.releaseRootfs(full)
          else if (kind === 'dataDrive') this.mgr.releaseDataDrive(full)
          else rmSync(full, { force: true })
          removed++
        } catch {
          /* ignore */
        }
      }
    }

    await sweepDir(this.cfg.snapDir, (n) => n.endsWith('.vmstate') || n.endsWith('.mem'))
    await sweepDir(this.cfg.runDir, (n) => n.endsWith('.rootfs.ext4'), 'rootfs')
    // Docker-class second data drive — no shared base, so it's always a plain
    // file regardless of rootfsCow mode (see data-drive.ts).
    await sweepDir(this.cfg.runDir, (n) => n.endsWith('.data.ext4'), 'dataDrive')
    await sweepDir(this.cfg.runDir, (n) => n.endsWith(WORKSPACE_DRIVE_SUFFIX), 'dataDrive')
    if (this.cfg.rootfsCow === 'dm') await sweepDir(this.cfg.dmCowDir, (n) => n.endsWith('.cow'), 'rootfs')
    return removed
  }

  /** Handle ids the pool still tracks a live FC process for (warm + assigned +
   * in-flight). Suspended VMs have no process (killed at snapshot). */
  private liveHandleIds(): Set<string> {
    const ids = new Set<string>(this.inFlight)
    for (const vm of this.available) ids.add(vm.handle.id)
    for (const a of this.assigned.values()) ids.add(a.handle.id)
    return ids
  }

  /**
   * Kill firecracker processes not referenced by any live VM — the safety net
   * for the churn leak. Driven by the reaper timer in server.ts. Returns the
   * number reaped (normally 0 now that every failure path stops its own VM).
   */
  reapOrphanProcs(): number {
    return this.mgr.reapOrphans(this.liveHandleIds())
  }

  /**
   * dm-device vmIds the pool still owns — the rootfs device behind every warm,
   * assigned, and suspended VM (plus any restored-from CoW). Keyed off the rootfs
   * PATH, not the handle id: a restored VM's handle id (`fcr-…`) differs from the
   * device it reuses (`mvm-fcvm-…`), so only the path identifies the real device.
   */
  private ownedRootfsVmIds(): Set<string> {
    const ids = new Set<string>()
    const add = (rootfs?: string): void => {
      if (rootfs && rootfs.startsWith('/dev/mapper/mvm-')) ids.add(rootfs.slice('/dev/mapper/mvm-'.length))
    }
    for (const vm of this.available) add(vm.handle.rootfs)
    for (const a of this.assigned.values()) add(a.handle.rootfs)
    for (const s of this.suspended.values()) add(s.snapshot.rootfs)
    for (const s of this.stagedSuspended.values()) add(s.snapshot.rootfs)
    return ids
  }

  /**
   * Reclaim leaked dm devices / loops / CoW files that belong to no VM the pool
   * tracks — the catch-up net for teardown races (a failed "busy" `dmsetup
   * remove` orphaned the device, which then pinned its CoW past the GC's sweep).
   * Bounded per call; driven by the GC timer. Returns the number reclaimed.
   */
  async reconcileOrphanDevices(): Promise<number> {
    if (this.cfg.rootfsCow !== 'dm') return 0
    return this.mgr.reconcileOrphanRootfs(this.ownedRootfsVmIds(), ORPHAN_GRACE_MS)
  }

  /**
   * Tap indices this host legitimately owns: every warm and assigned VM (running,
   * fd attached) plus every suspended one. A suspended VM has no process, so only
   * this set stands between its device and the sweep — and while `restoreVM` would
   * recreate the device anyway, the index must stay claimed: hand it to a fresh VM
   * and the resume's `setupTap` deletes-then-recreates the device underneath that
   * live guest ("Failed to write to tap: File descriptor in bad state").
   *
   * A VM mid-cold-boot is absent from all three — the manager's own reservation
   * window and the NO-CARRIER check cover that gap.
   */
  private ownedTapIndices(): Set<number> {
    const idx = new Set<number>()
    const add = (net?: VmNet): void => {
      const n = net ? tapIndex(net) : null
      if (n !== null) idx.add(n)
    }
    for (const vm of this.available) add(vm.handle.net)
    for (const a of this.assigned.values()) add(a.handle.net)
    for (const s of this.suspended.values()) add(s.snapshot.net)
    for (const s of this.stagedSuspended.values()) add(s.snapshot.net)
    return idx
  }

  /**
   * How much of the host's /30 space is occupied, straight from `ip link` rather
   * than the GC's last sweep — so it is still the truth on a host with the GC
   * turned off, which is exactly where a leak would run unchecked.
   */
  async tapUsage(): Promise<{ inUse: number; capacity: number }> {
    return { inUse: (await existingTapIndices()).size, capacity: TAP_NET_CAPACITY }
  }

  /**
   * Reclaim leaked `fctap<n>` devices (see
   * FirecrackerVMManager.reconcileOrphanTaps). Driven by the GC timer. Returns
   * the number reclaimed.
   *
   * This is the counterpart to the allocator's wrap-and-skip fix: that stopped a
   * full address space from producing invalid IPs, this stops it from filling up
   * in the first place. Without it a host degrades invisibly — every removed VM
   * that didn't go through `stopVM` keeps its four addresses, and the only
   * symptom is that spawns get slower to find a free index until there are none.
   */
  async reapOrphanTaps(): Promise<number> {
    const { removed, suspected, inUse } = await this.mgr.reconcileOrphanTaps(
      this.ownedTapIndices(),
      ORPHAN_GRACE_MS,
    )
    if (removed) {
      metrics.inc(M.gcTapsReclaimed, removed)
      console.warn(`[pool] reclaimed ${removed} leaked tap device(s) (${suspected} suspected this sweep)`)
    }
    metrics.gauge(M.tapsInUse, inUse)
    metrics.gauge(M.tapCapacity, TAP_NET_CAPACITY)
    metrics.gauge(M.tapUsedPct, +((inUse / TAP_NET_CAPACITY) * 100).toFixed(2))
    // The address space filling up is what took production down, and it does so
    // silently: nothing fails until the very last /30 is gone. Say so early.
    if (inUse > TAP_NET_CAPACITY * 0.8) {
      console.error(
        `[pool] tap address space ${inUse}/${TAP_NET_CAPACITY} in use — new VMs will fail to get a /30 when full`,
      )
    }
    return removed
  }

  private publishGauges(): void {
    // The agent's own memory (SHO-593): a control-plane burst that reaches
    // tens of GiB has to be visible on a dashboard before it is visible in
    // dmesg. `arrayBuffers` is the one that names a buffered export or S3 read.
    const own = memProbe.read()
    metrics.gauge(M.agentRssBytes, own.rss)
    metrics.gauge(M.agentExternalBytes, own.external)
    metrics.gauge(M.agentArrayBuffersBytes, own.arrayBuffers)
    // How much of the export budget is spoken for, and how long exports queued
    // for it: the pair that says whether the bound is costing latency (SHO-593).
    metrics.gauge(M.exportInflightBytes, this.exportBudget.inUse)
    metrics.gauge(M.exportBudgetWaitMs, Math.round(this.exportBudget.waitedMs))
    const disk = this.disk()
    metrics.gauge(M.diskUsedPct, +disk.usedPct.toFixed(2))
    metrics.gauge(M.diskFreeBytes, disk.freeBytes)
    metrics.gauge(M.cacheLocalCount, this.suspended.size)
    metrics.gauge(M.cacheLocalBytes, this.cacheBytes())
    metrics.gauge(M.assignedCount, this.assigned.size)
    const cls = this.classifyAssigned()
    metrics.gauge(M.assignedAppActive, cls.appActive)
    metrics.gauge(M.assignedAgentActive, cls.agentActive)
    metrics.gauge(M.assignedIdleTail, cls.idleTail)
    metrics.gauge(M.assignedUnhealthy, cls.unhealthy)
    metrics.gauge(M.assignedActive, cls.active)
    metrics.gauge(M.assignedEvictable, cls.evictable)

    // Git durability (SHO-442): how many VMs cannot save, how long the oldest
    // has been that way, and the worst unsaved age. These are the numbers the
    // alert reads — the incident ran for a day and a half with none of them.
    const now = Date.now()
    let untrusted = 0
    let oldestUntrustedSec = 0
    let worstUnsavedSec = 0
    for (const a of this.assigned.values()) {
      if (a.repoUntrustedReason) {
        untrusted++
        oldestUntrustedSec = Math.max(oldestUntrustedSec, Math.round((now - (a.repoLastSavedAt ?? a.assignedAt)) / 1000))
      }
      worstUnsavedSec = Math.max(worstUnsavedSec, this.repoUnsavedSeconds(a, now))
    }
    metrics.gauge(M.repoUntrustedVms, untrusted)
    metrics.gauge(M.repoUntrustedOldestSec, oldestUntrustedSec)
    metrics.gauge(M.repoUnsavedSeconds, worstUnsavedSec)

    // Writable-state durability (SHO-541). A database that cannot be
    // snapshotted is a project with no backup at all, and until these existed
    // the only trace of it was one 500 line per export cycle.
    let snapshotFailing = 0
    let oldestSnapshotFailingSec = 0
    for (const a of this.assigned.values()) {
      const f = a.dataSnapshotFailure
      if (!f) continue
      snapshotFailing++
      oldestSnapshotFailingSec = Math.max(oldestSnapshotFailingSec, Math.round((now - f.since) / 1000))
    }
    metrics.gauge(M.dataSnapshotFailedVms, snapshotFailing)
    metrics.gauge(M.dataSnapshotFailedOldestSec, oldestSnapshotFailingSec)
    metrics.gauge(M.rotationBlockedVms, [...this.assigned.values()].filter((v) => v.rotationBlocked).length)

    // Idle reclaim + host memory (SHO-534). Emitted BEFORE the dm-only early
    // return below, because a reflink host (every prod host today) is exactly
    // where the density question is asked, and it has no CoW store to sample.
    let balloonedVms = 0
    for (const a of this.assigned.values()) {
      if (a.balloonedMiB === undefined) continue
      balloonedVms++
    }
    metrics.gauge(M.idleReclaimedVms, balloonedVms)
    const mem = this.hostMemoryNow()
    if (mem) {
      metrics.gauge(M.hostMemAvailableMiB, mem.availableMiB)
      metrics.gauge(M.hostMemUsedMiB, Math.max(0, mem.totalMiB - mem.availableMiB))
    }
    const ksm = this.hostKsmNow()
    if (ksm) {
      metrics.gauge(M.ksmPagesSharing, ksm.pagesSharing)
      metrics.gauge(M.ksmPagesShared, ksm.pagesShared)
      metrics.gauge(M.ksmFullScans, ksm.fullScans)
      if (ksm.ksmdCpuPct !== undefined) metrics.gauge(M.ksmdCpuPct, ksm.ksmdCpuPct)
      if (ksm.ksmdCpuWindowMs !== undefined) {
        metrics.gauge(M.ksmdCpuWindowMs, ksm.ksmdCpuWindowMs)
      }
    }

    // Only dm mode has exception stores to run out of; the other rootfs modes
    // give each VM its own file and fail with an ordinary ENOSPC. Sampled off
    // the hot path (it reads `dmsetup status`): a gauge is state, so one poll
    // interval of lag costs nothing and `publishGauges` stays synchronous for
    // its callers in status()/gcSweep().
    if (this.cfg.rootfsCow !== 'dm') return
    void this.publishCowGauges()
  }

  private async publishCowGauges(): Promise<void> {
    const cow = await this.mgr.sampleCowUsage().catch(() => null)
    if (!cow) return
    metrics.gauge(M.cowInvalid, cow.invalid)
    metrics.gauge(M.cowMaxUsedPct, +cow.maxUsedPct.toFixed(2))
    metrics.gauge(M.cowNearLimit, cow.nearLimit)
    if (cow.invalid > this.lastCowInvalid) {
      // Worth a line in the journal as well as a gauge: by the time anyone
      // reads the graph the VM is long gone, and this is the only record that
      // its rootfs died rather than the guest crashing on its own.
      console.error(
        `[pool] ${cow.invalid} dm CoW store(s) invalidated by the kernel — those VMs cannot ` +
          `write to their root device and must be recycled`,
      )
    }
    this.lastCowInvalid = cow.invalid
  }

  /**
   * Decompose the assigned (running) set by liveness class for the fleet
   * gauges, using exactly {@link vmLiveness}: `agentActive` for a streamed turn
   * in flight or a recent agent request, `appActive` for end-user app traffic
   * within {@link ACTIVITY_WINDOW_MS}, `idleTail` otherwise (running but neither
   * being used nor edited — the idle-suspend tail). agent-active wins when a VM
   * is both, so the buckets are disjoint and sum to `assigned.size`.
   *
   * `active` / `evictable` are the OTHER decomposition of the same set (see
   * {@link vmResidency}): whether the VM is holding a slot someone needs, or is
   * only warm. They are disjoint and also sum to `assigned.size`, and they are
   * what the control plane counts as capacity — an idle-resident VM is free
   * room, not demand.
   */
  private classifyAssigned(
    now = Date.now(),
  ): {
    appActive: number
    agentActive: number
    idleTail: number
    unhealthy: number
    active: number
    evictable: number
  } {
    let appActive = 0
    let agentActive = 0
    let idleTail = 0
    let unhealthy = 0
    let active = 0
    let evictable = 0
    for (const a of this.assigned.values()) {
      if (a.lastHealthOk === false) unhealthy++
      const cls = this.vmLiveness(a, now)
      if (cls === 'agent') agentActive++
      else if (cls === 'app') appActive++
      else idleTail++
      if (this.vmResidency(a, now) === 'evictable') evictable++
      else active++
    }
    return { appActive, agentActive, idleTail, unhealthy, active, evictable }
  }

  /**
   * The assigned set counted by `vmHoldReason`, and the same numbers pushed out
   * as one gauge per reason. Disjoint and they sum to `assigned.size`, so a host
   * reporting 140 resident with `evictable=0` reads immediately as "nothing is
   * reapable", and one with `refused=3` says which three VMs to go look at.
   */
  protected countHoldReasons(now = Date.now()): Record<VmHoldReason, number> {
    const counts: Record<VmHoldReason, number> = {
      window: 0,
      busy: 0,
      refused: 0,
      alwaysOn: 0,
      legacy: 0,
      evictable: 0,
    }
    for (const a of this.assigned.values()) counts[this.vmHoldReason(a, now)]++
    for (const [reason, n] of Object.entries(counts)) {
      metrics.gauge(`${M.idleHoldReason}{reason="${reason}"}`, n)
    }
    return counts
  }

  /**
   * Whether this assigned VM is holding a slot someone needs (`active`) or is
   * only warm (`evictable`).
   *
   * The third state Russell asked for: an idle VM stays resident — instant
   * resume, no snapshot restore — but counts as FREE capacity, and is suspended
   * early only when an assign/resume on this host actually needs the room (see
   * `makeRoom`). Before this, an idle VM was either resident (counted as used,
   * which is what made the burst scaler buy hosts to hold VMs nobody was using)
   * or suspended (a resume on the user's next click).
   *
   * `evictable` is deliberately the same threshold as the aggressive idle
   * window (`METAL_IDLE_SUSPEND_MS`, 15m): a VM the reaper would already have
   * suspended in a busy region is exactly the one that may be evicted early in
   * a quiet one. No new knob, and the two can never disagree about "idle".
   *
   * Never evictable: `alwaysOn` (paid, never idle-suspended), a busy guest
   * (`vmBusy` — an agent turn, a live stream, a background task), and anything
   * inside the window. With idle-suspend disabled (`METAL_IDLE_SUSPEND_MS=0`)
   * nothing is evictable either: an operator who turned the reaper off did not
   * ask for VMs to be suspended on someone else's assign.
   */
  protected vmResidency(a: AssignedVm, now = Date.now()): VmResidency {
    if (!(this.cfg.idleSuspendMs > 0)) return 'active'
    if (a.alwaysOn || this.vmBusy(a)) return 'active'
    return now - (a.lastRealActivityAt ?? a.assignedAt) >= this.cfg.idleSuspendMs ? 'evictable' : 'active'
  }

  /**
   * Why the idle reaper is leaving this VM resident right now — the answer to
   * "150 VMs are resident and ~20 projects are active; what is holding the other
   * 130?". Reported per VM by `status()` and summed per reason into a gauge, so
   * one curl answers it instead of a forensic pass over five hosts (SHO-533).
   *
   * Read against the window the reaper actually applied (`reapWindowMs`), which
   * is why it can say `window` for a VM `vmResidency` already calls `evictable`:
   * residency answers "may this be evicted if room is needed" (the aggressive
   * window), the hold reason answers "why is the reaper not suspending it" (the
   * relaxed window it is running under).
   */
  protected vmHoldReason(a: AssignedVm, now = Date.now()): VmHoldReason {
    if (a.alwaysOn) return 'alwaysOn'
    if (this.refuseBackoffActive(a, now)) return 'refused'
    if (this.vmBusy(a)) return 'busy'
    const windowMs = this.reapWindowMs ?? this.cfg.idleSuspendMs
    if (now - (a.lastRealActivityAt ?? a.assignedAt) < this.idleWindowFor(a, windowMs)) return 'window'
    if (a.perClassActivity !== true) return 'legacy'
    return 'evictable'
  }

  /**
   * Whether a streamed turn is still in flight, as opposed to the guest merely
   * reporting `busy`. `liveStreams` is streams that still hold their turn; the
   * raw `activeStreams` counter can outlive one (SHO-348), and a guest that
   * reports its own `busy: false` has said so itself. A guest too old to
   * break the count down only has `busy`/`activeStreams`, which is why the
   * fallback is `vmBusy` rather than the counter.
   */
  private vmStreaming(a: AssignedVm): boolean {
    if (a.liveStreams === undefined) return this.vmBusy(a)
    return a.liveStreams > 0
  }

  /**
   * Liveness class of ONE VM — the single answer to "is anyone using this?"
   * that the fleet gauges, the bill AND the idle reaper all read.
   *
   *   agent — a streamed turn is in flight, or someone talked to the agent
   *           within the activity window;
   *   app   — an end-user app request within the activity window;
   *   idle  — everything else, including a guest that is busy with work no
   *           person asked for (a heartbeat run, a background task) and a
   *           leaked `activeStreams` with no live stream behind it.
   *
   * `classifyAssigned` buckets the fleet with exactly this, `advanceOneMeter`
   * charges time to exactly this, and `pollActivity` moves the reaper's clock
   * (`lastRealActivityAt`) only when this is not `idle`. One classifier, so the
   * gauges, the bill and the reaper cannot disagree about what "idle" means —
   * which is what let production bill 96% idle VM-hours while the same VMs were
   * never suspended (SHO-533).
   */
  protected vmLiveness(a: AssignedVm, now = Date.now()): VmLiveness {
    if (this.vmStreaming(a)) return 'agent'
    if (a.lastAgentRequestAt && now - a.lastAgentRequestAt <= ACTIVITY_WINDOW_MS) return 'agent'
    if (a.lastAppRequestAt && now - a.lastAppRequestAt <= ACTIVITY_WINDOW_MS) return 'app'
    return 'idle'
  }

  /**
   * Advance every assigned VM's cumulative counters by the time since its last
   * tick, in its current class. Called by `status()` (the heartbeat) and
   * `reapIdle()` (before it suspends anything), so a VM's final tick is taken
   * while it is still assigned and its full running time is reported.
   *
   * The counters are cumulative per VM, never reset: a heartbeat the control
   * plane drops loses nothing, because the next one carries the total and the
   * control plane diff's it against its own cursor.
   */
  advanceMeters(now = Date.now()): void {
    for (const a of this.assigned.values()) this.advanceOneMeter(a, now)
  }

  private advanceOneMeter(a: AssignedVm, now: number): VmMeter {
    // `now`, never `assignedAt`: a meter created in the past would charge every
    // second since the VM was assigned on its first tick.
    const m = (a.meter ??= { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: now })
    // Clamped: a clock step backwards must not subtract metered time.
    const elapsed = Math.max(0, now - m.advancedAt)
    m.advancedAt = now
    if (elapsed > 0) {
      const cls = this.vmLiveness(a, now)
      if (cls === 'agent') m.agentMs += elapsed
      else if (cls === 'app') m.appMs += elapsed
      else m.idleMs += elapsed
    }
    return m
  }

  /**
   * Final tick + park a VM's counters in the closed list, so the heartbeat still
   * reports its running time after it leaves `assigned` (suspend, retire,
   * destroy, a dead-VM discard). The row is dropped once the control plane acks
   * the seq that carried it — bounded by {@link MAX_CLOSED_METERS} rows and
   * {@link CLOSED_METER_TTL_MS}, so a control plane that never acks cannot grow
   * the agent's memory without limit.
   */
  private closeMeter(a: AssignedVm, now = Date.now()): void {
    const m = this.advanceOneMeter(a, now)
    const row: VmMeterReport & { lastSentSeq?: number } = {
      ...this.meterRow(a, m),
      endedAt: now,
    }
    this.closedMeters.push(row)
    if (this.closedMeters.length > MAX_CLOSED_METERS) {
      this.closedMeters.splice(0, this.closedMeters.length - MAX_CLOSED_METERS)
    }
  }

  private meterRow(a: AssignedVm, m: VmMeter): VmMeterReport {
    return {
      runtimeKey: a.projectId,
      vmId: a.handle.id,
      assignedAt: a.assignedAt,
      // The size the host ACTUALLY booted, not the API's env accounting: a host
      // boots the class default (or the project's vmMemoryMiB override), which
      // is what occupies the machine and so what the workspace pays for.
      vcpus: a.handle.vcpus,
      memMiB: a.handle.memoryMB,
      vmClass: a.handle.vmClass,
      cause: a.cause ?? 'user_open',
      alwaysOn: !!a.alwaysOn,
      agentMs: Math.round(m.agentMs),
      appMs: Math.round(m.appMs),
      idleMs: Math.round(m.idleMs),
    }
  }

  /**
   * The heartbeat's billing block: every assigned VM's cumulative counters plus
   * the stored workspace key and machine size the control plane cannot know, and
   * the closed rows it has not acked. `seq` is monotonic; the control plane
   * replies with `meterAck: seq` on the NEXT register response.
   */
  meterReport(now = Date.now()): {
    seq: number
    vms: VmMeterReport[]
    closed: VmMeterReport[]
  } {
    this.advanceMeters(now)
    this.pruneClosedMeters(now)
    const seq = ++this.meterSeq
    const vms = [...this.assigned.values()].map((a) => this.meterRow(a, a.meter!))
    for (const c of this.closedMeters) c.lastSentSeq = seq
    return { seq, vms, closed: this.closedMeters.map(({ lastSentSeq, ...row }) => row) }
  }

  /**
   * Drop closed rows the control plane has confirmed it ingested. Rows created
   * after the report that carried `seq` keep their row (no `lastSentSeq`).
   */
  ackMeters(seq: number): void {
    if (!Number.isFinite(seq) || seq <= 0) return
    this.closedMeters = this.closedMeters.filter((c) => c.lastSentSeq == null || c.lastSentSeq > seq)
  }

  private pruneClosedMeters(now: number): void {
    this.closedMeters = this.closedMeters.filter((c) => (c.endedAt ?? now) + CLOSED_METER_TTL_MS > now)
  }

  /**
   * Drop the hot local snapshot (in-memory entry + on-disk artifacts) WITHOUT
   * touching the durable store. Simulates node-agent restart / a different host
   * so the next resume must pull from the store — the cross-host mobility path.
   * Test/ops hook; not part of the normal request flow.
   */
  async evictLocal(projectId: string): Promise<boolean> {
    const s = this.suspended.get(projectId)
    if (!s) return false
    await this.deleteLocalArtifacts(s.snapshot)
    this.suspended.delete(projectId)
    this.index.remove(projectId)
    return true
  }

  /** Delete a project's pre-warmed staged snapshot, if any. */
  async dropStaged(projectId: string): Promise<boolean> {
    const s = this.stagedSuspended.get(projectId)
    if (!s) return false
    await this.deleteLocalArtifacts(s.snapshot)
    this.stagedSuspended.delete(projectId)
    this.stagedIndex.remove(projectId)
    return true
  }

  /**
   * Drop staged snapshots not taken on one of `keep` (a newer staged build
   * replaced their image, so they can never be resumed). Returns the count.
   */
  async dropStagedSnapshots(keep: string[] = []): Promise<number> {
    let n = 0
    for (const s of [...this.stagedSuspended.values()]) {
      if (s.rootfsIdentity && keep.includes(s.rootfsIdentity)) continue
      if (await this.dropStaged(s.projectId)) n++
    }
    if (n) console.log(`[pool] dropped ${n} pre-warmed snapshot(s) for a superseded staged rootfs`)
    return n
  }

  /**
   * Activation: make staged snapshots taken on `identities` the projects'
   * current ones, replacing (and deleting) the old-rootfs snapshot each one
   * supersedes. Called right after the staged image is renamed over the base
   * and before the agent restarts, so the restarted pool rehydrates them as current.
   * Their durable push was deferred while staged; `pushPendingDurable` does it
   * after the restart. Staged snapshots for any other identity are dropped.
   */
  async promoteStagedSnapshots(identities: string[]): Promise<number> {
    // The base on disk is already the new image. This process keeps running
    // (drain, a last GC sweep) until the restart, and must judge freshness
    // against that image, or it reclaims the snapshots it just promoted.
    this.rootfsIds = this.readRootfsIds()
    this.rootfsId = this.rootfsIds.standard
    let n = 0
    for (const s of [...this.stagedSuspended.values()]) {
      if (!s.rootfsIdentity || !identities.includes(s.rootfsIdentity) || this.assigned.has(s.projectId)) {
        await this.dropStaged(s.projectId)
        continue
      }
      await this.evictLocal(s.projectId)
      const promoted: SuspendedVm = { ...s, durablePending: this.store.kind !== 'none' }
      this.stagedSuspended.delete(s.projectId)
      this.stagedIndex.remove(s.projectId)
      this.suspended.set(s.projectId, promoted)
      this.writeIndex(promoted)
      n++
    }
    if (n) console.log(`[pool] promoted ${n} pre-warmed snapshot(s) to current`)
    metrics.inc(M.stagedSnapshotsPromoted, n)
    return n
  }

  /**
   * Push the durable copies of promoted snapshots (see `durablePending`), one
   * at a time under the heavy-op semaphore. A snapshot opened or evicted
   * meanwhile is skipped: its fate is no longer this sweep's to decide.
   */
  async pushPendingDurable(): Promise<number> {
    let n = 0
    for (const s of [...this.suspended.values()]) {
      if (!s.durablePending) continue
      if (this.suspended.get(s.projectId) !== s || this.openFlight.has(s.projectId)) continue
      const outcome = await this.pushDurable(s, s.workspaceOrigin)
      if (this.suspended.get(s.projectId) !== s) continue
      if (outcome === 'blocked') {
        await this.evictLocal(s.projectId)
        continue
      }
      if (outcome === 'failed') continue
      s.durablePending = false
      this.writeIndex(s)
      n++
    }
    return n
  }

  /** Staged snapshot held for a project (read-only view for status/tests). */
  stagedSnapshot(projectId: string): SuspendedVm | undefined {
    return this.stagedSuspended.get(projectId)
  }

  /**
   * Permanently remove a project from this host — the metal analog of Knative's
   * `deleteProject` (ksvc + DomainMapping teardown). Called by the control-plane
   * substrate on project DELETE so metal doesn't leak snapshot bytes the way the
   * GC-only path did (a deleted project's durable S3 copy + local NVMe snapshot
   * previously lingered until an LRU sweep, or forever if never re-pressured).
   *
   * Stops any live VM, deletes the local snapshot artifacts + cache-index entry,
   * drops the durable-store copy, and clears the live/adopt registry entry.
   * Idempotent: a project that isn't present here returns an all-false report.
   */
  async destroy(projectId: string): Promise<{ stoppedVm: boolean; removedLocal: boolean; removedDurable: boolean }> {
    let stoppedVm = false
    let removedLocal = false
    let removedDurable = false

    const a = this.assigned.get(projectId)
    if (a) {
      await this.mgr.stopVM(a.handle).catch(() => {})
      // Also unlink any snapshot files this VM was restored from — they're no
      // longer referenced once the project is gone.
      if (a.restoredFrom) {
        for (const p of [a.restoredFrom.vmstate, a.restoredFrom.mem]) {
          try {
            rmSync(p, { force: true })
          } catch {
            /* ignore */
          }
        }
      }
      this.closeMeter(a)
      this.assigned.delete(projectId)
      this.live.remove(projectId)
      stoppedVm = true
    }

    if (await this.dropStaged(projectId)) removedLocal = true
    const s = this.suspended.get(projectId)
    if (s) {
      await this.deleteLocalArtifacts(s.snapshot)
      this.suspended.delete(projectId)
      this.index.remove(projectId)
      removedLocal = true
    }

    if (this.store.kind !== 'none') {
      try {
        await this.store.remove(projectId)
        removedDurable = true
      } catch {
        removedDurable = false
      }
    }

    this.publishGauges()
    return { stoppedVm, removedLocal, removedDurable }
  }

  /**
   * Replace a runtime's VM with a clean cold boot, WITHOUT losing anything.
   *
   * A plain stop suspends to a memory snapshot, and resuming that snapshot
   * brings back exactly the stuck processes that made someone want to restart
   * it. `destroy()` avoids that but drops the snapshot, which may hold the only
   * copy of recent work. This does both halves safely:
   *
   *   1. make the VM live (resume it if only a snapshot exists);
   *   2. back up source, git, database and published data from the live guest;
   *   3. only if every backup landed (or `force`), stop it without a snapshot
   *      and drop the local and durable snapshots.
   *
   * The next open then cold-boots from the durable backups. Without `force`, a
   * failed step aborts before anything is removed and the VM keeps running.
   *
   * A database the guest cannot snapshot fails the `data` step and therefore
   * aborts the recycle: there is no way to prove the durable archive already
   * holds it, and a cold boot would replace it with whatever the archive did
   * hold. `rotateStale` reports that as `stale_rootfs_blocked` (SHO-541).
   */
  async recycle(
    runtimeKey: string,
    opts: RecycleOpts = {},
  ): Promise<RecycleReport> {
    if (this.openFlight.has(runtimeKey) || this.suspendFlight.has(runtimeKey)) {
      return {
        runtimeKey,
        state: this.getProjectStatus(runtimeKey).state,
        resumed: false,
        forced: !!opts.force,
        aborted: true,
        steps: [{ step: 'lock', ok: false, detail: 'an open or suspend is in flight; retry shortly' }],
      }
    }
    return this.recycleFlight.run(runtimeKey, () => this.recycleInner(runtimeKey, opts))
  }

  private async recycleInner(runtimeKey: string, opts: RecycleOpts): Promise<RecycleReport> {
    const force = !!opts.force
    const state = this.getProjectStatus(runtimeKey).state
    const steps: RecycleStep[] = []
    const notices: string[] = []
    let tmpHeld: DroppedTmpReport | undefined
    // `.tmp/` is dropped by design, so the report names it once — the guest
    // measures it on the checkpoint and again when it stops tasks, and either
    // call may come first.
    const noteTmp = (tmp: DroppedTmpReport) => {
      if (tmpHeld || tmp.files <= 0) return
      tmpHeld = tmp
      const size = tmp.bytes >= 1 << 30 ? `${(tmp.bytes / (1 << 30)).toFixed(1)} GB` : `${Math.max(1, Math.round(tmp.bytes / 1024))} KB`
      // Name what went, not only how much: "3.6 GB" tells an owner nothing they
      // can rebuild from, `.tmp/series/, .tmp/wa-gateway.ts` does (SHO-399).
      const names = tmp.entries?.length ? `: ${tmp.entries.join(', ')}` : ''
      notices.push(`.tmp/ (${tmp.files} file${tmp.files === 1 ? '' : 's'}, ${size}${names}) was dropped — it is not part of the backup`)
    }
    const report = (aborted: boolean, extra: Partial<RecycleReport> = {}): RecycleReport => ({
      runtimeKey,
      state,
      resumed: false,
      forced: force,
      aborted,
      steps,
      ...(tmpHeld ? { tmp: tmpHeld } : {}),
      ...(notices.length ? { notices } : {}),
      ...extra,
    })
    console.log(`[pool] recycle ${runtimeKey} requested (state=${state}, force=${force}, reason=${opts.reason ?? 'none'})`)

    let a = this.assigned.get(runtimeKey)
    // A release rotation asks the narrower question the rotation policy already
    // answered: a turn blocks it, background tasks do not, because they are
    // about to be stopped and (for declared services) brought back (SHO-399).
    // Every other caller keeps the old, wider gate.
    if (a && !force) {
      const blocked = opts.stopBackgroundTasks ? this.vmInTurn(a) : this.vmBusy(a)
      if (blocked) {
        steps.push({
          step: 'idle',
          ok: false,
          detail: opts.stopBackgroundTasks
            ? `${a.activeTurns ?? 0} agent turn(s) in flight`
            : `${a.activeStreams ?? 0} agent turn(s) in flight`,
        })
        return report(true)
      }
    }
    let resumed = false
    if (!a && (state === 'suspended' || this.store.kind !== 'none')) {
      try {
        const r = await this.resume(runtimeKey, opts.env ?? {})
        if (r) {
          a = r.assigned
          resumed = true
          steps.push({ step: 'resume', ok: true, detail: `from ${r.source} snapshot` })
        } else {
          steps.push({ step: 'resume', ok: true, detail: 'no usable snapshot; durable backups are current' })
        }
      } catch (err: any) {
        steps.push({ step: 'resume', ok: false, detail: err?.message ?? String(err) })
        if (!force) return report(true)
      }
    }

    if (a) {
      const ok = await this.backupForRecycle(a, steps, {
        stopBackgroundTasks: opts.stopBackgroundTasks,
        reason: opts.reason,
        noteTmp,
        force,
      })
      if (!ok && !force) {
        console.error(`[pool] recycle ${runtimeKey} ABORTED — a backup step failed; nothing removed`)
        return report(true, { resumed })
      }
    }

    const destroyed = await this.destroy(runtimeKey)
    steps.push({ step: 'destroy', ok: true, detail: JSON.stringify(destroyed) })
    console.log(`[pool] recycled ${runtimeKey} (force=${force}): ${JSON.stringify(steps)}`)
    return report(false, { resumed, destroyed })
  }

  /**
   * Every backup a recycle needs before it may drop the snapshot. Each step
   * records whether the VM's CURRENT state is now in its durable home — a
   * refused or quarantined write counts as a failure, because the cold boot
   * that follows restores the durable copy, not the quarantined one.
   */
  private async backupForRecycle(
    a: AssignedVm,
    steps: RecycleStep[],
    opts: {
      stopBackgroundTasks?: boolean
      reason?: string
      noteTmp?: (tmp: DroppedTmpReport) => void
      /**
       * Run every step even after one fails, keeping today's behaviour for an
       * operator-initiated force recycle. A non-forced recycle STOPS at the
       * first failure (SHO-584): it is going to abort, and each remaining export
       * is a full pull-and-upload whose refusal would land in `conflict/` again.
       */
      force?: boolean
    } = {},
  ): Promise<boolean> {
    // The first step that failed. Once set, a non-forced pass records every
    // remaining step as skipped and does no more work: after the repo export
    // failed on a corrupt `.git`, running data → home → source anyway is how one
    // VM re-quarantined 525 MB every ten minutes for six days (SHO-584).
    let failed: string | null = null
    const run = async (step: string, fn: () => Promise<string | null>) => {
      if (failed && !opts.force) {
        steps.push({ step, ok: false, detail: `skipped: ${failed} failed` })
        return
      }
      try {
        const problem = await fn()
        steps.push(problem ? { step, ok: false, detail: problem } : { step, ok: true })
        if (problem && !failed) failed = step
      } catch (err: any) {
        steps.push({ step, ok: false, detail: err?.message ?? String(err) })
        if (!failed) failed = step
      }
    }
    const isWorkspace = a.projectId.startsWith('ws:')

    if (isWorkspace) {
      await run('foreign_members', async () => {
        const failed = (await this.drainForeignMembersOf(a, 3_000)).filter((r) => r.outcome === 'failed')
        return failed.length ? failed.map((r) => `${r.projectId}: ${r.detail}`).join('; ') : null
      })
      // A resume learns the members from the caller's env; unless the guest can
      // confirm what it has mounted, an empty list means every member backup
      // below would silently cover nothing.
      const members = await this.workspaceMembersForBackup(a)
      if (!members.guestConfirmed && !members.ids.length && ownMemberIds(a.projectId).length) {
        steps.push({ step: 'members', ok: false, detail: 'workspace member list unknown; member backups would be skipped' })
      }
    }

    // Commit the working tree BEFORE the repo export (SHO-399). The repo step
    // bundles the commits that already exist and never makes one, so every edit
    // made after the last turn-complete auto-commit would go with the VM. A
    // failed checkpoint fails the recycle (unless forced) instead of quietly
    // dropping that work — a later rotateStale attempt retries it.
    await run('checkpoint', () => this.checkpointGuest(a, opts.noteTmp))

    await run('repo', async () => {
      if (a.repoHydratePending) return null
      if (this.repoLineageOf(a).kind === 'untrusted') {
        // A cold boot restores the durable copy, so this is still a failed step
        // (a non-forced recycle aborts). But the work must exist somewhere: the
        // quarantine copy is written first, and its key goes in the report
        // (SHO-442).
        const quarantined = await this.quarantineRepo(a)
        return (
          `git history is untrusted (${a.repoUntrustedReason ?? 'unknown'}); durable repo left as is` +
          (quarantined ? `; quarantined at ${a.repoQuarantineKey ?? 'conflict/'}` : '; quarantine FAILED')
        )
      }
      // Joining an in-flight periodic export would hand back its boolean, not
      // our outcome — so if our closure did not run, run again once it ends.
      let out: 'written' | 'quarantined' | 'lost' | 'empty' | undefined
      const exportRepo = () =>
        this.repoFlight.run(a.projectId, async () => {
          const bundled = await this.storeRepoBundles(a)
          if (bundled !== null) {
            out = bundled === 'unchanged' ? 'written' : bundled
            return out === 'written'
          }
          const exported = await this.exportRepoOf(a)
          try {
            out = exported ? await this.storeRepoBytes(a, exported.bytes, exported.rootCommitAt) : 'empty'
          } finally {
            exported?.dispose?.()
          }
          return out === 'written'
        })
      await exportRepo()
      if (out === undefined) await exportRepo()
      return out === 'written' || out === 'empty' ? null : `repo ${out}`
    })

    await run('data', async () => {
      // Twice: the first may join an in-flight periodic export (possibly
      // throttled). The second is a cheap 304 when the first already landed.
      // Caught rather than thrown: a snapshot failure has to be classified
      // before it can be named, and `run` would otherwise record the raw
      // SQLite message as the reason.
      let saveError: unknown
      try {
        await this.saveProjectDataToStore(a, { final: true, reason: 'recycle' })
        await this.saveProjectDataToStore(a, { final: true, reason: 'recycle' })
      } catch (err) {
        saveError = err
      }
      if (a.dataExportUnsupported) return 'guest cannot export its database (predates /pool/export-data)'
      // A database the guest cannot snapshot is a database this recycle cannot
      // carry across: the cold boot would hydrate whatever the durable archive
      // last held, and nothing can prove that is still this data. Refusing is
      // the only option that cannot lose writes; `rotateStale` turns this into
      // `stale_rootfs_blocked` with the SQLite error on the VM's status.
      if (a.dataSnapshotFailure) {
        return `database not persisted — ${a.dataSnapshotFailure.message}`
      }
      if (saveError) throw saveError
      const untrusted = isWorkspace
        ? Object.entries(a.memberData ?? {})
            .filter(([, s]) => s.untrustedReason)
            .map(([id, s]) => `${id}: ${s.untrustedReason}`)
        : a.dataUntrustedReason
          ? [a.dataUntrustedReason]
          : []
      return untrusted.length ? `database not persisted — ${untrusted.join('; ')}` : null
    })

    if (homeStateEligible(a.publishedSubdomain)) {
      await run('home', async () => {
        await this.saveHomeStateToStore(a, { final: true, reason: 'recycle' })
        return a.homeUntrustedReason ? `home directory not persisted — ${a.homeUntrustedReason}` : null
      })
    }

    if (a.publishedSubdomain) {
      await run('published-data', async () => {
        await this.exportPublishedData(a)
        return null
      })
    }

    // Stop background tasks BEFORE the source backup, not after: the source
    // archive is what carries `.shogo/sessions.db`, and stopping a task writes
    // its verdict there. Doing it the other way round put the note on disk of a
    // VM that was about to be destroyed (SHO-399).
    if (opts.stopBackgroundTasks) {
      await run('stop-tasks', async () => {
        const res = await fetch(`${a.handle.agentUrl}/pool/stop-background-tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(a.runtimeToken ? { 'x-runtime-token': a.runtimeToken } : {}) },
          body: JSON.stringify({ reason: opts.reason ? `this runtime moved to the new release (${opts.reason})` : 'this runtime moved to the new release' }),
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) return `guest refused: HTTP ${res.status}`
        // The guest measured `.tmp/` before it settled the tasks. Nothing backs
        // that folder up, so the report says what went with it — a manual
        // `/recycle` caller can then tell the owner chat (SHO-399).
        const body = await res.json().catch(() => null) as { tmp?: Partial<DroppedTmpReport> } | null
        const tmp = readTmpReport(body?.tmp)
        if (tmp) opts.noteTmp?.(tmp)
        return null
      })
    }

    await run('source', async () => {
      if (isWorkspace) {
        const failed = await this.saveWorkspaceMembersToStore(a)
        return failed.length ? failed.map((f) => `${f.projectId}: ${f.reason}`).join('; ') : null
      }
      const out = await this.saveBackupToStore(a)
      return out === 'written' || out === 'empty' ? null : `source ${out}`
    })

    return steps.every((s) => s.ok)
  }

  /**
   * Project-scoped status for the control-plane substrate `getStatus()` — the
   * metal analog of KnativeProjectManager.getStatus (exists/ready/replicas).
   *   assigned  → running (replicas 1)
   *   suspended → exists but scaled-to-zero (replicas 0, resumable)
   *   neither   → does not exist here
   */
  getProjectStatus(projectId: string): ProjectStatus {
    const staged = this.stagedSuspended.get(projectId)
    const a = this.assigned.get(projectId)
    if (a) {
      const now = Date.now()
      return {
        exists: true,
        ready: true,
        replicas: 1,
        url: a.handle.agentUrl,
        state: 'assigned',
        rootfsFresh: this.bootRootfsIdentity(a) === this.classRootfsIdentity(a.handle.vmClass),
        assignedAt: a.assignedAt,
        lastRealActivityAt: a.lastRealActivityAt ?? a.assignedAt,
        realIdleMs: now - (a.lastRealActivityAt ?? a.assignedAt),
        lastUserActivityAt: a.lastUserActivityAt ?? a.assignedAt,
        userIdleMs: now - (a.lastUserActivityAt ?? a.assignedAt),
        activeStreams: a.activeStreams ?? 0,
        busy: this.vmBusy(a),
        busyIdle: this.vmBusy(a) && this.pastBusyIdleCeiling(a, now),
        snapshotRootfsIdentity: this.bootRootfsIdentity(a),
        ...(staged ? { stagedSnapshotIdentity: staged.rootfsIdentity } : {}),
        durability: this.durabilityOf(a),
        ...(a.dataSnapshotFailure ? { dataSnapshot: a.dataSnapshotFailure } : {}),
        ...(this.rotationBlockedOf(a.projectId) ? { rotationBlocked: this.rotationBlockedOf(a.projectId) } : {}),
      }
    }
    const s = this.suspended.get(projectId)
    if (s) {
      return {
        exists: true,
        ready: false,
        replicas: 0,
        state: 'suspended',
        rootfsFresh: !this.localSnapshotIsStale(s),
        snapshotRootfsIdentity: s.rootfsIdentity,
        ...(staged ? { stagedSnapshotIdentity: staged.rootfsIdentity } : {}),
      }
    }
    // A pre-warmed snapshot alone is not resumable until activation, so the
    // project does not exist here as far as routing is concerned.
    return {
      exists: false,
      ready: false,
      replicas: 0,
      state: 'none',
      ...(staged ? { stagedSnapshotIdentity: staged.rootfsIdentity } : {}),
    }
  }

  /** Capacity + cache summary for the registration heartbeat (scalars only). */
  capacity() {
    const disk = this.disk()
    return {
      totalBytes: disk.totalBytes,
      freeBytes: disk.freeBytes,
      usedPct: +disk.usedPct.toFixed(2),
      cacheBytes: this.cacheBytes(),
      localCount: this.suspended.size,
      stagedCount: this.stagedSuspended.size,
    }
  }

  status() {
    const now = Date.now()
    this.publishGauges()
    const liveness = this.classifyAssigned(now)
    // Per-reason counts of the resident set, so the next "why are 150 VMs loaded
    // while 20 projects are active" is one curl instead of a forensic pass.
    const holds = this.countHoldReasons(now)
    return {
      store: this.store.kind,
      idleSuspendMs: this.cfg.idleSuspendMs,
      busyIdleCeilingMs: this.cfg.busyIdleCeilingMs,
      // Billing: every assigned VM's cumulative running time by class, plus the
      // closed VMs the control plane has not acked. The control plane ingests it
      // from the heartbeat; `meter` is here (not only in register.ts) so /vms
      // shows exactly what the last heartbeat carried.
      meter: this.meterReport(now),
      rootfsCow: this.cfg.rootfsCow,
      disk: this.disk(),
      cache: { localCount: this.suspended.size, stagedCount: this.stagedSuspended.size, localBytes: this.cacheBytes() },
      available: this.available.length,
      // Per-class warm-pool breakdown (Phase 1 docker project class). A host
      // that hasn't opted into the docker class simply reports poolSize:0,
      // supported:false — the control plane's candidate filtering uses this to
      // never route a docker-class assign here.
      classes: VM_CLASSES.map((vmClass) => ({
        vmClass,
        supported: isVmClassSupported(this.cfg, vmClass),
        poolSize: classConfig(this.cfg, vmClass).poolSize,
        available: this.available.filter((v) => v.handle.vmClass === vmClass).length,
      })),
      // Assigned (running) set decomposed by why each VM is live, so the raw
      // count can be read as app-users + agent-turns + idle-tail.
      liveness,
      // The same set decomposed by what is KEEPING it resident (see
      // `vmHoldReason`), plus the window it was judged against.
      holdReasons: holds,
      reapWindowMs: this.reapWindowMs ?? this.cfg.idleSuspendMs,
      // Live FC processes vs tracked VMs — a growing gap flags a process leak.
      fcProcs: this.mgr.procCount(),
      assigned: [...this.assigned.values()].map((a) => ({
        projectId: a.projectId,
        url: a.handle.agentUrl,
        vmId: a.handle.id,
        vmClass: a.handle.vmClass,
        idleMs: now - a.lastTouchedAt,
        // What reapIdle actually compares against idleSuspendMs. Diverges from
        // idleMs by however much routing polls / fail-open have touched the VM.
        realIdleMs: now - (a.lastRealActivityAt ?? a.assignedAt),
        // The clock the busy-idle ceiling reads: only real user requests move it,
        // so a guest stuck reporting busy cannot keep it fresh.
        userIdleMs: now - (a.lastUserActivityAt ?? a.assignedAt),
        // Per-class liveness (see AssignedVm). `*IdleMs: null` = no request of
        // that class observed yet; `busy` (or `activeStreams>0` for an older
        // guest) = an agent turn in flight.
        activeStreams: a.activeStreams ?? 0,
        busy: this.vmBusy(a),
        // `active` = holding a slot someone needs; `evictable` = warm but free
        // capacity, suspended early only when an assign here needs the room.
        residency: this.vmResidency(a, now),
        // Why the reaper is leaving it resident (window | busy | refused |
        // alwaysOn | legacy | evictable). `evictable` = the next pass suspends it.
        holdReason: this.vmHoldReason(a, now),
        // Reports busy, but no user activity past the ceiling: the reaper will
        // suspend it on its next pass.
        busyIdle: this.vmBusy(a) && this.pastBusyIdleCeiling(a, now),
        // MiB this idle VM has handed back to the host via the balloon (SHO-534),
        // and when it was last handed back. Debug only, per VM: VM ids are not
        // metric labels, so per-VM numbers live here and only the sums are gauges.
        balloonedMiB: a.balloonedMiB ?? null,
        balloonUnsupported: a.balloonUnsupported === true,
        balloonIdleMs: a.lastBalloonAt !== undefined ? now - a.lastBalloonAt : null,
        appIdleMs: a.lastAppRequestAt ? now - a.lastAppRequestAt : null,
        appRequestCount: a.appRequestCount ?? 0,
        agentIdleMs: a.lastAgentRequestAt ? now - a.lastAgentRequestAt : null,
        unhealthy: a.lastHealthOk === false,
        apiUnhealthyMs: a.apiUnhealthySince !== undefined ? now - a.apiUnhealthySince : null,
        apiUnhealthyProjects: a.apiUnhealthyProjects ?? null,
        // Writable-state durability of this VM's database (SHO-541). `data` is
        // set only while the snapshot keeps failing; `rotation` names a VM on a
        // superseded rootfs that rotation has given up on.
        data: this.dataHealthOf(a, now),
        rotation: this.rotationBlockedOf(a.projectId),
      })),
      suspended: [...this.suspended.values()].map((s) => ({
        projectId: s.projectId,
        memBytes: s.snapshot.bytesMem,
        stateBytes: s.snapshot.bytesState,
        rootfsBytes: s.snapshot.bytesRootfs,
        lastAccessAt: s.lastAccessAt,
        idleMs: now - s.lastAccessAt,
      })),
    }
  }

  async stop(): Promise<void> {
    for (const vm of this.available) await this.mgr.stopVM(vm.handle).catch(() => {})
    for (const a of this.assigned.values()) await this.mgr.stopVM(a.handle).catch(() => {})
    this.available = []
    this.assigned.clear()
  }
}

/** The durable-archive ETags a snapshot was taken against. */
export interface SnapshotStamps {
  backupEtag?: string
  repoEtag?: string
  dataEtag?: string
  homeEtag?: string
  memberDataEtags?: Record<string, string>
  memberSourceEtags?: Record<string, string>
}

/** One durable archive that has moved past a snapshot. */
export interface SnapshotDrift {
  kind: StaleReason
  memberId?: string
  detail: string
}

/** `openStaged` found a snapshot on the staged rootfs already held: nothing to boot. */
export interface PrewarmedResult {
  mode: 'prewarmed'
  stagedSnapshotIdentity: string
}

export interface OpenResult {
  handle: FcVmHandle
  mode: 'assigned' | 'resumed'
  /** Rootfs the serving guest booted from (for a resume, the snapshot's). */
  bootRootfsIdentity?: string
  source?: 'local' | 'store'
  readyMs?: number
  /** `mode:'assigned'` re-attached an already-running VM rather than a fresh
   * cold claim. Reported to the control plane so it records a warm hit. */
  reused?: boolean
  /** Wall-clock ms per open phase (see PhaseTimer). */
  phases?: Record<string, number>
  /** Wall-clock ms for the whole open, including phases not broken out. */
  totalMs?: number
  /** Cold boot only: why no snapshot was resumed. */
  staleReason?: StaleReason
  /**
   * Resume only: why the snapshot being restored was taken — the idle window
   * (`idle`) or an on-demand eviction (`evicted`). The control plane labels its
   * wake-latency metric with it, so the cost of the "ready to suspend" bucket is
   * measurable instead of assumed.
   */
  suspendReason?: SuspendReason
  /** Fresh assign only: how the git history restore went. */
  repo?: RepoRestoreInfo
  /** `reused` only: the open this VM came from, if nobody received it (see reportOpen). */
  lateWake?: LateWake
}

/** A finished open, kept for the retry that follows a control-plane timeout. */
export interface LateWake {
  at: number
  mode: 'assigned' | 'resumed'
  source?: 'local' | 'store'
  staleReason?: StaleReason
  suspendReason?: SuspendReason
  phases: Record<string, number>
  totalMs: number
  repo?: RepoRestoreInfo
}
