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

import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { CacheIndex, type CacheEntry } from './cache-index'
import { Semaphore, Singleflight } from './concurrency'
import { HydrateProxy } from './hydrate-proxy'
import { config } from './config'
import { allocatedBytes, diskUsage, type DiskUsage } from './disk'
import { FirecrackerVMManager, type FcVmHandle, type FcSnapshot } from './firecracker-vm-manager'
import { planEvictions, type EvictionCandidate } from './gc-policy'
import { LiveRegistry, pidAlive } from './live-registry'
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
  uploadPublishedDataArchive,
} from './published-data-archive'
import {
  describeProjectDataArchive,
  uploadProjectDataGuarded,
  type DataLineage,
  type DataWriteOutcome,
} from './project-data-archive'
import type { ArchiveRef } from './archive-ref'

/**
 * How long a presigned hydrate URL stays valid.
 *
 * Matches the guest's own ceiling on a pull, so a URL never outlives the
 * transfer it was minted for. It is a bearer capability for one object handed
 * to guest code, so the bound matters more than the convenience.
 */
const PRESIGN_TTL_SEC = 30 * 60

export interface PooledVm {
  handle: FcVmHandle
  ready: boolean
  createdAt: number
}

export interface AssignedVm {
  projectId: string
  handle: FcVmHandle
  assignedAt: number
  lastTouchedAt: number
  /** Snapshot files this VM was restored from; protected from orphan reclaim. */
  restoredFrom?: { vmstate: string; mem: string }
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
   * Active agent message streams the guest reported at the last activity poll.
   * `> 0` means a live generation is in flight, so the idle reaper must not
   * snapshot the VM away (it would kill the turn). Refreshed each pollActivity.
   */
  activeStreams?: number
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
  /**
   * Set for a SERVER-BACKED published microVM (assign env `SHOGO_PUBLISHED_MODE`
   * + `PUBLISHED_SUBDOMAIN`). Marks this VM as owning a live site's writable
   * state, so the pool hydrates `{subdomain}/data.tar.gz` into it on cold boot
   * and exports it back to S3 periodically / on suspend (host-side, since the
   * guest holds no S3 creds). Absent on ordinary dev/preview VMs.
   */
  publishedSubdomain?: string
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
 * How recently a VM must have served end-user *app* traffic to count as
 * "app-active" in the fleet gauges. Generous enough to bridge the gaps between
 * a real user's requests (page loads, API calls) without flapping the bucket,
 * short enough that a genuinely-abandoned app falls into the idle tail. Purely
 * an observability window — it does not affect suspend/reap decisions.
 */
const APP_ACTIVE_WINDOW_MS = 120_000

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
function publishedSubdomainFromEnv(env: Record<string, string>): string | undefined {
  const published = env.SHOGO_PUBLISHED_MODE === 'true' || env.SHOGO_PUBLISHED_MODE === '1'
  const subdomain = env.PUBLISHED_SUBDOMAIN
  return published && subdomain ? subdomain : undefined
}

async function probeHealth(url: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export class MetalWarmPool {
  private available: PooledVm[] = []
  private assigned = new Map<string, AssignedVm>()
  private suspended = new Map<string, SuspendedVm>()
  private store: SnapshotStore
  private rootfsId: string
  private index: CacheIndex
  /** Durable registry of assigned/live VMs, for adopt-on-restart (rolling deploy). */
  private live: LiveRegistry
  /** Handle ids in a boot/restore/assign window: off the pool + not yet in a
   * map, but legitimately live. Kept out of the orphan reaper's sights. */
  private inFlight = new Set<string>()
  /** Collapses concurrent open (assign|resume) calls for the same project. */
  private openFlight = new Singleflight<OpenResult | null>()
  /** Collapses concurrent suspend calls for the same project. */
  private suspendFlight = new Singleflight<SuspendedVm>()
  /**
   * Serializes writable-state exports per project. The periodic exporter and
   * `suspend()` both export, and two concurrent exports carry the SAME lineage,
   * so the one that lands second fails its precondition and throws away what is
   * usually the fresher database.
   */
  private dataFlight = new Singleflight<boolean>()
  /**
   * Last writable-state change tag the guest reported, per project. Echoed back
   * on the next export so an unchanged project answers 304 without snapshotting
   * or packing. In-memory only — a restart just costs one redundant export.
   */
  private dataTags = new Map<string, string>()
  /** Invalidated CoW stores at the last gauge publish, so we log each new one once. */
  private lastCowInvalid = 0
  /** Caps concurrent heavy NVMe ops (snapshot / restore / store pull|push). */
  private heavy: Semaphore
  /** Single-flight guard for pool fills (see reconcile). */
  private reconciling: Promise<void> | null = null
  /**
   * Serves durable archives to guests over the tap link, fetched several parts
   * at a time. Public because the HTTP server routes redemptions to it.
   */
  readonly hydrateProxy: HydrateProxy

  constructor(
    private mgr = new FirecrackerVMManager(),
    private cfg = config,
    store?: SnapshotStore,
  ) {
    this.store = store ?? createSnapshotStore(cfg)
    this.rootfsId = computeRootfsIdentity(cfg)
    this.index = new CacheIndex(cfg.snapDir)
    this.live = new LiveRegistry(cfg.runDir)
    this.heavy = new Semaphore(parseInt(process.env.METAL_HEAVY_CONCURRENCY ?? '2', 10))
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
   * Best-effort guest lifecycle hook. The in-guest runtime flushes + drops
   * stale external sockets (AI-proxy/MCP/LSP/DB) on `quiesce` before we freeze
   * RAM, and re-establishes them on `rehydrate` after wake. A 404 (guest opted
   * out) or timeout is tolerated so the substrate works with any guest.
   */
  private async callGuestHook(url: string, hook: 'quiesce' | 'rehydrate', timeoutMs: number): Promise<boolean> {
    try {
      const res = await fetch(`${url}/pool/${hook}`, {
        method: 'POST',
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
      if (!isAlive()) throw new Error(`VM ${handle.id} exited before healthy`)
      if (await probeHealth(handle.agentUrl, 500)) return performance.now() - start
      await Bun.sleep(this.cfg.healthIntervalMs)
    }
    throw new Error(`VM ${handle.id} never became healthy`)
  }

  private async bootOne(pool = true): Promise<PooledVm> {
    const handle = await this.mgr.startVM({
      memoryMB: this.cfg.memMiB,
      cpus: this.cfg.vcpus,
    })
    // startVM self-cleans a partial boot; a VM that boots but never becomes
    // healthy is our responsibility to stop, or its FC process leaks (never
    // enters `available`/`assigned`, so nothing else would ever kill it).
    this.inFlight.add(handle.id)
    try {
      await this.waitForHealth(handle, () => this.mgr.isRunning(handle))
    } catch (err) {
      await this.mgr.stopVM(handle).catch(() => {})
      throw err
    } finally {
      this.inFlight.delete(handle.id)
    }
    return { handle, ready: true, createdAt: Date.now() }
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
   */
  private async fillPool(): Promise<void> {
    let remaining = this.cfg.poolSize - this.available.length
    if (remaining <= 0) return
    const workers = Math.min(remaining, Math.max(1, this.cfg.poolBootConcurrency))
    const worker = async (): Promise<void> => {
      // `remaining--` is atomic between awaits on the single JS event loop, so
      // workers never over- or under-boot the deficit.
      while (remaining > 0) {
        remaining--
        try {
          const vm = await this.bootOne()
          this.available.push(vm)
        } catch (err: any) {
          console.error('[pool] warm boot failed (retry on demand):', err?.message ?? err)
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()))
  }

  async start(): Promise<{ adopted: string[]; reaped: number }> {
    this.rehydrate()
    // Adopt live VMs that survived the restart BEFORE filling the pool (fillPool
    // spawns new FCs; adopt must first claim survivors + reap non-adopted ones
    // so the host-scan reaper can't race a freshly-booted warm VM).
    const adoption = await this.adopt()
    // Seed the tap-index allocator past every persisted (adopted + suspended)
    // tap BEFORE reconcile() fills the warm pool — otherwise a fresh warm VM
    // would reuse a device name still held by an adopted VM (or reclaimed on a
    // suspended project's resume) and setupTap would tear down that live tap.
    this.seedVmIndexAllocator()
    await this.reconcile()
    return adoption
  }

  /**
   * Advance the FC manager's tap-index counter past the highest `fctap<n>` index
   * recorded in the durable registries — live (adopted, still running) and cache
   * (suspended, whose exact device is recreated on resume). Without this the
   * counter reset to 0 on every restart and warm VMs collided with survivors.
   */
  private seedVmIndexAllocator(): void {
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
    for (const n of this.hostTapIndices()) {
      if (n > maxIdx) maxIdx = n
    }
    if (maxIdx >= 0) this.mgr.seedVmSeq(maxIdx + 1)
  }

  /** Live host tap indices (`ip link`). Overridable seam for tests. */
  protected hostTapIndices(): Set<number> {
    return existingTapIndices()
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
    for (const e of this.live.all()) {
      if (this.assigned.has(e.projectId)) continue // already tracked (defensive)
      if (!pidAlive(e.pid) || !existsSync(e.socketPath)) {
        this.live.remove(e.projectId)
        continue
      }
      // A live firecracker process with its API socket present IS a real microVM
      // holding (possibly unsaved) user state — so we ADOPT it unconditionally and
      // never let it be reaped. The health probe is advisory only: a transient
      // unresponsiveness during the restart window (host load, overlapping
      // restarts) must not cause us to SIGKILL a running VM. A guest that is truly
      // wedged stays adopted and is handled by the normal idle reaper / next
      // suspend — it is never killed here. (Only pid-dead / socket-gone entries,
      // handled above, are dropped so their leftover procs, if any, get reaped.)
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
      }
      this.mgr.adoptVM(handle)
      this.assigned.set(e.projectId, {
        projectId: e.projectId,
        alwaysOn: e.alwaysOn,
        runtimeToken: e.runtimeToken,
        publishedSubdomain: e.publishedSubdomain,
        handle,
        assignedAt: e.assignedAt,
        lastTouchedAt: Date.now(),
        // Fresh idle window across the restart, like lastTouchedAt: the guest's
        // real-activity history doesn't survive in the registry, and reaping an
        // adopted VM on its original assignedAt would suspend the live set on
        // every rolling deploy.
        lastRealActivityAt: Date.now(),
        restoredFrom: e.restoredFrom,
        workspaceOrigin: e.workspaceOrigin,
        backupParentEtag: e.backupParentEtag,
        dataParentEtag: e.dataParentEtag,
        dataUntrustedReason: e.dataUntrustedReason,
      })
      adoptedIds.add(e.vmId)
      adoptedProjects.push(e.projectId)
    }
    const reaped = this.mgr.reapHostOrphans(adoptedIds)
    if (adoptedProjects.length) {
      console.log(`[pool] adopted ${adoptedProjects.length} live microVM(s) across restart: ${adoptedProjects.join(', ')}`)
    }
    return { adopted: adoptedProjects, reaped }
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
      assignedAt: a.assignedAt,
      lastTouchedAt: a.lastTouchedAt,
      restoredFrom: a.restoredFrom,
      alwaysOn: a.alwaysOn,
      runtimeToken: a.runtimeToken,
      publishedSubdomain: a.publishedSubdomain,
      workspaceOrigin: a.workspaceOrigin,
      backupParentEtag: a.backupParentEtag,
      dataParentEtag: a.dataParentEtag,
      dataUntrustedReason: a.dataUntrustedReason,
      v: 1,
    })
  }

  /**
   * Rebuild the in-memory `suspended` map from the persistent index at startup
   * so a node-agent restart keeps NVMe locality (no store re-pull stampede).
   * Entries whose artifacts are missing are dropped (their index file removed).
   */
  rehydrate(): number {
    let n = 0
    for (const e of this.index.all()) {
      const artifactsPresent =
        existsSync(e.snapshotPath) && existsSync(e.memFilePath) && existsSync(e.rootfs)
      if (!artifactsPresent) {
        this.index.remove(e.projectId)
        continue
      }
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
      }
      this.suspended.set(e.projectId, {
        projectId: e.projectId,
        snapshot,
        suspendedAt: e.suspendedAt,
        lastAccessAt: e.lastAccessAt,
        rootfsIdentity: e.rootfsIdentity,
        backupEtag: e.backupEtag,
        dataEtag: e.dataEtag,
      })
      n++
    }
    if (n) console.log(`[pool] rehydrated ${n} suspended snapshot(s) from cache index`)
    return n
  }

  private claim(): PooledVm | null {
    const idx = this.available.findIndex((v) => v.ready)
    if (idx === -1) return null
    const [vm] = this.available.splice(idx, 1)
    // Replace in background.
    this.reconcile().catch(() => {})
    return vm
  }

  /**
   * Open a project on this host: resume its snapshot if one exists (hot local
   * OR durable store), else claim+assign a warm VM. Concurrent opens for the
   * same project collapse into one via singleflight (no double cold-boot / no
   * racing resumes).
   */
  async open(projectId: string, env: Record<string, string> = {}): Promise<OpenResult> {
    const r = await this.openFlight.run(projectId, async () => {
      // Idempotent: if the project is already live here, hand back the same VM
      // rather than restoring a duplicate from the store (which a re-/assign
      // for a live project — e.g. a control-plane replica routing to the placed
      // host — would otherwise trigger).
      const live = this.assigned.get(projectId)
      if (live) {
        // Only hand back the tracked VM if its firecracker process is still
        // alive. A dead process (crash, OOM-kill, or a lost suspend race) left
        // in the assigned map is a PHANTOM: we would return its guest URL as a
        // warm "reused" hit, the control plane would proxy to it and get
        // ECONNREFUSED/timeout ("Unable to connect" → 502), and because the
        // wake poll keeps touching the entry the idle reaper never clears it —
        // the preview then spins on "Waking things up" forever. Discard the
        // dead entry (reaping its leaked tap/socket) and fall through to a
        // fresh resume/boot so THIS open self-heals.
        if (this.mgr.isRunning(live.handle)) {
          live.lastTouchedAt = Date.now()
          // `reused`: re-attached an already-running VM (no boot, no resume).
          // The control plane records this as a warm hit, not a cold miss.
          return { handle: live.handle, mode: 'assigned' as const, reused: true }
        }
        console.warn(
          `[pool] assigned VM ${live.handle.id} for ${projectId} is dead (fc process gone) — discarding and reprovisioning`,
        )
        await this.discardDeadVm(live)
      }
      if (await this.canResume(projectId)) {
        try {
          const res = await this.resume(projectId, env)
          if (res)
            return {
              handle: res.assigned.handle,
              mode: 'resumed' as const,
              source: res.source,
              readyMs: res.readyMs,
            }
        } catch (err: any) {
          // A resume can throw on an unrestorable snapshot (e.g. the dm CoW
          // store went missing). Never surface that as a hard open failure —
          // drop the unusable LOCAL entry and fall through to a cold boot so the
          // project still opens. The durable copy (if any) is left intact.
          console.error(
            `[pool] resume failed for ${projectId}, falling back to cold boot:`,
            err?.message ?? err,
          )
          this.evictLocal(projectId)
        }
      }
      const a = await this.assign(projectId, env)
      return { handle: a.handle, mode: 'assigned' as const }
    })
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
    // openFlight value is never null here (assign throws on failure), but keep
    // the type honest for canResume races.
    return r as OpenResult
  }

  /** Claim + assign a warm VM to a project (or boot one on a cold miss). */
  async assign(projectId: string, env: Record<string, string> = {}): Promise<AssignedVm> {
    let vm = this.claim()
    if (!vm) vm = await this.heavy.run(() => this.bootOne(false))

    // The claimed/booted VM is now off the pool and not yet in `assigned`. If
    // the guest /pool/assign call fails or times out we must stop it, or its FC
    // process leaks (tracked by no map). Guard the whole in-flight window.
    this.inFlight.add(vm.handle.id)
    try {
      const res = await fetch(`${vm.handle.agentUrl}/pool/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, env }),
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`/pool/assign failed (${res.status}): ${await res.text()}`)
    } catch (err) {
      await this.mgr.stopVM(vm.handle).catch(() => {})
      throw err
    } finally {
      this.inFlight.delete(vm.handle.id)
    }

    const now = Date.now()
    const publishedSubdomain = publishedSubdomainFromEnv(env)
    const a: AssignedVm = {
      projectId,
      handle: vm.handle,
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      runtimeToken: env.RUNTIME_AUTH_SECRET,
      publishedSubdomain,
      // Provisional: a warm VM boots from the template. Promoted to 'backup'
      // below iff hydrate applies real source; a hydrate that CAN'T confirm the
      // template is correct fails the open rather than leave a mislabeled VM.
      workspaceOrigin: 'template',
    }
    this.assigned.set(projectId, a)
    this.writeLive(a)

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
    try {
      const h = await this.hydrateFromBackup(projectId, vm.handle, env)
      if (h.hydrated) {
        a.workspaceOrigin = 'backup'
        a.backupParentEtag = h.parentEtag
        this.writeLive(a)
      }
    } catch (err: any) {
      console.error(`[pool] hydrate-from-backup failed for ${projectId} — failing open (NOT serving template):`, err?.message ?? err)
      this.assigned.delete(projectId)
      this.live.remove(projectId)
      await this.mgr.stopVM(vm.handle).catch(() => {})
      throw err
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
    try {
      const d = await this.hydrateProjectData(projectId, vm.handle, env)
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

    // Server-backed published VM: overlay the live site's writable state
    // ({subdomain}/data.tar.gz) on top of the git-restored source so the app
    // boots with accumulated end-user data (not a fresh DB). Host-side — the
    // guest holds no S3 creds. Best-effort: a fresh/first publish has no archive.
    // Applied last so a published site's live data wins over the dev snapshot.
    if (publishedSubdomain) {
      await this.hydratePublishedData(publishedSubdomain, vm.handle, env).catch((err) =>
        console.error(`[pool] published-data hydrate failed for ${publishedSubdomain} (fresh DB):`, err?.message ?? err),
      )
    }
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
  ): Promise<{ hydrated: boolean; parentEtag?: string }> {
    const ref = await this.sourceRef(projectId)
    if (!ref) {
      console.log(`[pool] no durable backup for ${projectId} — cold start keeps template`)
      return { hydrated: false }
    }
    await this.applyArchive(handle, env, ref, `${projectId} source`)
    console.log(
      `[pool] hydrated ${projectId} from durable backup (${ref.bytes} bytes, etag=${ref.etag ?? 'none'})`,
    )
    return { hydrated: true, parentEtag: ref.etag ?? undefined }
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
        body: JSON.stringify({ url, bytes: ref.bytes, timeoutMs: budgetMs }),
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
      headers: { 'Content-Type': 'application/gzip', ...auth },
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
  protected async fetchExport(handle: FcVmHandle, token?: string): Promise<Uint8Array | null> {
    const res = await fetch(`${handle.agentUrl}/pool/export`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(this.cfg.hydrateTimeoutMs),
    })
    if (res.status === 204) return null
    if (!res.ok) throw new Error(`/pool/export failed (${res.status}): ${await res.text()}`)
    const buf = await res.arrayBuffer()
    return buf.byteLength ? new Uint8Array(buf) : null
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
    opts: { parentEtag?: string; adoptWhenUnknown?: boolean },
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
  private async saveBackupToStore(a: AssignedVm): Promise<void> {
    const bytes = await this.fetchExport(a.handle, a.runtimeToken)
    if (!bytes) {
      console.log(`[pool] no source to back up for ${a.projectId} (empty/new workspace)`)
      return
    }
    const outcome = await this.uploadBackupGuarded(a.projectId, bytes, {
      parentEtag: a.backupParentEtag,
      // Only a resumed legacy snapshot (origin 'snapshot' with no stamped ETag)
      // may overwrite an object it can't prove it descends from. A template
      // origin must NEVER adopt — that is exactly the clobber we prevent.
      adoptWhenUnknown: a.workspaceOrigin === 'snapshot',
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
        break
      case 'conflict': {
        metrics.inc(M.backupConflict)
        if (outcome.reason === 'size-regression') metrics.inc(M.backupSizeRegression)
        const why =
          outcome.reason === 'size-regression'
            ? `SIZE BACKSTOP tripped — this ${bytes.byteLength}-byte (template-shaped) export would have ` +
              `collapsed a real durable backup; refusing to adopt/overwrite`
            : `workspace lineage (origin=${a.workspaceOrigin ?? 'unknown'}, ` +
              `parentEtag=${a.backupParentEtag ?? 'none'}) does not match current backup ` +
              `(etag=${outcome.currentEtag ?? 'none'})`
        console.error(
          `[pool] REFUSED to overwrite durable backup for ${a.projectId} — ${why}. ` +
            `Export quarantined at ${outcome.quarantineKey} (${bytes.byteLength} bytes) — ` +
            `durable backup left intact.`,
        )
        break
      }
      case 'skipped':
        break
    }
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
  ): Promise<{ bytes: Uint8Array; tag: string | null } | 'unchanged' | 'unsupported' | null> {
    const res = await fetch(`${handle.agentUrl}/pool/export-data`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(knownTag ? { 'If-None-Match': knownTag } : {}),
      },
      signal: AbortSignal.timeout(this.cfg.hydrateTimeoutMs),
    })
    if (res.status === 304) return 'unchanged'
    if (res.status === 204) return null
    // A guest from before this endpoint existed. Distinguished from a real
    // failure because it is permanent for this VM and must not be retried.
    if (res.status === 404) return 'unsupported'
    if (!res.ok) throw new Error(`/pool/export-data failed (${res.status}): ${await res.text()}`)
    const buf = await res.arrayBuffer()
    if (!buf.byteLength) return null
    return { bytes: new Uint8Array(buf), tag: res.headers.get('etag') }
  }

  /** Guarded (conditional) upload of writable state. `protected` for tests. */
  protected uploadDataGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { lineage: DataLineage; preserveOnRefusal?: boolean },
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

  /** What this VM is entitled to do to the durable writable-state archive. */
  protected dataLineageOf(a: AssignedVm): DataLineage {
    if (a.dataUntrustedReason) return { kind: 'untrusted', reason: a.dataUntrustedReason }
    if (a.dataParentEtag) return { kind: 'descends', etag: a.dataParentEtag }
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
  async saveProjectDataToStore(a: AssignedVm, opts: { final?: boolean } = {}): Promise<boolean> {
    return this.dataFlight.run(a.projectId, () => this.saveProjectDataInner(a, opts))
  }

  private async saveProjectDataInner(
    a: AssignedVm,
    opts: { final?: boolean },
  ): Promise<boolean> {
    const lineage = this.dataLineageOf(a)

    // An untrusted VM can never write, so there is no point packing a database
    // and shipping it across the control channel to find that out. The only
    // exception is the final export, whose bytes we keep for recovery.
    if (lineage.kind === 'untrusted' && !opts.final) {
      metrics.inc(M.dataRefused)
      return false
    }

    // The guest short-circuits on an unchanged tag, so an idle project costs
    // one round-trip with no snapshot, no packing and no transfer.
    const known = this.dataTags.get(a.projectId)
    const exported = await this.fetchDataExport(a.handle, a.runtimeToken, known)
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

    const outcome = await this.uploadDataGuarded(a.projectId, bytes, {
      lineage,
      preserveOnRefusal: opts.final === true,
    })
    switch (outcome.status) {
      case 'created':
      case 'written': {
        // Re-anchor lineage to what we just wrote, from the PUT's own response,
        // so the next write's precondition matches without a second round-trip.
        a.dataParentEtag = outcome.etag ?? a.dataParentEtag
        a.dataUntrustedReason = undefined
        this.writeLive(a)
        if (tag) this.dataTags.set(a.projectId, tag)
        console.log(
          `[pool] saved writable state for ${a.projectId} ` +
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
            : `its lineage (etag=${a.dataParentEtag ?? 'none'}) no longer matches the durable archive`
        this.distrustData(a, why)
        console.error(
          `[pool] REFUSED to overwrite durable writable state for ${a.projectId} — ${why}. ` +
            `Durable archive left intact` +
            (outcome.quarantineKey ? `; export preserved at ${outcome.quarantineKey}` : '') +
            `.`,
        )
        return false
      }
      case 'refused': {
        metrics.inc(M.dataRefused)
        console.error(
          `[pool] writable state for ${a.projectId} NOT persisted — ${outcome.reason}. ` +
            `This project is running without durability` +
            (outcome.quarantineKey ? `; final export preserved at ${outcome.quarantineKey}` : '') +
            `.`,
        )
        return false
      }
      case 'too-large':
        metrics.inc(M.dataTooLarge)
        console.error(
          `[pool] writable state for ${a.projectId} is ${outcome.bytes} bytes, over the ` +
            `${outcome.limit}-byte durability limit — NOT persisted. This project's data is ` +
            `only as durable as its VM snapshot; it needs a real storage backend.`,
        )
        return false
      case 'skipped':
        return false
    }
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
    subdomain: string,
    handle: FcVmHandle,
    env: Record<string, string>,
  ): Promise<void> {
    const ref = await this.publishedDataRef(subdomain)
    if (!ref) {
      console.log(`[pool] no published-data archive for ${subdomain} — booting fresh DB`)
      return
    }
    // Goes through the same hydrate path as the other overlays: it extracts a
    // tar over the workspace tree, so a data.tar.gz rooted at the writable
    // paths (prisma/dev.db, uploads/) lands cleanly on the restored source.
    await this.applyArchive(handle, env, ref, `${subdomain} published data`)
    console.log(`[pool] hydrated published-data for ${subdomain} (${ref.bytes} bytes)`)
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
    if (!a.publishedSubdomain) return false
    const bytes = await this.fetchPublishedExport(a.handle, a.runtimeToken)
    if (!bytes) return false
    const uploaded = await this.uploadPublishedData(a.publishedSubdomain, bytes)
    if (uploaded) {
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

  /**
   * Suspend an assigned project to a snapshot, freeing host RAM.
   * quiesce guest → snapshot (local NVMe) → push to durable store (if enabled).
   * The durable push is best-effort: a failure leaves the hot local snapshot
   * intact so a same-host resume still works. Heavy steps run under the
   * host-wide semaphore; concurrent suspends for one project collapse.
   */
  async suspend(projectId: string): Promise<SuspendedVm> {
    return this.suspendFlight.run(projectId, async () => {
      const a = this.assigned.get(projectId)
      if (!a) throw new Error(`project ${projectId} not assigned`)

      // Write-side durability FIRST, while the guest is still fully live: pull
      // the latest source and push it to the durable S3 backup so a resume on a
      // DIFFERENT metal machine (snapshot miss) still cold-hydrates real source.
      // Best-effort — the snapshot below is the primary cross-host resume path.
      await this.saveBackupToStore(a).catch((err) =>
        console.error(`[pool] source backup for ${a.projectId} failed (snapshot still durable):`, err?.message ?? err),
      )

      // Same for writable state (database + uploads), and for the same reason:
      // the snapshot is not a backup. A rootfs rebuild invalidates every
      // snapshot at once, and the cold boot that follows restores source only —
      // so without this the user's data is gone.
      await this.saveProjectDataToStore(a, { final: true }).catch((err) =>
        console.error(`[pool] writable-state backup for ${a.projectId} failed:`, err?.message ?? err),
      )

      // Server-backed published VM: also flush the live writable state to the
      // published-data bucket so a resume on a DIFFERENT host (snapshot miss)
      // — or a republish/data-push — sees the latest end-user data.
      if (a.publishedSubdomain) {
        await this.exportPublishedData(a).catch((err) =>
          console.error(`[pool] published-data export for ${a.publishedSubdomain} failed (snapshot still durable):`, err?.message ?? err),
        )
      }

      await this.callGuestHook(a.handle.agentUrl, 'quiesce', this.cfg.quiesceTimeoutMs)
      const snapshot = await this.heavy.run(() => this.mgr.snapshotVM(a.handle))
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
        rootfsIdentity: this.rootfsId,
        backupEtag: a.backupParentEtag,
        dataEtag: this.trustedDataEtag(a),
      }
      this.suspended.set(projectId, s)
      this.writeIndex(s)

      if (this.store.kind !== 'none') {
        // Anti-clobber for the DURABLE SNAPSHOT tier (mirrors the backup guard):
        // a template-origin VM must not push a template snapshot over a real
        // one. If this workspace is still the template AND a durable snapshot
        // already exists, that existing snapshot descends from real source we
        // must not overwrite — keep the hot local snapshot and skip the push.
        // (A genuinely new project has origin 'template' but no durable snapshot
        // yet, so its first push still creates one.)
        if (a.workspaceOrigin === 'template' && (await this.store.head(projectId)) != null) {
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
          this.evictLocal(projectId)
          return s
        }
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
          baseIdentity: this.rootfsId,
          rootfsIdentity: this.rootfsId,
          backupEtag: a.backupParentEtag,
          dataEtag: this.trustedDataEtag(a),
          v: 1,
        }
        await this.heavy
          .run(() =>
            this.store.push(
              { vmstate: snapshot.snapshotPath, mem: snapshot.memFilePath, rootfs: durable.path },
              meta,
            ),
          )
          .catch((err) =>
            console.error(`[pool] durable push failed for ${projectId} (local snapshot kept):`, err?.message ?? err),
          )
      }
      return s
    })
  }

  private writeIndex(s: SuspendedVm): void {
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
      rootfsIdentity: this.rootfsId,
      backupEtag: s.backupEtag,
      dataEtag: s.dataEtag,
      v: 1,
    }
    this.index.put(e)
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
    return !!s.rootfsIdentity && s.rootfsIdentity !== this.rootfsId
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
  ): Promise<{ assigned: AssignedVm; apiMs: number; readyMs: number; source: 'local' | 'store' } | null> {
    let s = this.suspended.get(projectId)
    let source: 'local' | 'store' = 'local'

    // Rootfs-identity gate for the hot local copy (mirrors the durable pull()).
    // A snapshot from a different golden rootfs would restore stale guest code,
    // so drop it — reclaiming NVMe — and fall through to the durable pull (also
    // identity-gated) / cold boot, which brings the project up on new guest code.
    if (s && this.localSnapshotIsStale(s)) {
      console.log(
        `[pool] local snapshot for ${projectId} is stale (rootfs ${s.rootfsIdentity} != ${this.rootfsId}) — evicting and cold-booting for fresh guest code`,
      )
      this.evictLocal(projectId)
      s = undefined
    }

    if (!s) {
      if (this.store.kind === 'none') {
        metrics.inc(M.resumeColdMiss)
        return null
      }
      const pulled = await this.heavy.run(() => this.store.pull(projectId, this.cfg.snapDir, this.rootfsId))
      if (!pulled) {
        metrics.inc(M.resumeColdMiss)
        return null // absent or stale → cold boot
      }
      await assertArtifacts(pulled.files)
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
        bytesRootfs: allocatedBytes(pulled.files.rootfs),
      }
      s = {
        projectId,
        snapshot,
        suspendedAt: pulled.meta.createdAt,
        lastAccessAt: Date.now(),
        backupEtag: pulled.meta.backupEtag,
        dataEtag: pulled.meta.dataEtag,
      }
      source = 'store'
    }

    const t0 = performance.now()
    const handle = await this.heavy.run(() => this.mgr.restoreVM(s!.snapshot))
    const apiMs = performance.now() - t0
    // restoreVM self-cleans a partial restore; but a VM that restores yet never
    // becomes healthy (or fails rehydrate) is untracked here — stop it so the FC
    // process doesn't leak before open() falls back to a cold boot.
    this.inFlight.add(handle.id)
    let readyMs: number
    try {
      readyMs = await this.waitForHealth(handle, () => this.mgr.isRunning(handle))
      await this.callGuestHook(handle.agentUrl, 'rehydrate', this.cfg.rehydrateTimeoutMs)
    } catch (err) {
      await this.mgr.stopVM(handle).catch(() => {})
      throw err
    } finally {
      this.inFlight.delete(handle.id)
    }

    // Now live (assigned), not a cache entry: drop the suspended entry + index.
    this.suspended.delete(projectId)
    this.index.remove(projectId)
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle,
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      restoredFrom: { vmstate: s.snapshot.snapshotPath, mem: s.snapshot.memFilePath },
      // Carry the runtime token so /pool/export (source backup on suspend) and
      // adopt-on-restart keep working after a resume, not just after an assign.
      runtimeToken: env.RUNTIME_AUTH_SECRET || undefined,
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
    }
    this.assigned.set(projectId, a)
    this.writeLive(a)
    // Re-apply the injected env to the restored guest. A snapshot restore
    // brings back the process with the env baked at first assign, so any change
    // since then (AI-proxy URL/token, SHOGO_API_URL, rotated secrets) would be
    // stale until a cold boot — the root cause of the "provider connection
    // errors" incidents. Best-effort: a guest that predates /pool/refresh-env
    // 404s and keeps serving with its prior env.
    await this.refreshGuestEnv(handle, projectId, env).catch((err) =>
      console.error(
        `[pool] env refresh for ${projectId} failed (serving with prior env):`,
        err?.message ?? err,
      ),
    )
    metrics.inc(source === 'local' ? M.resumeLocalHits : M.resumeStoreHits)
    return { assigned: a, apiMs, readyMs: apiMs + readyMs, source }
  }

