// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * VM Warm Pool Controller
 *
 * Desktop equivalent of WarmPoolController — maintains a small pool of pre-booted
 * VMs, each running agent-runtime in pool mode (PROJECT_ID=__POOL__). When a user
 * opens a project, the VM is claimed and assigned via the same /pool/assign HTTP
 * contract used by K8s pods.
 *
 * Unlike the K8s pool (which manages Knative Services), this manages local VMs
 * through DarwinVMManager or Win32VMManager from the desktop VM layer.
 */

import { buildProjectEnv } from './runtime/build-project-env'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const POOL_SIZE = parseInt(process.env.VM_POOL_SIZE || '1', 10)
const RECONCILE_INTERVAL_MS = parseInt(process.env.VM_POOL_RECONCILE_INTERVAL || '30000', 10)
const HEALTH_CHECK_RETRIES = parseInt(process.env.VM_HEALTH_CHECK_RETRIES || '120', 10)
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.VM_HEALTH_CHECK_INTERVAL || '2000', 10)

// Idle-eviction reaper: stop any assigned VM whose project hasn't been touched
// (getProjectUrl / external touch) for this long. Mirrors the cloud
// WarmPoolController.gc.idleEvictions path. Default 10 min; disable with 0.
const IDLE_EVICTION_MS = parseInt(process.env.VM_IDLE_EVICTION_MS || `${10 * 60 * 1000}`, 10)

// Hard cap on concurrent assigned VMs so opening many projects can't OOM the
// host. 0 = auto: derive from host free memory / vmMemoryMB at start().
const ASSIGNED_VM_CAP_ENV = process.env.VM_MAX_ASSIGNED
  ? parseInt(process.env.VM_MAX_ASSIGNED, 10)
  : 0

// Absolute ceiling for the auto-computed cap. Even on a 256 GB workstation
// we never want a *single user session* to book more than this many 4 GB
// VMs — opening more projects than this should LRU-evict, not spawn more
// QEMUs. Set with `VM_MAX_HARD_CAP` (default 4). `VM_MAX_ASSIGNED` still
// overrides everything.
const MAX_VM_HARD_CAP = Math.max(1, parseInt(process.env.VM_MAX_HARD_CAP || '4', 10))

export interface VMPodInfo {
  id: string
  vmId: string
  url: string
  createdAt: number
  ready: boolean
  assignedAt?: number
  /**
   * Last time someone asked for this project's URL (or otherwise signalled
   * it's still in use). Used by the idle-eviction reaper. Refreshed on every
   * successful getProjectUrl() and on explicit touch().
   */
  lastTouchedAt?: number
  projectId?: string
}

interface VMManagerHandle {
  id: string
  agentUrl: string
  pid: number
  platform: 'darwin' | 'win32'
}

export interface VMManagerInterface {
  startVM(config: any): Promise<VMManagerHandle>
  stopVM(handle: VMManagerHandle): Promise<void>
  isRunning(handle: VMManagerHandle): boolean
  forwardPort(handle: VMManagerHandle, guestPort: number, hostPort: number): Promise<void>
  removeForward(handle: VMManagerHandle, hostPort: number): Promise<void>
  /**
   * Optional. Adjust the guest's available RAM via virtio-balloon.
   * `targetMB` is the guest-visible amount of memory after the change.
   * Implementations should be a no-op when the VM has no balloon device.
   */
  setBalloonTargetMB?(handle: VMManagerHandle, targetMB: number): Promise<void>
}

/**
 * Factory that produces a fresh VMManager for each VM. Needed because
 * DarwinVMManager only supports one active VM at a time, so the pool
 * must use separate instances for the assigned VM and the warming VM.
 */
export type VMManagerFactory = () => VMManagerInterface

const MAX_CONSECUTIVE_FAILURES = 3

/**
 * Thrown when `_assignProject` is called but the warm pool has permanently
 * disabled itself after exceeding `MAX_CONSECUTIVE_FAILURES` VM boot failures.
 * This is a dedicated type so callers (e.g. project-chat `getProjectUrl`) can
 * distinguish a permanent capability failure from a transient boot error and,
 * on the desktop, fall back to the host RuntimeManager path safely — no VM is
 * ever going to come back up in this session, so the "split-brain" concern
 * that normally forbids that fallback does not apply.
 */
