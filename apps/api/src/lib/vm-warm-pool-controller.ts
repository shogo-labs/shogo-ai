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

const POOL_SIZE = parseInt(process.env.VM_POOL_SIZE || '2', 10)
const RECONCILE_INTERVAL_MS = parseInt(process.env.VM_POOL_RECONCILE_INTERVAL || '30000', 10)
const HEALTH_CHECK_RETRIES = 60
const HEALTH_CHECK_INTERVAL_MS = 500

export interface VMPodInfo {
  id: string
  vmId: string
  url: string
  createdAt: number
  ready: boolean
  assignedAt?: number
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
}

/**
 * Factory that produces a fresh VMManager for each VM. Needed because
 * DarwinVMManager only supports one active VM at a time, so the pool
 * must use separate instances for the assigned VM and the warming VM.
 */
export type VMManagerFactory = () => VMManagerInterface

export class VMWarmPoolController {
  private available = new Map<string, VMPodInfo>()
  private assigned = new Map<string, VMPodInfo>()
  private vmHandles = new Map<string, VMManagerHandle>()
  private vmManagers = new Map<string, VMManagerInterface>()
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private managerFactory: VMManagerFactory

  constructor(
    managerOrFactory: VMManagerInterface | VMManagerFactory,
    private vmConfig: any,
    private poolSize: number = POOL_SIZE,
  ) {
    this.managerFactory = typeof managerOrFactory === 'function'
      ? managerOrFactory
      : () => managerOrFactory
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    console.log(`[VMWarmPool] Starting VM warm pool controller (poolSize: ${this.poolSize})`)

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

    pod.assignedAt = Date.now()
    pod.projectId = projectId
    this.assigned.set(projectId, pod)
    console.log(`[VMWarmPool] Assigned VM ${pod.vmId} to project ${projectId}`)
  }

  getAssignedPod(projectId: string): VMPodInfo | undefined {
    return this.assigned.get(projectId)
  }

  /**
   * Get the URL for a project, claiming and assigning a VM if needed.
   */
  async getProjectUrl(projectId: string): Promise<string> {
    const existing = this.assigned.get(projectId)
    if (existing) {
      try {
        const probe = await fetch(`${existing.url}/health`, {
          signal: AbortSignal.timeout(3000),
        })
        if (probe.ok) return existing.url
      } catch {
        // VM is dead, evict and re-assign
      }
      this.evict(projectId)
    }

    const pod = this.claim()
    if (!pod) {
      // Cold start: boot a fresh VM inline
      const freshPod = await this.bootVM()
      if (!freshPod) throw new Error('Failed to boot VM for project')
      await this.assign(freshPod, projectId)
      return freshPod.url
    }

    await this.assign(pod, projectId)
    return pod.url
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
    this.vmHandles.delete(pod.vmId)
    this.vmManagers.delete(pod.vmId)
    console.log(`[VMWarmPool] Evicted VM ${pod.vmId} for project ${projectId}`)
  }

  private async reconcile(): Promise<void> {
    if (!this.started) return

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
        this.vmHandles.delete(pod.vmId)
        this.vmManagers.delete(pod.vmId)
      }
    }

    // Boot new VMs to maintain pool size
    const needed = this.poolSize - this.available.size
    if (needed <= 0) return

    console.log(`[VMWarmPool] Reconcile: need ${needed} more VMs (available: ${this.available.size}, target: ${this.poolSize})`)

    const bootPromises = []
    for (let i = 0; i < needed; i++) {
      bootPromises.push(this.bootVM().then(pod => {
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

  private async bootVM(): Promise<VMPodInfo | null> {
    try {
      const mgr = this.managerFactory()

      // Each VM needs a unique overlay path to avoid sharing disk images
      const config = { ...this.vmConfig }
      if (config.overlayPath) {
        const ext = config.overlayPath.replace(/.*(\.\w+)$/, '$1')
        const base = config.overlayPath.replace(/\.\w+$/, '')
        config.overlayPath = `${base}-${Date.now()}${ext}`
      }

      const handle = await mgr.startVM(config)
      this.vmHandles.set(handle.id, handle)
      this.vmManagers.set(handle.id, mgr)

      await this.waitForHealth(handle.agentUrl)

      return {
        id: `vm-${handle.id}`,
        vmId: handle.id,
        url: handle.agentUrl,
        createdAt: Date.now(),
        ready: true,
      }
    } catch (err: any) {
      console.error('[VMWarmPool] Boot failed:', err.message)
      return null
    }
  }

  private async waitForHealth(url: string): Promise<void> {
    for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
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

  getStatus() {
    return {
      available: this.available.size,
      assigned: this.assigned.size,
      targetPoolSize: this.poolSize,
      vms: [...this.available.values(), ...this.assigned.values()].map(p => ({
        id: p.id,
        vmId: p.vmId,
        url: p.url,
        ready: p.ready,
        projectId: p.projectId,
        assignedAt: p.assignedAt,
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