  /** Mark a project as active so the idle reaper doesn't suspend it. */
  touch(projectId: string): void {
    const a = this.assigned.get(projectId)
    if (a) a.lastTouchedAt = Date.now()
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
            lastAppRequestAt?: number | null
            appRequestCount?: number
            lastAgentRequestAt?: number | null
          }
          const last = typeof body.lastRequestAt === 'number' ? body.lastRequestAt : 0
          // Cache live-stream count so reapIdle can skip a project mid-generation
          // even when no new HTTP request has bumped lastRequestAt for a while.
          a.activeStreams = typeof body.activeStreams === 'number' ? body.activeStreams : 0
          if (a.activeStreams > 0) {
            a.lastTouchedAt = now // an active turn is activity
            a.lastRealActivityAt = now
          }
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

          if (typeof appAt === 'number') {
            const advanced = appAt > (a.lastAppRequestAt ?? 0)
            a.lastAppRequestAt = appAt
            if (advanced && !baselining) {
              a.lastTouchedAt = now
              a.lastRealActivityAt = now // an end user hit the app
            }
          }
          if (typeof agentAt === 'number') {
            const advanced = agentAt > (a.lastAgentRequestAt ?? 0)
            a.lastAgentRequestAt = agentAt
            if (advanced && !baselining) {
              a.lastTouchedAt = now
              a.lastRealActivityAt = now // someone talked to the agent
            }
          }
          if (typeof body.appRequestCount === 'number') a.appRequestCount = body.appRequestCount