export class VMPoolPermanentlyDisabledError extends Error {
  readonly code = 'VM_POOL_PERMANENTLY_DISABLED'
  constructor(public readonly consecutiveFailures: number) {
    super(
      `VM warm pool disabled after ${consecutiveFailures} consecutive boot failures. ` +
        `QEMU/WHPX cannot boot an agent VM on this host. Set vmIsolation.enabled=false ` +
        `in Shogo config.json to use host execution instead, or inspect the VM boot logs.`,
    )
    this.name = 'VMPoolPermanentlyDisabledError'
  }
}

export class VMWarmPoolController {
  private available = new Map<string, VMPodInfo>()
  private assigned = new Map<string, VMPodInfo>()
  private vmHandles = new Map<string, VMManagerHandle>()
  private vmManagers = new Map<string, VMManagerInterface>()
  private vmOverlayPaths = new Map<string, string>()
  private pendingAssignments = new Map<string, Promise<string>>()
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private consecutiveBootFailures = 0
  private managerFactory: VMManagerFactory
  private maxAssigned: number = 0
  /** Reentrancy guard for {@link reconcile}. Without this the 30 s timer,
   *  the post-claim fire-and-forget reconcile, and the initial `start()`
   *  call could all observe `available.size = 0` while a previous
   *  reconcile's boots are still in flight — and each would spawn another
   *  full batch. The K8s WarmPoolController has the same pattern. */
  private reconciling = false
  /** Warm-pool replenishment boots in flight. Counted against `poolSize`
   *  so concurrent `reconcile()` callers don't all see a stale 0 count
   *  and pile up extra boots. */
  private inflightPoolBoots = 0
  /** `_assignProject` calls in flight (after they've cleared the cap
   *  loop and reserved a slot, until their `assign` HTTP call completes
   *  *and* the pod has been inserted into `assigned`). Counted against
   *  `maxAssigned` so concurrent assign attempts for distinct projects
   *  can't all race past the cap while their boots+assigns are still in
   *  progress. The bug we're guarding against: `inflightBoots--` in
   *  `bootVM.finally` decrementing *before* `assigned.set(...)` runs,
   *  opening a window where waiters wake up, see empty `assigned` and a
   *  newly-decremented inflight count, and all bypass the cap. */
  private pendingAssigns = 0
  /** Listeners woken when any `pendingAssigns` slot frees up. Used to
   *  back-pressure assign callers when at cap with nothing to LRU-evict. */
  private bootCompleteWaiters: Array<() => void> = []

  constructor(
    managerOrFactory: VMManagerInterface | VMManagerFactory,
    private vmConfig: any,
    private poolSize: number = POOL_SIZE,
    /** Test-only override for `maxAssigned`. Production code should use the
     *  `VM_MAX_ASSIGNED` / `VM_MAX_HARD_CAP` env vars and the auto-compute. */
    maxAssignedOverride?: number,
  ) {
    this.managerFactory = typeof managerOrFactory === 'function'
      ? managerOrFactory
      : () => managerOrFactory
    this.maxAssigned = maxAssignedOverride !== undefined
      ? Math.max(1, maxAssignedOverride)
      : this.computeMaxAssigned()
  }

