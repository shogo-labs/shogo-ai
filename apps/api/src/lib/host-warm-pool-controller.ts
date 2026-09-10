// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Host Warm Pool Controller
 *
 * Host-mode equivalent of the Knative WarmPoolController: it keeps a small
 * pool of pre-booted generic agent-runtime processes (spawned with
 * `PROJECT_ID=__POOL__`) so opening a project can claim one and skip the
 * cold `bun run agent-runtime` start (bun boot + JIT + LSP init). Claim +
 * assign uses the SAME substrate-agnostic `/pool/assign` HTTP contract that
 * K8s pods use (packages/shared-runtime/src/server-framework.ts).
 *
 * Since the runtime runs directly on the host, a project's
 * on-disk workspace must be seeded + `bun install`ed before assignment. That is
 * the `RuntimeManager.prepareProjectWorkspace` step; the resolved directory is
 * injected as `WORKSPACE_DIR`/`PROJECT_DIR` in the assign env so the pooled
 * runtime serves the real project.
 *
 * Gated behind `HOST_WARM_POOL_SIZE` (desktop defaults this from host RAM) so
 * low-memory hosts can keep the pool disabled.
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { buildProjectEnv } from './runtime/build-project-env'
import { getRuntimeManager } from './runtime'
import {
  RssWatchdog,
  applyHeapEnvCap,
  attachDirectCgroup,
  resolveResourceLimits,
  tryAttachJobObject,
  wrapSpawnForCgroup,
  type RuntimeResourceLimits,
} from '@shogo-ai/worker/resource-limits'

const POOL_PROJECT_ID = '__POOL__'

const POOL_SIZE = parseInt(process.env.HOST_WARM_POOL_SIZE || '0', 10)
const RECONCILE_INTERVAL_MS = parseInt(process.env.HOST_POOL_RECONCILE_INTERVAL || '30000', 10)
const HEALTH_CHECK_RETRIES = parseInt(process.env.HOST_POOL_HEALTH_RETRIES || '120', 10)
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.HOST_POOL_HEALTH_INTERVAL || '1000', 10)

// Idle-eviction reaper: stop any assigned runtime whose project hasn't been
// touched for this long. Mirrors the VM/cloud pools. Default 15 min; 0 = off.
// Keep assigned warm runtimes through normal task switching. The worker's
// memory/cap eviction remains the hard backstop; this timer is only for a
// project that has genuinely disappeared from the desktop for a while.
const IDLE_EVICTION_MS = parseInt(process.env.HOST_POOL_IDLE_EVICTION_MS || `${30 * 60 * 1000}`, 10)

// Hard cap on concurrently-assigned host runtimes so opening many projects
// can't OOM the machine. 0 = auto from host free RAM / per-runtime ceiling.
const ASSIGNED_CAP_ENV = process.env.HOST_POOL_MAX_ASSIGNED
  ? parseInt(process.env.HOST_POOL_MAX_ASSIGNED, 10)
  : 0
const MAX_ASSIGNED_HARD_CAP = Math.max(1, parseInt(process.env.HOST_POOL_MAX_HARD_CAP || '8', 10))

// Dedicated port range for pool runtimes so they never collide with the host
// RuntimeManager (5200+) or the cloud worker's WorkerRuntimeManager (37100+).
const POOL_PORT_BASE = parseInt(process.env.HOST_POOL_PORT_BASE || '38300', 10)
const POOL_PORT_END = parseInt(process.env.HOST_POOL_PORT_END || '38900', 10)
// Contiguous ports reserved per runtime: agent(+0), API/skill(+1), preview
// sidecars(+2..). Mirrors WorkerRuntimeManager.RUNTIME_PORT_BLOCK.
const PORT_BLOCK = 16

const MAX_CONSECUTIVE_FAILURES = 3

/**
 * Root for the throwaway workspace each idle pool runtime is pointed at until
 * `/pool/assign` swaps in the real project directory. Without an explicit
 * `WORKSPACE_DIR` the runtime falls back to its container default
 * `/app/workspace`, which on Windows is a real, shared `C:\app\workspace`:
 * every pool runtime (from every install on the machine) seeded the template
 * there, ran `npm install` there, and picked up each other's
 * `.shogo-pool-assignment` markers on boot.
 */
export function hostPoolScratchRoot(): string {
  const workspaces = process.env.WORKSPACES_DIR
  return workspaces ? join(resolve(workspaces), '.pool') : join(tmpdir(), 'shogo-host-pool')
}

