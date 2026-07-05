// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * MetalWarmPool — the bare-metal analog of apps/api's VMWarmPoolController and
 * the cloud WarmPoolController. Maintains a pool of pre-booted Firecracker
 * microVMs (pool-agent in PROJECT_ID=__POOL__ mode), claims + assigns them via
 * the same POST /pool/assign contract, and adds the substrate's headline
 * capability: suspend-to-snapshot on idle / restore-from-snapshot on open.
 *
 * Deliberately compact vs. the desktop controller (no LRU cap / balloon
 * right-sizing yet) — those transfer directly once this is wired behind the
 * `metal` pod-mode in resolveProjectPodUrl (Phase 4).
 */

import { rmSync } from 'fs'
import { config } from './config'
import { FirecrackerVMManager, type FcVmHandle, type FcSnapshot } from './firecracker-vm-manager'
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
}

export interface SuspendedVm {
  projectId: string
  snapshot: FcSnapshot
  suspendedAt: number
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

  constructor(
    private mgr = new FirecrackerVMManager(),
    private cfg = config,
    store?: SnapshotStore,
  ) {
    this.store = store ?? createSnapshotStore(cfg)
    this.rootfsId = computeRootfsIdentity(cfg)
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
    await this.waitForHealth(handle, () => this.mgr.isRunning(handle))
    return { handle, ready: true, createdAt: Date.now() }
  }

  /** Fill the pool to target size. */
  async reconcile(): Promise<void> {
    const need = this.cfg.poolSize - this.available.length
    const boots: Promise<void>[] = []
    for (let i = 0; i < need; i++) {
      boots.push(
        this.bootOne().then((vm) => {
          this.available.push(vm)
        }),
      )
    }
    await Promise.all(boots)
  }

  async start(): Promise<void> {
    await this.reconcile()
  }

  private claim(): PooledVm | null {
    const idx = this.available.findIndex((v) => v.ready)
    if (idx === -1) return null
    const [vm] = this.available.splice(idx, 1)
    // Replace in background.
    this.reconcile().catch(() => {})
    return vm
  }

  /** Claim + assign a warm VM to a project (or boot one on a cold miss). */
  async assign(projectId: string, env: Record<string, string> = {}): Promise<AssignedVm> {
    let vm = this.claim()
    if (!vm) vm = await this.bootOne(false)

    const res = await fetch(`${vm.handle.agentUrl}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, env }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`/pool/assign failed (${res.status}): ${await res.text()}`)

    const now = Date.now()
    const a: AssignedVm = { projectId, handle: vm.handle, assignedAt: now, lastTouchedAt: now }
    this.assigned.set(projectId, a)
    return a
  }

  /**
   * Suspend an assigned project to a snapshot, freeing host RAM.
   * quiesce guest → snapshot (local NVMe) → push to durable store (if enabled).
   * The durable push is best-effort: a failure leaves the hot local snapshot
   * intact so a same-host resume still works.
   */
  async suspend(projectId: string): Promise<SuspendedVm> {
    const a = this.assigned.get(projectId)
    if (!a) throw new Error(`project ${projectId} not assigned`)

    await this.callGuestHook(a.handle.agentUrl, 'quiesce', this.cfg.quiesceTimeoutMs)
    const snapshot = await this.mgr.snapshotVM(a.handle)
    this.assigned.delete(projectId)
    const s: SuspendedVm = { projectId, snapshot, suspendedAt: Date.now() }
    this.suspended.set(projectId, s)

    if (this.store.kind !== 'none') {
      const meta: SnapshotMeta = {
        projectId,
        net: snapshot.net,
        vcpus: snapshot.vcpus,
        memoryMB: snapshot.memoryMB,
        bytesMem: snapshot.bytesMem,
        bytesState: snapshot.bytesState,
        createdAt: snapshot.createdAt,
        rootfsPath: snapshot.rootfs,
        rootfsIdentity: this.rootfsId,
        v: 1,
      }
      await this.store
        .push({ vmstate: snapshot.snapshotPath, mem: snapshot.memFilePath, rootfs: snapshot.rootfs }, meta)
        .catch((err) => console.error(`[pool] durable push failed for ${projectId} (local snapshot kept):`, err?.message ?? err))
    }
    return s
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
  async resume(projectId: string): Promise<{ assigned: AssignedVm; apiMs: number; readyMs: number; source: 'local' | 'store' } | null> {
    let s = this.suspended.get(projectId)
    let source: 'local' | 'store' = 'local'

    if (!s) {
      if (this.store.kind === 'none') return null
      const pulled = await this.store.pull(projectId, this.cfg.snapDir, this.rootfsId)
      if (!pulled) return null // absent or stale → cold boot
      await assertArtifacts(pulled.files)
      const snapshot: FcSnapshot = {
        vmId: `restored-${projectId}`,
        snapshotPath: pulled.files.vmstate,
        memFilePath: pulled.files.mem,
        rootfs: pulled.files.rootfs,
        net: pulled.meta.net,
        vcpus: pulled.meta.vcpus,
        memoryMB: pulled.meta.memoryMB,
        createdAt: pulled.meta.createdAt,
        bytesMem: pulled.meta.bytesMem,
        bytesState: pulled.meta.bytesState,
      }
      s = { projectId, snapshot, suspendedAt: pulled.meta.createdAt }
      source = 'store'
    }

    const t0 = performance.now()
    const handle = await this.mgr.restoreVM(s.snapshot)
    const apiMs = performance.now() - t0
    const readyMs = await this.waitForHealth(handle, () => this.mgr.isRunning(handle))

    await this.callGuestHook(handle.agentUrl, 'rehydrate', this.cfg.rehydrateTimeoutMs)

    this.suspended.delete(projectId)
    const now = Date.now()
    const a: AssignedVm = { projectId, handle, assignedAt: now, lastTouchedAt: now }
    this.assigned.set(projectId, a)
    return { assigned: a, apiMs, readyMs: apiMs + readyMs, source }
  }

  /** Mark a project as active so the idle reaper doesn't suspend it. */
  touch(projectId: string): void {
    const a = this.assigned.get(projectId)
    if (a) a.lastTouchedAt = Date.now()
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

  /**
   * Drop the hot local snapshot (in-memory entry + on-disk artifacts) WITHOUT
   * touching the durable store. Simulates node-agent restart / a different host
   * so the next resume must pull from the store — the cross-host mobility path.
   * Test/ops hook; not part of the normal request flow.
   */
  evictLocal(projectId: string): boolean {
    const s = this.suspended.get(projectId)
    if (!s) return false
    for (const p of [s.snapshot.snapshotPath, s.snapshot.memFilePath, s.snapshot.rootfs]) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* ignore */
      }
    }
    this.suspended.delete(projectId)
    return true
  }

  status() {
    const now = Date.now()
    return {
      store: this.store.kind,
      idleSuspendMs: this.cfg.idleSuspendMs,
      available: this.available.length,
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