  /**
   * Cap on concurrent assigned VMs. Each VM holds `vmConfig.memoryMB` of
   * host RAM plus QEMU overhead; without a cap the warm pool grew to 13+
   * QEMU processes (49 GB resident) in production logs.
   *
   * Auto sizing reserves half of *current free* host RAM (not total!) for
   * the rest of the desktop app (Electron, renderer, host RuntimeManager,
   * LSPs, the user's browser, etc.). The old implementation used
   * `os.totalmem()` despite naming the local `freeMB`, which silently
   * permitted ~8 × 4 GB VMs on a 64 GB Mac even when 50 GB was already
   * spoken for. The auto value is then clamped to `MAX_VM_HARD_CAP` so a
   * 256 GB workstation can't book 32 VMs by accident.
   */
  private computeMaxAssigned(): number {
    if (ASSIGNED_VM_CAP_ENV > 0) return ASSIGNED_VM_CAP_ENV
    const memoryMB = Number(this.vmConfig?.memoryMB) || 4096
    let freeMB: number
    try {
      const os = require('os') as typeof import('os')
      freeMB = Math.floor(os.freemem() / 1024 / 1024)
    } catch {
      freeMB = 8 * 1024
    }
    const computed = Math.max(1, Math.floor(freeMB / (memoryMB * 2)))
    return Math.min(MAX_VM_HARD_CAP, computed)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    console.log(
      `[VMWarmPool] Starting VM warm pool controller ` +
      `(poolSize: ${this.poolSize}, maxAssigned: ${this.maxAssigned}, ` +
      `idleEvictionMs: ${IDLE_EVICTION_MS})`,
    )

    // Kill orphaned QEMU and VM helper processes from a previous server session
    if (process.platform === 'win32') {
      try { execSync('taskkill /F /IM qemu-system-x86_64.exe', { stdio: 'pipe' }) } catch {}
    } else {
      try { execSync('pkill -f qemu-system', { stdio: 'pipe' }) } catch {}
      try { execSync('pkill -f shogo-vm', { stdio: 'pipe' }) } catch {}
    }

    // Purge stale overlay disk images from previous sessions
    if (this.vmConfig.overlayPath) {
      const overlayDir = path.dirname(this.vmConfig.overlayPath)
      if (fs.existsSync(overlayDir)) {
        let purged = 0
        for (const f of fs.readdirSync(overlayDir)) {
          if (f.endsWith('.raw') || f.endsWith('.qcow2')) {
            try { fs.rmSync(path.join(overlayDir, f), { force: true }); purged++ } catch {}
          }
        }
        if (purged > 0) console.log(`[VMWarmPool] Purged ${purged} stale overlay(s) from ${overlayDir}`)
      }
    }

    await this.reconcile().catch((err) => {
      console.error('[VMWarmPool] Initial reconciliation failed:', err.message)
    })

    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) => {
        console.error('[VMWarmPool] Reconciliation error:', err.message)
      })
    }, RECONCILE_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }

    const stops: Promise<void>[] = []
    for (const [vmId, handle] of this.vmHandles) {
      const mgr = this.vmManagers.get(vmId)
      if (mgr) stops.push(mgr.stopVM(handle).catch(() => {}))
    }
    await Promise.allSettled(stops)

    for (const vmId of this.vmOverlayPaths.keys()) {
      this.cleanupOverlay(vmId)
    }

    this.available.clear()
    this.assigned.clear()
    this.vmHandles.clear()
    this.vmManagers.clear()
    console.log('[VMWarmPool] Stopped VM warm pool controller')
  }

  claim(): VMPodInfo | null {
    for (const [id, pod] of this.available) {
      if (!pod.ready) continue
      this.available.delete(id)
      console.log(`[VMWarmPool] Claimed VM ${pod.vmId} (${this.available.size} remaining)`)

      // Trigger background reconcile to replace the claimed VM
      this.reconcile().catch((err) => {
        console.error('[VMWarmPool] Post-claim reconcile error:', err.message)
      })

      return pod
    }

    console.warn('[VMWarmPool] COLD START: no warm VM available')
    return null
  }

  async assign(pod: VMPodInfo, projectId: string): Promise<void> {
    const env = await buildProjectEnv(projectId, { logPrefix: 'VMWarmPool' })

    const res = await fetch(`${pod.url}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, env }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`VM /pool/assign failed (${res.status}): ${text}`)
    }

    const now = Date.now()
    pod.assignedAt = now
    pod.lastTouchedAt = now
    pod.projectId = projectId
    this.assigned.set(projectId, pod)
    console.log(`[VMWarmPool] Assigned VM ${pod.vmId} to project ${projectId}`)

    // Pool right-sizing companion: this VM may have been booted with the
    // balloon inflated to `poolMemoryMB`. Now that it's being put to
    // work on a real project, give it its full configured RAM by
    // deflating the balloon to `memoryMB`. No-op if the manager doesn't
    // implement balloons, the boot was already a direct-to-assign boot,
    // or the config doesn't use right-sizing.
    if (this.vmConfig?.poolMemoryMB && this.vmConfig?.memoryMB) {
      const mgr = this.vmManagers.get(pod.vmId)
      const handle = this.vmHandles.get(pod.vmId)
      if (mgr?.setBalloonTargetMB && handle) {
        const target = Number(this.vmConfig.memoryMB)
        try {
          await mgr.setBalloonTargetMB(handle, target)
          console.log(`[VMWarmPool] Deflated balloon on assigned VM ${pod.vmId} to ${target} MB`)
        } catch (err: any) {
          console.warn(`[VMWarmPool] Failed to deflate balloon on ${pod.vmId}: ${err.message}`)
        }
      }
    }
  }

  /**
   * Mark a project as recently used. Call from anywhere the project is
   * still actively being viewed (e.g. agent proxy stream open, UI focus
   * event) so the idle-eviction reaper doesn't kill its VM prematurely.
   */
  touch(projectId: string): void {
    const pod = this.assigned.get(projectId)
    if (pod) pod.lastTouchedAt = Date.now()
  }

  getAssignedPod(projectId: string): VMPodInfo | undefined {
    return this.assigned.get(projectId)
  }

  /**
   * Get the URL for a project, claiming and assigning a VM if needed.
   * Serializes concurrent requests for the same project to prevent
   * multiple VMs being claimed/booted for one project.
   */
  async getProjectUrl(projectId: string): Promise<string> {
    // Fast path: already assigned and within grace period
    const existing = this.assigned.get(projectId)
    if (existing) {
      const age = Date.now() - (existing.assignedAt || 0)
      const STARTUP_GRACE_MS = 60_000

      if (age < STARTUP_GRACE_MS) {
        existing.lastTouchedAt = Date.now()
        try {
          const probe = await fetch(`${existing.url}/health`, {
            signal: AbortSignal.timeout(5000),
          })
          if (probe.ok) return existing.url
        } catch {
          // Gateway still starting -- return URL optimistically during grace period
        }
        return existing.url
      }

      try {
        const probe = await fetch(`${existing.url}/health`, {
          signal: AbortSignal.timeout(3000),
        })
        if (probe.ok) {
          existing.lastTouchedAt = Date.now()
          return existing.url
        }
      } catch {
        // VM is dead after grace period — fall through to evict + re-assign
      }
    }

    // Serialize concurrent assignment attempts for the same project so only
    // one VM gets claimed even if multiple requests arrive simultaneously.
    const inflight = this.pendingAssignments.get(projectId)
    if (inflight) return inflight

    const promise = this._assignProject(projectId).finally(() => {
      this.pendingAssignments.delete(projectId)
    })
    this.pendingAssignments.set(projectId, promise)
    return promise
  }

  /** True once the warm pool has tripped its consecutive-failure kill switch
   *  and refuses to boot any further VMs for the remainder of this session. */
  isPermanentlyDisabled(): boolean {
    return this.consecutiveBootFailures >= MAX_CONSECUTIVE_FAILURES
  }

  private async _assignProject(projectId: string): Promise<string> {
    if (this.consecutiveBootFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new VMPoolPermanentlyDisabledError(this.consecutiveBootFailures)
    }

    // Evict dead VM if one was assigned previously
    if (this.assigned.has(projectId)) {
      this.evict(projectId)
    }

    // LRU cap: if we're about to push past maxAssigned, evict the
    // least-recently-touched VM first. This stops a runaway warm pool
    // (e.g. user opens 13+ projects in one session) from OOM-ing the host.
    //
    // `pendingAssigns` is included so concurrent `_assignProject` calls
    // for *different* project IDs don't all race past the cap while
    // their boots+assigns are still in progress. When no LRU victim is
    // available (cap is held entirely by in-flight assigns), back-pressure
    // by awaiting the next slot to free before re-checking. Without this
    // back-pressure 20 concurrent project opens would all blow past the
    // cap and spawn 20 QEMU processes.
    while (this.assigned.size + this.pendingAssigns >= this.maxAssigned) {
      const victim = this.findLruAssigned()
      if (victim) {
        console.log(
          `[VMWarmPool] LRU cap reached ` +
          `(assigned: ${this.assigned.size}, pending: ${this.pendingAssigns}, max: ${this.maxAssigned}) — evicting ${victim}`,
        )
        this.evict(victim)
        continue
      }
      if (this.pendingAssigns === 0) break
      console.log(
        `[VMWarmPool] Cap reached with no LRU victim — waiting for an in-flight assign to free a slot ` +
        `(pending: ${this.pendingAssigns}, max: ${this.maxAssigned})`,
      )
      await this.waitForBootSlot()
    }

    // Reserve a slot for the entire claim+boot+assign lifecycle. The slot
    // is released in the `finally` after `assign()` has either inserted
    // into `this.assigned` (success) or thrown. This closes the window
    // where decrementing on `bootVM` completion alone let multiple
    // waiters wake up and all bypass the cap before any of their
    // `assign()` calls had populated `this.assigned`.
    this.pendingAssigns++
    try {
      const pod = this.claim()
      if (!pod) {
        const freshPod = await this.bootVM('assign')
        if (!freshPod) throw new Error('Failed to boot VM for project')
        try {
          await this.assign(freshPod, projectId)
        } catch (err: any) {
          this.quarantineVM(freshPod, err?.message || String(err))
          throw err
        }
        return freshPod.url
      }

      try {
        await this.assign(pod, projectId)
      } catch (err: any) {
        this.quarantineVM(pod, err?.message || String(err))
        throw err
      }
      return pod.url
    } finally {
      this.pendingAssigns--
      this.notifyBootComplete()
    }
  }

  /**
   * Resolve when any in-flight boot finishes. Used by `_assignProject` for
   * back-pressure when at cap with no LRU victim available.
   */
  private waitForBootSlot(): Promise<void> {
    return new Promise<void>(resolve => {
      this.bootCompleteWaiters.push(resolve)
    })
  }

  private notifyBootComplete(): void {
    const ws = this.bootCompleteWaiters
    this.bootCompleteWaiters = []
    for (const w of ws) w()
  }

  private findLruAssigned(): string | null {
    let oldestId: string | null = null
    let oldestTs = Number.POSITIVE_INFINITY
    for (const [projectId, pod] of this.assigned) {
      const ts = pod.lastTouchedAt ?? pod.assignedAt ?? 0
      if (ts < oldestTs) {
        oldestTs = ts
        oldestId = projectId
      }
    }
    return oldestId
  }

  /**
   * Public entry point for callers (e.g. project-close IPC handlers, project
   * deletion) to release a VM. Safe to call with an unknown project id.
   */
  evictProject(projectId: string): void {
    if (this.assigned.has(projectId)) {
      this.evict(projectId)
    }
  }

  private evict(projectId: string): void {
    const pod = this.assigned.get(projectId)
    if (!pod) return

    this.assigned.delete(projectId)
    const handle = this.vmHandles.get(pod.vmId)
    const mgr = this.vmManagers.get(pod.vmId)
    if (handle && mgr) {
      mgr.stopVM(handle).catch((err) => {
        console.error(`[VMWarmPool] Error stopping evicted VM ${pod.vmId}:`, err.message)
      })
    }
    this.cleanupOverlay(pod.vmId)
    this.vmHandles.delete(pod.vmId)
    this.vmManagers.delete(pod.vmId)
    console.log(`[VMWarmPool] Evicted VM ${pod.vmId} for project ${projectId}`)
  }

  /**
   * Destroy a VM whose /pool/assign failed instead of leaving it orphaned or,
   * worse, ever handing it to another project.
   *
   * This is the metal analog of the Knative warm-pool controller's "quarantine
   * the dirty pod, never return it to the available pool" behaviour (prod RCA
   * Issue B: the node-agent can answer `Already assigned` when its runtime
   * state diverged from the controller's — e.g. after an API restart dropped
   * the in-memory `assigned` map while the agent still holds the binding).
   *
   * `claim()` already removed this VM from `available`, so within one
   * controller it can never be re-served (unlike Knative's label-based shared
   * pods, which is why that substrate needed an explicit quarantine + never
   * re-added it to the pool). Here we additionally stop the process and drop
   * its handles so a failed assign can't leak host RAM. The replacement is
   * booted by `reconcile()`, which `claim()` already fired.
   */
  private quarantineVM(pod: VMPodInfo, reason: string): void {
    this.available.delete(pod.id)
    const handle = this.vmHandles.get(pod.vmId)
    const mgr = this.vmManagers.get(pod.vmId)
    if (handle && mgr) {
      mgr.stopVM(handle).catch((err) => {
        console.error(`[VMWarmPool] Error stopping quarantined VM ${pod.vmId}:`, err.message)
      })
    }
    this.cleanupOverlay(pod.vmId)
    this.vmHandles.delete(pod.vmId)
    this.vmManagers.delete(pod.vmId)
    console.warn(`[VMWarmPool] Quarantined VM ${pod.vmId} after failed /pool/assign (${reason})`)
  }

  private async reconcile(): Promise<void> {
    if (!this.started) return
    // Reentrancy guard. Three independent call sites can fire reconcile()
    // concurrently (30 s timer, post-claim fire-and-forget, initial
    // start()). Without this guard each one observes the same stale
    // `available.size = 0` while previous boots are still running and
    // spawns a full extra batch — producing the runaway QEMU growth that
    // OOMs the host. See vm-pool-oom-fix plan.
    if (this.reconciling) return
    this.reconciling = true
    try {
      await this._reconcileOnce()
    } finally {
      this.reconciling = false
    }
  }

  private async _reconcileOnce(): Promise<void> {
    // Idle-eviction reaper: stop any assigned VM whose project hasn't been
    // touched in IDLE_EVICTION_MS. Without this the pool grows unbounded:
    // every project switch claims a fresh warm VM, the old one is left
    // running, and after ~13 project opens you have 13 QEMU processes
    // (~49 GB resident) leaking RAM until manual shutdown.
    if (IDLE_EVICTION_MS > 0 && this.assigned.size > 0) {
      const now = Date.now()
      const stale: string[] = []
      for (const [projectId, pod] of this.assigned) {
        const lastSeen = pod.lastTouchedAt ?? pod.assignedAt ?? 0
        if (now - lastSeen > IDLE_EVICTION_MS) stale.push(projectId)
      }
      for (const projectId of stale) {
        console.log(
          `[VMWarmPool] Idle-evicting ${projectId} (untouched for ` +
          `${Math.round((now - (this.assigned.get(projectId)?.lastTouchedAt ?? 0)) / 1000)}s)`,
        )
        this.evict(projectId)
      }
    }

    // Health check existing available VMs
    for (const [id, pod] of this.available) {
      const handle = this.vmHandles.get(pod.vmId)
      const mgr = this.vmManagers.get(pod.vmId)
      if (!handle || !mgr || !mgr.isRunning(handle)) {
        console.log(`[VMWarmPool] Removing dead VM ${pod.vmId}`)
        this.available.delete(id)
        if (handle && mgr) {
          mgr.stopVM(handle).catch(() => {})
        }
        this.cleanupOverlay(pod.vmId)
        this.vmHandles.delete(pod.vmId)
        this.vmManagers.delete(pod.vmId)
      }
    }

    // Belt-and-braces: if a previous (pre-fix) reconcile race overshot
    // poolSize, trim the excess healthy VMs back down. Without this the
    // pool would stay at the overshot size forever (reconcile only adds,
    // never removes idle warm VMs).
    if (this.available.size > this.poolSize) {
      const excess = this.available.size - this.poolSize
      const ids = [...this.available.keys()].slice(0, excess)
      for (const id of ids) {
        const pod = this.available.get(id)!
        console.log(`[VMWarmPool] Trimming excess warm VM ${pod.vmId} (have ${this.available.size}, target ${this.poolSize})`)
        this.available.delete(id)
        const handle = this.vmHandles.get(pod.vmId)
        const mgr = this.vmManagers.get(pod.vmId)
        if (handle && mgr) {
          mgr.stopVM(handle).catch(() => {})
        }
        this.cleanupOverlay(pod.vmId)
        this.vmHandles.delete(pod.vmId)
        this.vmManagers.delete(pod.vmId)
      }
    }

    // Boot new VMs to maintain pool size. Count in-flight pool boots so a
    // single concurrent reconcile that's still booting doesn't trick the
    // next call into starting another batch.
    const needed = this.poolSize - this.available.size - this.inflightPoolBoots
    if (needed <= 0) return

    if (this.consecutiveBootFailures >= MAX_CONSECUTIVE_FAILURES) {
      return
    }

    console.log(
      `[VMWarmPool] Reconcile: need ${needed} more VMs ` +
      `(available: ${this.available.size}, inflight: ${this.inflightPoolBoots}, target: ${this.poolSize})`,
    )

    const bootPromises = []
    for (let i = 0; i < needed; i++) {
      bootPromises.push(this.bootVM('pool').then(pod => {
        if (pod) {
          this.available.set(pod.id, pod)
          console.log(`[VMWarmPool] VM ${pod.vmId} added to pool (available: ${this.available.size})`)
        }
      }).catch(err => {
        console.error('[VMWarmPool] Failed to boot VM:', err.message)
      }))
    }

    await Promise.allSettled(bootPromises)
  }

  /**
   * Boot a fresh VM through the configured `VMManager` factory.
   *
   * `purpose`:
   *   - `'pool'` (default): counted against `inflightPoolBoots` so
   *     concurrent `reconcile()` callers can't all overshoot `poolSize`.
   *   - `'assign'`: NOT counted against `inflightPoolBoots` because
   *     `_assignProject` has already reserved a slot via `pendingAssigns`
   *     for the entire claim+boot+assign lifecycle.
   */
  private async bootVM(purpose: 'pool' | 'assign' = 'pool'): Promise<VMPodInfo | null> {
    let handle: VMManagerHandle | undefined
    let mgr: ReturnType<typeof this.managerFactory> | undefined
    let overlayPath: string | undefined
    if (purpose === 'pool') this.inflightPoolBoots++
    try {
      mgr = this.managerFactory()

      const config = { ...this.vmConfig }
      if (config.overlayPath) {
        const ext = config.overlayPath.replace(/.*(\.\w+)$/, '$1')
        const base = config.overlayPath.replace(/\.\w+$/, '')
        const tag = purpose === 'pool' ? this.inflightPoolBoots : this.pendingAssigns
        config.overlayPath = `${base}-${Date.now()}-${purpose}-${tag}${ext}`
        overlayPath = config.overlayPath
      }

      handle = await mgr.startVM(config)
      this.vmHandles.set(handle.id, handle)
      this.vmManagers.set(handle.id, mgr)
      if (config.overlayPath) this.vmOverlayPaths.set(handle.id, config.overlayPath)

      const boundMgr = mgr
      const boundHandle = handle
      await this.waitForHealth(handle.agentUrl, () => boundMgr.isRunning(boundHandle))

      // Pool right-sizing: inflate the balloon on a freshly-booted pool
      // VM so it idles at `poolMemoryMB` (typically 1.5 GB) instead of
      // sitting at the configured `memoryMB` ceiling (typically 4 GB).
      // For 'assign' boots we skip this — the VM goes straight to a
      // project and needs its full memory. No-op if the manager doesn't
      // implement balloons or the config doesn't have `poolMemoryMB`.
      if (purpose === 'pool' && this.vmConfig?.poolMemoryMB && mgr.setBalloonTargetMB) {
        const target = Math.max(512, Number(this.vmConfig.poolMemoryMB))
        try {
          await mgr.setBalloonTargetMB(handle, target)
          console.log(`[VMWarmPool] Inflated balloon on pool VM ${handle.id} to ${target} MB`)
        } catch (err: any) {
          console.warn(`[VMWarmPool] Failed to inflate balloon on ${handle.id}: ${err.message}`)
        }
      }

      this.consecutiveBootFailures = 0
      return {
        id: `vm-${handle.id}`,
        vmId: handle.id,
        url: handle.agentUrl,
        createdAt: Date.now(),
        ready: true,
      }
    } catch (err: any) {
      this.consecutiveBootFailures++
      console.error(`[VMWarmPool] Boot failed (${this.consecutiveBootFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`)
      if (handle) {
        try { await mgr?.stopVM(handle) } catch {}
        this.vmHandles.delete(handle.id)
        this.vmManagers.delete(handle.id)
        this.cleanupOverlay(handle.id)
        console.log(`[VMWarmPool] Cleaned up failed VM ${handle.id}`)
      } else if (overlayPath) {
        // Boot failed before we got a handle, but the manager may have
        // already created the overlay file. Clean it up by path since we
        // have no vmId to look up in `vmOverlayPaths`.
        try { fs.rmSync(overlayPath, { force: true }) } catch {}
      }
      return null
    } finally {
      if (purpose === 'pool') {
        this.inflightPoolBoots--
        this.notifyBootComplete()
      }
      // For 'assign' boots, `_assignProject`'s `finally` calls
      // `notifyBootComplete()` itself after `assign()` has populated
      // `assigned` — see the comment on `pendingAssigns`.
    }
  }

  private async waitForHealth(url: string, isAlive?: () => boolean): Promise<void> {
    for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
      if (isAlive && !isAlive()) {
        throw new Error('VM process exited before becoming healthy')
      }
      try {
        const res = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) return
      } catch {
        // not ready
      }
      await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS))
    }
    throw new Error(`VM agent-runtime failed to become healthy after ${HEALTH_CHECK_RETRIES} retries`)
  }

  private cleanupOverlay(vmId: string): void {
    const overlayPath = this.vmOverlayPaths.get(vmId)
    if (overlayPath) {
      try { fs.rmSync(overlayPath, { force: true }) } catch {}
      this.vmOverlayPaths.delete(vmId)
    }
  }

  async recyclePool(): Promise<void> {
    console.log('[VMWarmPool] Recycling pool — stopping all VMs and booting fresh ones')

    const stops: Promise<void>[] = []
    for (const [, pod] of this.available) {
      const handle = this.vmHandles.get(pod.vmId)
      const mgr = this.vmManagers.get(pod.vmId)
      if (handle && mgr) stops.push(mgr.stopVM(handle).catch(() => {}))
      this.cleanupOverlay(pod.vmId)
      this.vmHandles.delete(pod.vmId)
      this.vmManagers.delete(pod.vmId)
    }
    for (const [, pod] of this.assigned) {
      const handle = this.vmHandles.get(pod.vmId)
      const mgr = this.vmManagers.get(pod.vmId)
      if (handle && mgr) stops.push(mgr.stopVM(handle).catch(() => {}))
      this.cleanupOverlay(pod.vmId)
      this.vmHandles.delete(pod.vmId)
      this.vmManagers.delete(pod.vmId)
    }
    await Promise.allSettled(stops)

    this.available.clear()
    this.assigned.clear()

    await this.reconcile()
    console.log('[VMWarmPool] Pool recycled — fresh VMs booted')
  }

  getStatus() {
    return {
      available: this.available.size,
      assigned: this.assigned.size,
      inflightPoolBoots: this.inflightPoolBoots,
      pendingAssigns: this.pendingAssigns,
      /** Sum convenience field for tests and dashboards. */
      inflightBoots: this.inflightPoolBoots + this.pendingAssigns,
      targetPoolSize: this.poolSize,
      maxAssigned: this.maxAssigned,
      idleEvictionMs: IDLE_EVICTION_MS,
      vms: [...this.available.values(), ...this.assigned.values()].map(p => ({
        id: p.id,
        vmId: p.vmId,
        url: p.url,
        ready: p.ready,
        projectId: p.projectId,
        assignedAt: p.assignedAt,
        lastTouchedAt: p.lastTouchedAt,
      })),
    }
  }
}

// Singleton management
let vmWarmPoolController: VMWarmPoolController | null = null

export function getVMWarmPoolController(): VMWarmPoolController {
  if (!vmWarmPoolController) {
    throw new Error('VMWarmPoolController not initialized — call initVMWarmPool() first')
  }
  return vmWarmPoolController
}

export function isVMIsolation(): boolean {
  return process.env.SHOGO_VM_ISOLATION === 'true'
}

/**
 * Initialize the VM warm pool. Called from server.ts when VM isolation is detected.
 * Accepts either a single VMManager (shared across all VMs — only safe for poolSize=1
 * with a multi-VM manager) or a factory that produces a fresh VMManager per VM.
 */
export async function initVMWarmPool(
  managerOrFactory: VMManagerInterface | VMManagerFactory,
  vmConfig: any,
): Promise<void> {
  if (vmWarmPoolController) return
  vmWarmPoolController = new VMWarmPoolController(managerOrFactory, vmConfig)
  await vmWarmPoolController.start()
}

/**
 * Get the project URL through the VM warm pool (claim + assign).
 * Direct replacement for getProjectPodUrl in the VM path.
 */
export async function getVMProjectUrl(projectId: string): Promise<string> {
  const controller = getVMWarmPoolController()
  return controller.getProjectUrl(projectId)
}

export async function stopVMWarmPool(): Promise<void> {
  if (vmWarmPoolController) {
    await vmWarmPoolController.stop()
    vmWarmPoolController = null
  }
}

export async function recycleVMWarmPool(): Promise<void> {
  if (vmWarmPoolController) {
    await vmWarmPoolController.recyclePool()
  }
}