export interface HostPodInfo {
  id: string
  /** Agent-runtime base URL (http://localhost:<agentPort>). */
  url: string
  /** Agent server port (== the port in `url`). */
  agentPort: number
  /** PID of the spawned bun process group leader. */
  pid: number
  createdAt: number
  ready: boolean
  assignedAt?: number
  lastTouchedAt?: number
  projectId?: string
}

const IS_WINDOWS = process.platform === 'win32'

/**
 * Footprint used to size the concurrent-assigned cap. This is what an idle or
 * lightly used runtime actually occupies (bun + gateway + tsserver; measured
 * ~350–800 MB RSS on Windows 1.14.1), NOT the per-runtime memory *ceiling*.
 * The ceiling (`limits.memoryMB`, up to 8 GB on big hosts) is a kill switch
 * the RSS watchdog enforces, and sizing by it made a 64 GB workstation cap
 * out at 2 assigned runtimes — so switching between three projects evicted
 * and re-assigned on every open instead of hitting the warm path.
 */
const EXPECTED_RUNTIME_MB = 1536

/**
 * Pure sizing rule for `maxAssigned`: reserve half of *free* RAM for the rest
 * of the app (Electron, renderer, API, LSPs), divide the other half by the
 * expected footprint, never below 1, and clamp to the hard cap. The ceiling is
 * only used when it is smaller than the expected footprint (tiny hosts).
 */
export function computeMaxAssignedFor(freeMB: number, perRuntimeCeilingMB?: number | null): number {
  const perRuntimeMB = Math.min(EXPECTED_RUNTIME_MB, perRuntimeCeilingMB || EXPECTED_RUNTIME_MB)
  const budgetMB = Math.max(0, Math.floor(freeMB / 2))
  const computed = Math.max(1, Math.floor(budgetMB / perRuntimeMB))
  return Math.min(MAX_ASSIGNED_HARD_CAP, computed)
}

export class HostWarmPoolController {
  private available = new Map<string, HostPodInfo>()
  private assigned = new Map<string, HostPodInfo>()
  private procs = new Map<string, ChildProcess>()
  private watchdogs = new Map<string, RssWatchdog>()
  /** Agent port reserved per runtime id, so a claimed-but-never-assigned runtime still frees its block. */
  private podPorts = new Map<string, number>()
  private usedPorts = new Set<number>()
  private pendingAssignments = new Map<string, Promise<string>>()
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private reconciling = false
  private inflightPoolBoots = 0
  private pendingAssigns = 0
  private bootCompleteWaiters: Array<() => void> = []
  private consecutiveBootFailures = 0
  private readonly limits: RuntimeResourceLimits | null
  private readonly maxAssigned: number

  constructor(private poolSize: number = POOL_SIZE, maxAssignedOverride?: number) {
    this.limits = resolveResourceLimits(process.env)
    this.maxAssigned = maxAssignedOverride !== undefined
      ? Math.max(1, maxAssignedOverride)
      : this.computeMaxAssigned()
  }

