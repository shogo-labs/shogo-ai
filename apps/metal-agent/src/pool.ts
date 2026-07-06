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
import { M, metrics } from './metrics'
import {
  assertArtifacts,
  computeRootfsIdentity,
  createSnapshotStore,
  type SnapshotMeta,
  type SnapshotStore,
} from './snapshot-store'

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

  async start(): Promise<void> {
    this.rehydrate()
    await this.reconcile()
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
        return { handle: live.handle, mode: 'assigned' as const }
      }
      if (await this.canResume(projectId)) {
        try {
          const res = await this.resume(projectId)
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
    return a
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

      await this.callGuestHook(a.handle.agentUrl, 'quiesce', this.cfg.quiesceTimeoutMs)
      const snapshot = await this.heavy.run(() => this.mgr.snapshotVM(a.handle))
      this.assigned.delete(projectId)
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
    }
    this.assigned.set(projectId, a)
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
          const body = (await res.json()) as { lastRequestAt?: number }
          const last = typeof body.lastRequestAt === 'number' ? body.lastRequestAt : 0
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
   * Suspend assigned VMs that have been idle past the threshold. Driven by the
   * reaper timer in server.ts. Returns the projectIds that were suspended.
   */
  async reapIdle(idleMs = this.cfg.idleSuspendMs): Promise<string[]> {
    if (idleMs <= 0) return []
    const now = Date.now()
    const stale = [...this.assigned.values()].filter((a) => now - a.lastTouchedAt >= idleMs)
    const done: string[] = []
    for (const a of stale) {
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
}