          // Legacy runtime: no per-class signal exists, so the catch-all is the
          // best available proxy for a user and must keep the VM alive.
          if (!a.perClassActivity && catchAllAdvanced) {
            a.lastRealActivityAt = now
          }
        } catch {
          a.lastTouchedAt = now // fail open: never evict on missing data
        }
      }),
    )
  }

  /**
   * True if the project's guest is mid-generation — an active agent message
   * stream (`activeStreams > 0` from /pool/activity). Suspending it would
   * snapshot away a live turn, so both the explicit `/stop` and the idle reaper
   * consult this first. Fail-SAFE: a poll error → treat as busy (don't suspend
   * on an unknown state); a clean 404 (guest opts out) or `activeStreams:0` →
   * not busy. Only assigned (running) projects can be busy.
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
      const body = (await res.json()) as { activeStreams?: number }
      return (body.activeStreams ?? 0) > 0
    } catch {
      return true // can't confirm idleness → fail safe (don't suspend)
    }
  }

  /**
   * Suspend assigned VMs that have been idle past the threshold. Driven by the
   * reaper timer in server.ts. Returns the projectIds that were suspended.
   */
  async reapIdle(idleMs = this.cfg.idleSuspendMs): Promise<string[]> {
    if (idleMs <= 0) return []
    const now = Date.now()
    // Always-on projects (paid tiers) are never idle-suspended — the parity for
    // Knative's min-scale=1. They still resume fine if the agent restarts, but
    // during normal operation they stay resident.
    // Gate on guest-observed activity, not lastTouchedAt: see
    // `AssignedVm.lastRealActivityAt`. Falling back to assignedAt keeps a VM
    // that has never reported activity on a window measured from placement.
    const stale = [...this.assigned.values()].filter(
      (a) => !a.alwaysOn && now - (a.lastRealActivityAt ?? a.assignedAt) >= idleMs,
    )
    const done: string[] = []
    for (const a of stale) {
      // A long-running generation can outlast the idle window without any new
      // external request bumping lastTouchedAt, so also skip any VM the last
      // activity poll saw mid-stream — never snapshot away an active agent
      // message. (The reaper timer polls activity immediately before this.)
      if ((a.activeStreams ?? 0) > 0) continue
      try {
        await this.suspend(a.projectId)
        done.push(a.projectId)
      } catch (err: any) {
        console.error(`[pool] idle-suspend failed for ${a.projectId}:`, err?.message ?? err)
      }
    }
    return done
  }

  /**
   * Tear down a tracked VM whose firecracker process is already gone: drop it
   * from the assigned map + adopt-on-restart registry, then best-effort stopVM
   * to reclaim its leaked tap/socket/rootfs (the process is already dead, so
   * this only reclaims host resources + stale state). Shared by the open()
   * liveness gate and the dead-VM reaper. NOT for a live VM — that would kill a
   * running guest; callers must confirm `!isRunning` first.
   */
  private async discardDeadVm(a: AssignedVm): Promise<void> {
    this.assigned.delete(a.projectId)
    this.live.remove(a.projectId)
    await this.mgr.stopVM(a.handle).catch(() => {})
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
    const dead = [...this.assigned.values()].filter((a) => !this.mgr.isRunning(a.handle))
    const reaped: string[] = []
    for (const a of dead) {
      console.warn(`[pool] reaping dead assigned VM ${a.handle.id} for ${a.projectId} (fc process gone)`)
      await this.discardDeadVm(a)
      reaped.push(a.projectId)
    }
    return reaped
  }

  getAssigned(projectId: string): AssignedVm | undefined {
    return this.assigned.get(projectId)
  }

  /**
   * Apply a live instance-tier change to an assigned project. Firecracker can't
   * hot-change vCPU/RAM, so those take effect on the NEXT cold boot/resume (the
   * assign env is re-read then). What we CAN apply immediately is the always-on
   * flag: an upgrade (alwaysOn=true) makes the reaper skip this VM right away, a
   * downgrade re-arms idle-suspend. No-op when the project isn't live on this
   * host. Returns true when a live VM was updated.
   */
  applyResize(projectId: string, opts: { alwaysOn?: boolean }): boolean {
    const a = this.assigned.get(projectId)
    if (!a) return false
    if (opts.alwaysOn !== undefined && !!a.alwaysOn !== opts.alwaysOn) {
      a.alwaysOn = opts.alwaysOn
      this.writeLive(a)
    }
    return true
  }

  // --- GC / cache management ------------------------------------------------

  /** Bytes a suspended snapshot occupies on local NVMe (CoW-aware rootfs). */
  private entryBytes(s: SuspendedVm): number {
    return (s.snapshot.bytesMem ?? 0) + (s.snapshot.bytesState ?? 0) + (s.snapshot.bytesRootfs ?? 0)
  }

  private cacheBytes(): number {
    let n = 0
    for (const s of this.suspended.values()) n += this.entryBytes(s)
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
    const orphansRemoved = this.reclaimOrphans()
    const staleReclaim = this.reclaimStaleSnapshots()

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
   * Bounded per sweep, following `reconcileOrphanDevices`: on a host holding
   * thousands of these, unlinking every multi-gigabyte memory file in one pass
   * would stall the GC timer behind a burst of I/O. The backlog drains over a
   * few minutes of sweeps instead.
   */
  private reclaimStaleSnapshots(max = STALE_RECLAIM_PER_SWEEP): { projectIds: string[]; bytes: number } {
    const projectIds: string[] = []
    let bytes = 0
    for (const s of this.suspended.values()) {
      if (projectIds.length >= max) break
      if (!this.localSnapshotIsStale(s)) continue
      const id = s.projectId
      // Never race the paths that own the entry: a running VM is not suspended
      // at all, and an in-flight open is already deciding this snapshot's fate.
      if (this.assigned.has(id)) continue
      if (this.openFlight.has(id) || this.suspendFlight.has(id)) continue
      const b = this.entryBytes(s)
      if (!this.evictLocal(id)) continue
      projectIds.push(id)
      bytes += b
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
    if (this.openFlight.has(projectId) || this.suspendFlight.has(projectId)) return false // in-flight

    if (!opts.alsoDurable) {
      // Must be durably backed & fresh before we drop the only local copy.
      if (this.store.kind === 'none') return false
      const head = await this.store.head(projectId)
      if (!head || head.rootfsIdentity !== this.rootfsId) return false
    }

    this.deleteLocalArtifacts(s.snapshot)
    this.suspended.delete(projectId)
    this.index.remove(projectId)

    if (opts.alsoDurable && this.store.kind !== 'none') {
      await this.store.remove(projectId).catch(() => {})
    }
    return true
  }

  private deleteLocalArtifacts(snap: FcSnapshot): void {
    for (const p of [snap.snapshotPath, snap.memFilePath]) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* ignore */
      }
    }
    // rootfs may be a dm device / cow file — route through the manager so dm
    // resources are torn down correctly.
    try {
      this.mgr.releaseRootfs(snap.rootfs)
    } catch {
      /* ignore */
    }
    // Release the /30 as well. A suspended VM keeps its tap so it can restore
    // onto the same device cheaply, which means dropping the snapshot is the
    // moment that device stops being wanted — and every caller here (eviction,
    // stale reclaim, destroy) previously leaked it. Guarded because a resumed
    // project can still carry a `suspended` entry pointing at the net its LIVE
    // VM restored onto; tearing that down would cut a running guest's network.
    if (!this.tapHeldByRunningVm(snap.net)) {
      try {
        this.mgr.releaseTap(snap.net)
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
  reclaimOrphans(): number {
    const protectedPaths = new Set<string>()
    for (const vm of this.available) protectedPaths.add(vm.handle.rootfs)
    for (const a of this.assigned.values()) {
      protectedPaths.add(a.handle.rootfs)
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
    for (const s of this.suspended.values()) {
      protectedPaths.add(s.snapshot.snapshotPath)
      protectedPaths.add(s.snapshot.memFilePath)
      protectedPaths.add(s.snapshot.rootfs)
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
    const sweepDir = (dir: string, match: (name: string) => boolean, isRootfs = false): void => {
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
        if (isRootfs && this.cfg.rootfsCow === 'dm') {
          const vmId = name.replace(/\.cow$/, '')
          if (protectedPaths.has(`/dev/mapper/mvm-${vmId}`)) continue
          if (this.mgr.rootfsDeviceMapped(vmId)) continue
        }
        // Age gate: skip artifacts still within the in-flight grace window.
        try {
          if (statSync(full).mtimeMs > cutoff) continue
        } catch {
          continue // vanished under us — nothing to reclaim
        }
        try {
          if (isRootfs) this.mgr.releaseRootfs(full)
          else rmSync(full, { force: true })
          removed++
        } catch {
          /* ignore */
        }
      }
    }

    sweepDir(this.cfg.snapDir, (n) => n.endsWith('.vmstate') || n.endsWith('.mem'))
    sweepDir(this.cfg.runDir, (n) => n.endsWith('.rootfs.ext4'), true)
    if (this.cfg.rootfsCow === 'dm') sweepDir(this.cfg.dmCowDir, (n) => n.endsWith('.cow'), true)
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
    return ids
  }

  /**
   * Reclaim leaked dm devices / loops / CoW files that belong to no VM the pool
   * tracks — the catch-up net for teardown races (a failed "busy" `dmsetup
   * remove` orphaned the device, which then pinned its CoW past the GC's sweep).
   * Bounded per call; driven by the GC timer. Returns the number reclaimed.
   */
  reconcileOrphanDevices(): number {
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
    return idx
  }

  /**
   * How much of the host's /30 space is occupied, straight from `ip link` rather
   * than the GC's last sweep — so it is still the truth on a host with the GC
   * turned off, which is exactly where a leak would run unchecked.
   */
  tapUsage(): { inUse: number; capacity: number } {
    return { inUse: existingTapIndices().size, capacity: TAP_NET_CAPACITY }
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
  reapOrphanTaps(): number {
    const { removed, suspected, inUse } = this.mgr.reconcileOrphanTaps(this.ownedTapIndices(), ORPHAN_GRACE_MS)
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

    // Only dm mode has exception stores to run out of; the other rootfs modes
    // give each VM its own file and fail with an ordinary ENOSPC.
    if (this.cfg.rootfsCow !== 'dm') return
    const cow = this.mgr.sampleCowUsage()
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
   * gauges. A VM counts as `agentActive` if it reported an in-flight agent turn
   * at the last poll, `appActive` if it served end-user app traffic within
   * {@link APP_ACTIVE_WINDOW_MS}, and `idleTail` otherwise (running but neither
   * being used nor edited — the 30-min idle-suspend tail). agent-active wins
   * when a VM is both, so the buckets are disjoint and sum to `assigned.size`.
   */
  private classifyAssigned(now = Date.now()): { appActive: number; agentActive: number; idleTail: number } {
    let appActive = 0
    let agentActive = 0
    let idleTail = 0
    for (const a of this.assigned.values()) {
      if ((a.activeStreams ?? 0) > 0) agentActive++
      else if (a.lastAppRequestAt && now - a.lastAppRequestAt <= APP_ACTIVE_WINDOW_MS) appActive++
      else idleTail++
    }
    return { appActive, agentActive, idleTail }
  }

  /**
   * Drop the hot local snapshot (in-memory entry + on-disk artifacts) WITHOUT
   * touching the durable store. Simulates node-agent restart / a different host
   * so the next resume must pull from the store — the cross-host mobility path.
   * Test/ops hook; not part of the normal request flow.
   */
  evictLocal(projectId: string): boolean {
    const s = this.suspended.get(projectId)
    if (!s) return false
    this.deleteLocalArtifacts(s.snapshot)
    this.suspended.delete(projectId)
    this.index.remove(projectId)
    return true
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
      this.assigned.delete(projectId)
      this.live.remove(projectId)
      stoppedVm = true
    }

    const s = this.suspended.get(projectId)
    if (s) {
      this.deleteLocalArtifacts(s.snapshot)
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
   * Project-scoped status for the control-plane substrate `getStatus()` — the
   * metal analog of KnativeProjectManager.getStatus (exists/ready/replicas).
   *   assigned  → running (replicas 1)
   *   suspended → exists but scaled-to-zero (replicas 0, resumable)
   *   neither   → does not exist here
   */
  getProjectStatus(projectId: string): {
    exists: boolean
    ready: boolean
    replicas: number
    url?: string
    state: 'assigned' | 'suspended' | 'none'
  } {
    const a = this.assigned.get(projectId)
    if (a) return { exists: true, ready: true, replicas: 1, url: a.handle.agentUrl, state: 'assigned' }
    if (this.suspended.has(projectId)) return { exists: true, ready: false, replicas: 0, state: 'suspended' }
    return { exists: false, ready: false, replicas: 0, state: 'none' }
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
    }
  }

  status() {
    const now = Date.now()
    this.publishGauges()
    const liveness = this.classifyAssigned(now)
    return {
      store: this.store.kind,
      idleSuspendMs: this.cfg.idleSuspendMs,
      rootfsCow: this.cfg.rootfsCow,
      disk: this.disk(),
      cache: { localCount: this.suspended.size, localBytes: this.cacheBytes() },
      available: this.available.length,
      // Assigned (running) set decomposed by why each VM is live, so the raw
      // count can be read as app-users + agent-turns + idle-tail.
      liveness,
      // Live FC processes vs tracked VMs — a growing gap flags a process leak.
      fcProcs: this.mgr.procCount(),
      assigned: [...this.assigned.values()].map((a) => ({
        projectId: a.projectId,
        url: a.handle.agentUrl,
        vmId: a.handle.id,
        idleMs: now - a.lastTouchedAt,
        // What reapIdle actually compares against idleSuspendMs. Diverges from
        // idleMs by however much routing polls / fail-open have touched the VM.
        realIdleMs: now - (a.lastRealActivityAt ?? a.assignedAt),
        // Per-class liveness (see AssignedVm). `*IdleMs: null` = no request of
        // that class observed yet; `activeStreams>0` = an agent turn in flight.
        activeStreams: a.activeStreams ?? 0,
        appIdleMs: a.lastAppRequestAt ? now - a.lastAppRequestAt : null,
        appRequestCount: a.appRequestCount ?? 0,
        agentIdleMs: a.lastAgentRequestAt ? now - a.lastAgentRequestAt : null,
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

export interface OpenResult {
  handle: FcVmHandle
  mode: 'assigned' | 'resumed'
  source?: 'local' | 'store'
  readyMs?: number
  /** `mode:'assigned'` re-attached an already-running VM rather than a fresh
   * cold claim. Reported to the control plane so it records a warm hit. */
  reused?: boolean
}