  private computeMaxAssigned(): number {
    if (ASSIGNED_CAP_ENV > 0) return ASSIGNED_CAP_ENV
    let freeMB: number
    try {
      const os = require('os') as typeof import('os')
      freeMB = Math.floor(os.freemem() / 1024 / 1024)
    } catch {
      freeMB = 8 * 1024
    }
    return computeMaxAssignedFor(freeMB, this.limits?.memoryMB)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    console.log(
      `[HostWarmPool] Starting host warm pool ` +
        `(poolSize: ${this.poolSize}, maxAssigned: ${this.maxAssigned}, ` +
        `idleEvictionMs: ${IDLE_EVICTION_MS}, memCeil: ${this.limits?.memoryMB ?? 'none'})`,
    )
    // Scratch workspaces from a previous session hold nothing worth keeping.
    try { rmSync(hostPoolScratchRoot(), { recursive: true, force: true }) } catch { /* best-effort */ }
    // Prepare the default template and dependencies before the first claim.
    // The project assignment path can then rename the ready workspace instead
    // of running npm/bun install while the user is waiting.
    try {
      await getRuntimeManager().prepareWarmWorkspace()
    } catch (err: any) {
      console.warn(`[HostWarmPool] Warm workspace preparation failed: ${err?.message ?? err}`)
    }
    await this.reconcile().catch((err) => {
      console.error('[HostWarmPool] Initial reconciliation failed:', err?.message ?? err)
    })
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) => {
        console.error('[HostWarmPool] Reconciliation error:', err?.message ?? err)
      })
    }, RECONCILE_INTERVAL_MS)
    try { this.reconcileTimer.unref?.() } catch { /* best-effort */ }
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    for (const id of [...this.available.keys(), ...this.assigned.keys()]) {
      this.destroyPod(id)
    }
    this.available.clear()
    this.assigned.clear()
    console.log('[HostWarmPool] Stopped host warm pool')
  }

  claim(): HostPodInfo | null {
    for (const [id, pod] of this.available) {
      if (!pod.ready) continue
      this.available.delete(id)
      console.log(`[HostWarmPool] Claimed runtime ${id} (${this.available.size} remaining)`)
      // Replace the claimed runtime in the background.
      this.reconcile().catch((err) => {
        console.error('[HostWarmPool] Post-claim reconcile error:', err?.message ?? err)
      })
      return pod
    }
    console.warn('[HostWarmPool] COLD START: no warm runtime available')
    return null
  }

  async assign(pod: HostPodInfo, projectId: string, openAttemptId?: string): Promise<void> {
    // Seed + install the workspace on disk, then point the pooled runtime at it.
    const projectDir = await getRuntimeManager().prepareProjectWorkspace(projectId)
    if (process.env.SHOGO_PERF_LOG === '1') {
      console.log(`[shogo-perf] ${JSON.stringify({
        perf: 'open',
        source: 'host-warm-pool',
        phase: 'workspace-assigned',
        projectId,
        openAttemptId,
        atMs: Date.now(),
      })}`)
    }
    const env = await buildProjectEnv(projectId, { logPrefix: 'HostWarmPool' })
    env.WORKSPACE_DIR = projectDir
    env.PROJECT_DIR = projectDir

    const res = await fetch(`${pod.url}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, env }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`host /pool/assign failed (${res.status}): ${text}`)
    }

    const now = Date.now()
    pod.assignedAt = now
    pod.lastTouchedAt = now
    pod.projectId = projectId
    this.assigned.set(projectId, pod)
    console.log(`[HostWarmPool] Assigned runtime ${pod.id} to project ${projectId}`)
  }

  touch(projectId: string): void {
    const pod = this.assigned.get(projectId)
    if (pod) pod.lastTouchedAt = Date.now()
  }

  getAssignedPod(projectId: string): HostPodInfo | undefined {
    return this.assigned.get(projectId)
  }

  /** True once the pool has tripped its consecutive-failure kill switch. */
  isPermanentlyDisabled(): boolean {
    return this.consecutiveBootFailures >= MAX_CONSECUTIVE_FAILURES
  }

  /** True when we hold the runtime's ChildProcess and it has already exited. */
  private isProcessDead(pod: HostPodInfo): boolean {
    const proc = this.procs.get(pod.id)
    if (!proc) return false
    return proc.exitCode !== null || proc.signalCode !== null
  }

  async getProjectUrl(projectId: string, openAttemptId?: string): Promise<string> {
    let existing = this.assigned.get(projectId)
    if (existing && this.isProcessDead(existing)) {
      // The process is gone; the startup grace below must not return its URL
      // optimistically. Measured on Windows 1.14.1: a runtime killed right
      // after assign left `sandbox/url` reporting ready for ~58s while every
      // agent-proxy request failed. Evict now so this open re-assigns.
      console.warn(`[HostWarmPool] runtime ${existing.id} for ${projectId} has exited — evicting before reopen`)
      this.evict(projectId)
      existing = undefined
    }
    if (existing) {
      const age = Date.now() - (existing.assignedAt || 0)
      const STARTUP_GRACE_MS = 60_000
      if (age < STARTUP_GRACE_MS) {
        existing.lastTouchedAt = Date.now()
        try {
          const probe = await fetch(`${existing.url}/health`, { signal: AbortSignal.timeout(5000) })
          if (probe.ok) return existing.url
        } catch { /* still starting — return optimistically */ }
        return existing.url
      }
      try {
        const probe = await fetch(`${existing.url}/health`, { signal: AbortSignal.timeout(3000) })
        if (probe.ok) {
          existing.lastTouchedAt = Date.now()
          return existing.url
        }
      } catch {
        // dead after grace — fall through to evict + re-assign
      }
    }

    const inflight = this.pendingAssignments.get(projectId)
    if (inflight) return inflight
    const promise = this._assignProject(projectId, openAttemptId).finally(() => {
      this.pendingAssignments.delete(projectId)
    })
    this.pendingAssignments.set(projectId, promise)
    return promise
  }

  private async _assignProject(projectId: string, openAttemptId?: string): Promise<string> {
    if (this.consecutiveBootFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new Error(
        `Host warm pool disabled after ${this.consecutiveBootFailures} consecutive boot failures`,
      )
    }
    if (this.assigned.has(projectId)) {
      this.evict(projectId)
    }

    // LRU cap: evict the least-recently-touched runtime before exceeding the
    // cap, with back-pressure when the cap is fully held by in-flight assigns.
    while (this.assigned.size + this.pendingAssigns >= this.maxAssigned) {
      const victim = this.findLruAssigned()
      if (victim) {
        console.log(
          `[HostWarmPool] LRU cap reached ` +
            `(assigned: ${this.assigned.size}, pending: ${this.pendingAssigns}, max: ${this.maxAssigned}) — evicting ${victim}`,
        )
        this.evict(victim)
        continue
      }
      if (this.pendingAssigns === 0) break
      await this.waitForBootSlot()
    }

    this.pendingAssigns++
    try {
      let pod = this.claim()
      if (!pod) {
        pod = await this.bootPod('assign')
        if (!pod) throw new Error('Failed to boot runtime for project')
      }
      try {
        await this.assign(pod, projectId, openAttemptId)
      } catch (err: any) {
        this.quarantinePod(pod, err?.message || String(err))
        throw err
      }
      return pod.url
    } finally {
      this.pendingAssigns--
      this.notifyBootComplete()
    }
  }

  private waitForBootSlot(): Promise<void> {
    return new Promise<void>((resolve) => this.bootCompleteWaiters.push(resolve))
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
      if (ts < oldestTs) { oldestTs = ts; oldestId = projectId }
    }
    return oldestId
  }

  evictProject(projectId: string): void {
    if (this.assigned.has(projectId)) this.evict(projectId)
  }

  private evict(projectId: string): void {
    const pod = this.assigned.get(projectId)
    if (!pod) return
    this.assigned.delete(projectId)
    this.destroyPod(pod.id)
    console.log(`[HostWarmPool] Evicted runtime ${pod.id} for project ${projectId}`)
  }

  private quarantinePod(pod: HostPodInfo, reason: string): void {
    this.available.delete(pod.id)
    this.destroyPod(pod.id)
    console.warn(`[HostWarmPool] Quarantined runtime ${pod.id} after failed /pool/assign (${reason})`)
  }

  private async reconcile(): Promise<void> {
    if (!this.started) return
    if (this.reconciling) return
    this.reconciling = true
    try {
      await this._reconcileOnce()
    } finally {
      this.reconciling = false
    }
  }

  private async _reconcileOnce(): Promise<void> {
    // Idle-eviction reaper.
    if (IDLE_EVICTION_MS > 0 && this.assigned.size > 0) {
      const now = Date.now()
      const stale: string[] = []
      for (const [projectId, pod] of this.assigned) {
        const lastSeen = pod.lastTouchedAt ?? pod.assignedAt ?? 0
        if (now - lastSeen > IDLE_EVICTION_MS) stale.push(projectId)
      }
      for (const projectId of stale) {
        console.log(`[HostWarmPool] Idle-evicting ${projectId}`)
        this.evict(projectId)
      }
    }

    // Drop dead available runtimes.
    for (const [id, pod] of this.available) {
      const proc = this.procs.get(pod.id)
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        console.log(`[HostWarmPool] Removing dead runtime ${id}`)
        this.available.delete(id)
        this.destroyPod(pod.id)
      }
    }

    // Trim any overshoot back to poolSize.
    if (this.available.size > this.poolSize) {
      const excess = this.available.size - this.poolSize
      for (const id of [...this.available.keys()].slice(0, excess)) {
        const pod = this.available.get(id)!
        this.available.delete(id)
        this.destroyPod(pod.id)
      }
    }

    const needed = this.poolSize - this.available.size - this.inflightPoolBoots
    if (needed <= 0) return
    if (this.consecutiveBootFailures >= MAX_CONSECUTIVE_FAILURES) return

    console.log(
      `[HostWarmPool] Reconcile: need ${needed} more runtimes ` +
        `(available: ${this.available.size}, inflight: ${this.inflightPoolBoots}, target: ${this.poolSize})`,
    )
    const boots: Promise<void>[] = []
    for (let i = 0; i < needed; i++) {
      boots.push(
        this.bootPod('pool')
          .then((pod) => {
            if (pod) {
              this.available.set(pod.id, pod)
              console.log(`[HostWarmPool] Runtime ${pod.id} added to pool (available: ${this.available.size})`)
            }
          })
          .catch((err) => console.error('[HostWarmPool] Failed to boot runtime:', err?.message ?? err)),
      )
    }
    await Promise.allSettled(boots)
  }

  /**
   * Boot a fresh generic (`PROJECT_ID=__POOL__`) agent-runtime process.
   *
   * `purpose`:
   *   - `'pool'`: counted against `inflightPoolBoots` so concurrent reconciles
   *     don't overshoot poolSize.
   *   - `'assign'`: NOT counted (the `_assignProject` slot covers it).
   */
  private async bootPod(purpose: 'pool' | 'assign' = 'pool'): Promise<HostPodInfo | null> {
    if (purpose === 'pool') this.inflightPoolBoots++
    let agentPort = 0
    let proc: ChildProcess | undefined
    const id = `host-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`
    try {
      agentPort = await this.allocatePort()
      this.podPorts.set(id, agentPort)
      const { command, args, env } = this.buildSpawn(agentPort, id)

      // Linux: wrap in a rootless systemd cgroup scope for a hard cap.
      let cmd = command
      let cmdArgs = args
      let cgroupWrapped = false
      if (this.limits) {
        const wrapped = wrapSpawnForCgroup({
          command,
          args,
          limits: this.limits,
          scopeName: `shogo-pool-${id}`,
        })
        cmd = wrapped.command
        cmdArgs = wrapped.args
        cgroupWrapped = wrapped.wrapped
      }

      proc = spawn(cmd, cmdArgs, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !IS_WINDOWS,
        windowsHide: true,
      })
      this.procs.set(id, proc)
      const pid = proc.pid ?? 0
      proc.stdout?.on('data', (d: Buffer) => console.log(`[HostWarmPool:${id}] ${d.toString().trim()}`))
      proc.stderr?.on('data', (d: Buffer) => console.error(`[HostWarmPool:${id}] ${d.toString().trim()}`))
      proc.on('error', (err) => console.error(`[HostWarmPool:${id}] spawn error: ${err?.message ?? err}`))
      // Unexpected exit (crash, OOM kill, external taskkill): drop the runtime
      // from whichever map holds it right away so the next open re-assigns
      // instead of waiting for the 30s reconcile / 60s startup grace.
      proc.on('exit', (code, signal) => this.onRuntimeExit(id, code, signal))

      if (this.limits && pid) {
        this.applyPostSpawnLimits(id, pid, cgroupWrapped)
      }

      const url = `http://localhost:${agentPort}`
      await this.waitForHealth(url, () => proc!.exitCode === null && proc!.signalCode === null)

      this.consecutiveBootFailures = 0
      return { id, url, agentPort, pid, createdAt: Date.now(), ready: true }
    } catch (err: any) {
      this.consecutiveBootFailures++
      console.error(
        `[HostWarmPool] Boot failed (${this.consecutiveBootFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err?.message ?? err}`,
      )
      this.destroyPod(id)
      return null
    } finally {
      if (purpose === 'pool') {
        this.inflightPoolBoots--
        this.notifyBootComplete()
      }
    }
  }

  /** Build the spawn command + sanitized env for a pool runtime. */
  private buildSpawn(agentPort: number, id: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    const bunPath = process.env.SHOGO_BUN_PATH || 'bun'
    const entry = process.env.AGENT_RUNTIME_ENTRY
    if (!entry) {
      throw new Error('AGENT_RUNTIME_ENTRY is not set — cannot spawn a host pool runtime')
    }

    const env: NodeJS.ProcessEnv = { ...process.env }
    // Never leak the app DB / auth secret into a spawned runtime (matches the
    // env hygiene in apps/desktop/src/local-server.ts).
    delete env.SHOGO_APP_DATABASE_URL
    delete env.DATABASE_URL
    delete env.PROJECTS_DATABASE_URL
    delete env.BETTER_AUTH_SECRET

    env.PROJECT_ID = POOL_PROJECT_ID
    // Private scratch workspace until assignment (see hostPoolScratchRoot).
    // The API prepares the real project directory (template + node_modules)
    // and hands it over in the /pool/assign env, so the runtime's own
    // pre-seed + `npm install` of the template is pure duplicate work here:
    // on Windows 1.14.1 it ran a 20-76s npm install per pool boot, competing
    // with the user's actual project install.
    const scratchDir = join(hostPoolScratchRoot(), id)
    try { mkdirSync(scratchDir, { recursive: true }) } catch { /* runtime creates it */ }
    env.WORKSPACE_DIR = scratchDir
    env.PROJECT_DIR = scratchDir
    env.SHOGO_POOL_SKIP_PRESEED = '1'
    env.PORT = String(agentPort)
    env.API_SERVER_PORT = String(agentPort + 1)
    env.SKILL_SERVER_PORT = String(agentPort + 1)
    env.WORKSPACE_API_PORT_BASE = String(agentPort + 2)
    env.NODE_ENV = process.env.NODE_ENV || 'development'

    if (this.limits) applyHeapEnvCap(env, this.limits.memoryMB)

    const isCompiledRuntime =
      entry.endsWith('.exe') || basename(entry) === 'agent-runtime'
    return {
      command: isCompiledRuntime ? entry : bunPath,
      args: isCompiledRuntime ? [] : ['run', entry],
      env,
    }
  }

  private applyPostSpawnLimits(id: string, pid: number, cgroupWrapped: boolean): void {
    if (!this.limits) return
    try {
      if (process.platform === 'linux') {
        if (cgroupWrapped) return
        if (attachDirectCgroup({ pid, limits: this.limits })) return
      } else if (process.platform === 'win32') {
        if (tryAttachJobObject({ pid, limits: this.limits })) return
      }
      const watchdog = new RssWatchdog({
        pid,
        ceilingMB: this.limits.memoryMB,
        onBreach: (rssMB) => {
          console.warn(`[HostWarmPool] runtime ${id} RSS ${rssMB}MB over ceiling — recycling`)
          this.recyclePod(id)
        },
      })
      watchdog.start()
      this.watchdogs.set(id, watchdog)
    } catch (err: any) {
      console.warn(`[HostWarmPool] failed to apply resource limits to ${id}: ${err?.message ?? err}`)
    }
  }

  /** Tear down a runtime by id: stop watchdog, kill its process group, free ports. */
  private destroyPod(id: string): void {
    const wd = this.watchdogs.get(id)
    if (wd) { wd.stop(); this.watchdogs.delete(id) }
    const proc = this.procs.get(id)
    if (proc) {
      this.killProcessGroup(proc)
      this.procs.delete(id)
    }
    // Release the reserved port block. `podPorts` covers runtimes that were
    // claimed but never made it into `assigned` (quarantined assigns), which
    // used to leak their block until the range ran dry.
    const port = this.podPorts.get(id) ?? this.available.get(id)?.agentPort ?? this.assigned.get(id)?.agentPort
    this.podPorts.delete(id)
    if (port) this.releasePortBlock(port)
    try {
      rmSync(join(hostPoolScratchRoot(), id), { recursive: true, force: true })
    } catch { /* best-effort scratch cleanup */ }
  }

  /**
   * ChildProcess `exit` handler. `destroyPod` deletes from `procs` before the
   * kill, so exits we caused ourselves (evict / recycle / stop) find nothing
   * here and are ignored; only unexpected deaths reach the eviction below.
   */
  private onRuntimeExit(id: string, code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.procs.has(id)) return
    if (this.available.has(id)) {
      console.warn(`[HostWarmPool] idle runtime ${id} exited (code=${code}, signal=${signal}) — refilling`)
      this.available.delete(id)
      this.destroyPod(id)
      if (this.started) this.reconcile().catch(() => {})
      return
    }
    for (const [projectId, pod] of this.assigned) {
      if (pod.id !== id) continue
      console.warn(`[HostWarmPool] runtime ${id} for ${projectId} exited (code=${code}, signal=${signal}) — evicting`)
      this.evict(projectId)
      return
    }
    // Booting (not yet in either map): bootPod's waitForHealth sees the exit.
  }

  /** A breached runtime that was in `available`: drop and let reconcile refill. */
  private recyclePod(id: string): void {
    if (this.available.has(id)) {
      this.available.delete(id)
      this.destroyPod(id)
      this.reconcile().catch(() => {})
      return
    }
    // Assigned: find the projectId and evict (the next open re-assigns).
    for (const [projectId, pod] of this.assigned) {
      if (pod.id === id) { this.evict(projectId); return }
    }
    this.destroyPod(id)
  }

  private killProcessGroup(proc: ChildProcess): void {
    const pid = proc.pid
    if (!pid) return
    if (IS_WINDOWS) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' }) } catch { /* already gone */ }
      return
    }
    try { process.kill(-pid, 'SIGTERM') } catch { /* group gone */ }
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* group gone */ }
    }, 5000).unref?.()
  }

  private async waitForHealth(url: string, isAlive: () => boolean): Promise<void> {
    for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
      if (!isAlive()) throw new Error('runtime process exited before becoming healthy')
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) return
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS))
    }
    throw new Error(`host runtime failed to become healthy after ${HEALTH_CHECK_RETRIES} retries`)
  }

  private async allocatePort(): Promise<number> {
    for (let base = POOL_PORT_BASE; base + PORT_BLOCK - 1 <= POOL_PORT_END; base += PORT_BLOCK) {
      let blockFree = true
      for (let off = 0; off < PORT_BLOCK; off++) {
        if (this.usedPorts.has(base + off)) { blockFree = false; break }
      }
      if (!blockFree) continue
      if (!(await this.isPortFree(base)) || !(await this.isPortFree(base + 1))) continue
      for (let off = 0; off < PORT_BLOCK; off++) this.usedPorts.add(base + off)
      return base
    }
    throw new Error(`No free host pool port block in ${POOL_PORT_BASE}-${POOL_PORT_END}`)
  }

  private releasePortBlock(base: number): void {
    for (let off = 0; off < PORT_BLOCK; off++) this.usedPorts.delete(base + off)
  }

  /**
   * Connect-based probe. The previous bind-and-close probe left the API
   * process itself listening on the probed port under Bun on Windows (the
   * `close()` callback fired but the socket stayed open), so every runtime
   * spawned right after a claim died with EADDRINUSE on its own agent port
   * and the pool ran a boot short until the next reconcile.
   */
  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const socket = connect({ port, host: '127.0.0.1' })
      const done = (free: boolean) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(free)
      }
      socket.once('connect', () => done(false))
      socket.once('error', (err: NodeJS.ErrnoException) => done(err?.code === 'ECONNREFUSED'))
      socket.setTimeout(750, () => done(true))
    })
  }

  getStatus() {
    return {
      available: this.available.size,
      assigned: this.assigned.size,
      inflightPoolBoots: this.inflightPoolBoots,
      pendingAssigns: this.pendingAssigns,
      targetPoolSize: this.poolSize,
      maxAssigned: this.maxAssigned,
      idleEvictionMs: IDLE_EVICTION_MS,
      runtimes: [...this.available.values(), ...this.assigned.values()].map((p) => ({
        id: p.id,
        url: p.url,
        ready: p.ready,
        projectId: p.projectId,
        assignedAt: p.assignedAt,
        lastTouchedAt: p.lastTouchedAt,
      })),
    }
  }
}

