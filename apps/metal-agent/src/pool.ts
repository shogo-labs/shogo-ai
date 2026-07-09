// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * MetalWarmPool — the bare-metal analog of apps/api's VMWarmPoolController and
 * the cloud WarmPoolController. Maintains a pool of pre-booted Firecracker
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
import { config } from './config'
import { allocatedBytes, diskUsage, type DiskUsage } from './disk'
import { FirecrackerVMManager, type FcVmHandle, type FcSnapshot } from './firecracker-vm-manager'
import { planEvictions, type EvictionCandidate } from './gc-policy'
import { LiveRegistry, pidAlive } from './live-registry'
import { M, metrics } from './metrics'
import { tapIndex, existingTapIndices } from './net'
import {
  assertArtifacts,
  computeRootfsIdentity,
  createSnapshotStore,
  type SnapshotMeta,
  type SnapshotStore,
} from './snapshot-store'
import { fetchWorkspaceArchive, uploadWorkspaceArchive } from './workspace-archive'

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
   * Active agent message streams the guest reported at the last activity poll.
   * `> 0` means a live generation is in flight, so the idle reaper must not
   * snapshot the VM away (it would kill the turn). Refreshed each pollActivity.
   */
  activeStreams?: number
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
}

export interface SuspendedVm {
  projectId: string
  snapshot: FcSnapshot
  suspendedAt: number
  lastAccessAt: number
}