// ─── Singleton management ────────────────────────────────────────────

let hostWarmPoolController: HostWarmPoolController | null = null

/** True when the host warm pool is enabled (HOST_WARM_POOL_SIZE > 0). */
export function isHostWarmPoolEnabled(): boolean {
  return POOL_SIZE > 0
}

export function getHostWarmPoolController(): HostWarmPoolController {
  if (!hostWarmPoolController) {
    throw new Error('HostWarmPoolController not initialized — call initHostWarmPool() first')
  }
  return hostWarmPoolController
}

/** Initialize the host warm pool. No-op when disabled or already initialized. */
export async function initHostWarmPool(): Promise<void> {
  if (hostWarmPoolController) return
  if (!isHostWarmPoolEnabled()) return
  hostWarmPoolController = new HostWarmPoolController()
  await hostWarmPoolController.start()
}

/** Claim + assign a pooled runtime for a project, returning its agent URL. */
export async function getHostPoolProjectUrl(projectId: string, openAttemptId?: string): Promise<string> {
  return getHostWarmPoolController().getProjectUrl(projectId, openAttemptId)
}

export async function stopHostWarmPool(): Promise<void> {
  if (hostWarmPoolController) {
    await hostWarmPoolController.stop()
    hostWarmPoolController = null
  }
}