export interface GcReport {
  triggered: boolean
  evicted: string[]
  durableRemoved: string[]
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
  /** Caps concurrent heavy NVMe ops (snapshot / restore / store pull|push). */
  private heavy: Semaphore
  /** Single-flight guard for pool fills (see reconcile). */
  private reconciling: Promise<void> | null = null

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
        handle,
        assignedAt: e.assignedAt,
        lastTouchedAt: Date.now(),
        restoredFrom: e.restoredFrom,
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
        live.lastTouchedAt = Date.now()
        // `reused`: re-attached an already-running VM (no boot, no resume). The
        // control plane records this as a warm hit, not a cold miss.
        return { handle: live.handle, mode: 'assigned' as const, reused: true }
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
    const a = this.assigned.get(projectId)
    if (a) {
      const token = env.RUNTIME_AUTH_SECRET || a.runtimeToken
      if (!!a.alwaysOn !== alwaysOn || a.runtimeToken !== token) {
        a.alwaysOn = alwaysOn
        a.runtimeToken = token
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
    const a: AssignedVm = { projectId, handle: vm.handle, assignedAt: now, lastTouchedAt: now }
    this.assigned.set(projectId, a)
    this.writeLive(a)

    // Cold miss: this warm VM booted from the TEMPLATE, so its workspace is the
    // "Project Ready" placeholder — the project's real source lives only in the
    // durable S3 backup. (Resume-from-snapshot in open() already carries the
    // real workspace and never lands here.) Hydrate host-side so the guest gets
    // its source without ever holding S3 credentials. Best-effort: on failure we
    // leave the template in place rather than fail the open.
    await this.hydrateFromBackup(projectId, vm.handle, env).catch((err) =>
      console.error(`[pool] hydrate-from-backup failed for ${projectId} (serving template):`, err?.message ?? err),
    )
    return a
  }

  /**
   * Cold-start hydration: pull the project's durable source backup from S3
   * (host-side — the guest has no S3 creds) and stream it to the guest's
   * `/pool/hydrate` control endpoint, which extracts it over the template and
   * rebuilds. Authenticated with the same RUNTIME_AUTH_SECRET the API injected
   * into the guest via `/pool/assign`. No durable backup (a brand-new project)
   * is a no-op — the template is the correct initial state.
   */
  /**
   * Fetch the durable source backup for a project. A `protected` seam so tests
   * can inject a canned archive (or `null`) without touching S3 or module mocks.
   */
  protected fetchArchive(projectId: string): Promise<Uint8Array | null> {
    return fetchWorkspaceArchive(projectId, this.cfg)
  }

  private async hydrateFromBackup(
    projectId: string,
    handle: FcVmHandle,
    env: Record<string, string>,
  ): Promise<void> {
    const archive = await this.fetchArchive(projectId)
    if (!archive) {
      console.log(`[pool] no durable backup for ${projectId} — cold start keeps template`)
      return
    }
    const token = env.RUNTIME_AUTH_SECRET
    const res = await fetch(`${handle.agentUrl}/pool/hydrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: archive,
      signal: AbortSignal.timeout(this.cfg.hydrateTimeoutMs),
    })
    if (!res.ok) throw new Error(`/pool/hydrate failed (${res.status}): ${await res.text()}`)
    console.log(`[pool] hydrated ${projectId} from durable backup (${archive.byteLength} bytes)`)
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
   * Upload the packed source to the durable store. A `protected` seam mirroring
   * `fetchArchive`/`fetchExport` so tests exercise the save wiring without S3.
   */
  protected uploadBackup(projectId: string, bytes: Uint8Array): Promise<boolean> {
    return uploadWorkspaceArchive(projectId, bytes, this.cfg)
  }

  private async saveBackupToStore(a: AssignedVm): Promise<void> {
    const bytes = await this.fetchExport(a.handle, a.runtimeToken)
    if (!bytes) {
      console.log(`[pool] no source to back up for ${a.projectId} (empty/new workspace)`)
      return
    }
    const uploaded = await this.uploadBackup(a.projectId, bytes)
    if (uploaded) {
      console.log(`[pool] saved source backup for ${a.projectId} (${bytes.byteLength} bytes)`)
    }
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

      await this.callGuestHook(a.handle.agentUrl, 'quiesce', this.cfg.quiesceTimeoutMs)
      const snapshot = await this.heavy.run(() => this.mgr.snapshotVM(a.handle))
      this.assigned.delete(projectId)
      this.live.remove(projectId) // no longer a live process — snapshot is the source of truth
      const now = Date.now()
      const lastAccessAt = Math.max(a.lastTouchedAt, now)
      const s: SuspendedVm = { projectId, snapshot, suspendedAt: now, lastAccessAt }
      this.suspended.set(projectId, s)
      this.writeIndex(s)

      if (this.store.kind !== 'none') {
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
      s = { projectId, snapshot, suspendedAt: pulled.meta.createdAt, lastAccessAt: Date.now() }
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
      restoredFrom: { vmstate: s.snapshot.snapshotPath, mem: s.snapshot.memFilePath },
      // Carry the runtime token so /pool/export (source backup on suspend) and
      // adopt-on-restart keep working after a resume, not just after an assign.
      runtimeToken: env.RUNTIME_AUTH_SECRET || undefined,
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
   * would suspend or evict busy projects. We poll each assigned guest's
   * /pool/activity; a newer lastRequestAt (or a failed poll — fail open) bumps
   * lastTouchedAt. Best-effort; a guest without the endpoint is treated as
   * quietly active only when the poll times out, not on a clean 404.
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
          const body = (await res.json()) as { lastRequestAt?: number; activeStreams?: number }
          const last = typeof body.lastRequestAt === 'number' ? body.lastRequestAt : 0
          // Cache live-stream count so reapIdle can skip a project mid-generation
          // even when no new HTTP request has bumped lastRequestAt for a while.
          a.activeStreams = typeof body.activeStreams === 'number' ? body.activeStreams : 0
          if (a.activeStreams > 0) a.lastTouchedAt = now // an active turn is activity
          if (a.lastActivityAt === undefined) a.lastActivityAt = last
          if (last > a.lastActivityAt) {
            a.lastActivityAt = last
            a.lastTouchedAt = now // real traffic since we last looked
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
    const stale = [...this.assigned.values()].filter(
      (a) => !a.alwaysOn && now - a.lastTouchedAt >= idleMs,
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

    metrics.inc(M.gcEvicted, evict.length)
    metrics.inc(M.gcBytesReclaimed, bytesReclaimed)
    metrics.inc(M.gcOrphansRemoved, orphansRemoved)
    metrics.inc(M.gcDurableRemoved, durableRemoved.length)
    this.publishGauges()

    const after = this.disk()
    if (evict.length || orphansRemoved) {
      console.log(
        `[pool] gc: evicted=${evict.length} durableDropped=${durableRemoved.length} orphans=${orphansRemoved} ` +
          `reclaimed=${(bytesReclaimed / 1e9).toFixed(2)}GB used=${after.usedPct.toFixed(1)}%`,
      )
    }
    return { triggered: decision.triggered, evicted: evict, durableRemoved, orphansRemoved, bytesReclaimed, disk: after }
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

  private publishGauges(): void {
    const disk = this.disk()
    metrics.gauge(M.diskUsedPct, +disk.usedPct.toFixed(2))
    metrics.gauge(M.diskFreeBytes, disk.freeBytes)
    metrics.gauge(M.cacheLocalCount, this.suspended.size)
    metrics.gauge(M.cacheLocalBytes, this.cacheBytes())
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
    return {
      store: this.store.kind,
      idleSuspendMs: this.cfg.idleSuspendMs,
      rootfsCow: this.cfg.rootfsCow,
      disk: this.disk(),
      cache: { localCount: this.suspended.size, localBytes: this.cacheBytes() },
      available: this.available.length,
      // Live FC processes vs tracked VMs — a growing gap flags a process leak.
      fcProcs: this.mgr.procCount(),
      assigned: [...this.assigned.values()].map((a) => ({
        projectId: a.projectId,
        url: a.handle.agentUrl,
        vmId: a.handle.id,
        idleMs: now - a.lastTouchedAt,
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
