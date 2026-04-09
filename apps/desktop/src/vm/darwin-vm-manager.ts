// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn, execSync, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import type { VMManager, VMConfig, VMHandle } from './types'
import { VM_DEFAULTS } from './types'
import { JsonRpcClient } from './json-rpc-client'
import { generateSeedISO } from './cloud-init'
import { isNoisyVMLine } from './vm-log-filter'

/**
 * macOS VM Manager using Apple Virtualization.framework via a Go helper binary.
 *
 * Each VM runs a single agent-runtime process in pool mode (the equivalent
 * of a K8s pod). The Go helper manages the VM lifecycle, VirtioFS mounts,
 * and vsock port bridging.
 */
export class DarwinVMManager implements VMManager {
  private goProcess: ChildProcess | null = null
  private rpcClient: JsonRpcClient | null = null
  private vmRunning = false
  private portForwards = new Map<number, number>()

  constructor(
    private goHelperPath: string,
    private vmImageDir: string
  ) {}

  async startVM(config: VMConfig): Promise<VMHandle> {
    if (this.vmRunning) throw new Error('VM already running')

    const vmId = crypto.randomUUID()
    const dataDir = this.getVMDataDir(vmId)
    fs.mkdirSync(dataDir, { recursive: true })

    const seedISOPath = path.join(dataDir, 'seed.iso')
    generateSeedISO(seedISOPath, {
      guestAgentPort: VM_DEFAULTS.guestAgentPort,
      useBundleMount: !!config.bundleDir,
      env: config.env,
    })

    this.ensureOverlay(config.overlayPath)

    this.goProcess = spawn(this.goHelperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.goProcess.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const t = line.trim()
        if (!t || isNoisyVMLine(t)) continue
        console.error(`[shogo-vm] ${t}`)
      }
    })

    this.rpcClient = new JsonRpcClient(this.goProcess)

    const shares: Record<string, string> = {
      workspace: config.workspaceDir,
    }
    if (config.bundleDir) {
      shares.bundle = config.bundleDir
    }
    const readOnlyShares: Record<string, string> = {}

    for (const dir of config.credentialDirs) {
      const expanded = dir.replace(/^~/, process.env.HOME || '')
      if (fs.existsSync(expanded) && fs.statSync(expanded).isDirectory()) {
        const tag = path.basename(expanded).replace(/^\./, '')
        readOnlyShares[tag] = expanded
      }
    }

    await this.rpcClient.call('start', {
      kernelPath: path.join(this.vmImageDir, 'vmlinuz'),
      initrdPath: path.join(this.vmImageDir, 'initrd.img'),
      rootDiskPath: config.overlayPath,
      seedISOPath: fs.existsSync(seedISOPath) ? seedISOPath : undefined,
      memoryMB: config.memoryMB,
      cpus: config.cpus,
      shares,
      readOnlyShares,
    })

    this.vmRunning = true

    // Bridge the in-VM agent-runtime port to a local TCP port
    const agentHostPort = await this.findFreePort(VM_DEFAULTS.agentTcpPort)
    await this.rpcClient.call('forward', {
      vsockPort: VM_DEFAULTS.agentVsockPort,
      hostPort: agentHostPort,
    })
    this.portForwards.set(VM_DEFAULTS.agentVsockPort, agentHostPort)

    // Bridge the in-VM skill-server port (4100) to a local TCP port
    let skillHostPort = 0
    if (config.bundleDir) {
      skillHostPort = config.skillServerHostPort || await this.findFreePort(VM_DEFAULTS.guestSkillPort)
      await this.rpcClient.call('forward', {
        vsockPort: VM_DEFAULTS.skillVsockPort,
        hostPort: skillHostPort,
      })
      this.portForwards.set(VM_DEFAULTS.skillVsockPort, skillHostPort)
    }

    return {
      id: vmId,
      agentUrl: `http://localhost:${agentHostPort}`,
      skillServerPort: skillHostPort,
      pid: this.goProcess.pid!,
      platform: 'darwin',
    }
  }

  async stopVM(handle: VMHandle): Promise<void> {
    if (!this.vmRunning || !this.rpcClient) return

    try {
      await this.rpcClient.call('stop', {})
    } catch {
      // force kill if RPC fails
    }

    this.rpcClient.destroy()
    this.rpcClient = null

    if (this.goProcess) {
      this.goProcess.kill('SIGTERM')
      this.goProcess = null
    }

    this.vmRunning = false
    this.portForwards.clear()

    const dataDir = this.getVMDataDir(handle.id)
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
  }

  isRunning(_handle: VMHandle): boolean {
    return this.vmRunning && this.goProcess !== null && !this.goProcess.killed
  }

  async forwardPort(_handle: VMHandle, guestPort: number, hostPort: number): Promise<void> {
    if (!this.rpcClient) throw new Error('VM not running')
    await this.rpcClient.call('forward', {
      vsockPort: guestPort,
      hostPort,
    })
    this.portForwards.set(guestPort, hostPort)
  }

  async removeForward(_handle: VMHandle, hostPort: number): Promise<void> {
    if (!this.rpcClient) throw new Error('VM not running')

    let vsockPort: number | undefined
    for (const [vp, hp] of this.portForwards) {
      if (hp === hostPort) { vsockPort = vp; break }
    }
    if (vsockPort === undefined) return

    await this.rpcClient.call('unforward', { vsockPort })
    this.portForwards.delete(vsockPort)
  }

  /**
   * Create a one-time fully-provisioned overlay image. On subsequent calls this
   * is a no-op because the image already exists. Future `ensureOverlay()` calls
   * clone from this provisioned image (instant APFS CoW) so cloud-init has
   * nothing left to install.
   *
   * @param bundleDir  The host bundle directory (bun, agent-runtime, templates).
   *                   Needed so the provisioning VM can `bun install` via VirtioFS.
   */
  async ensureProvisionedBase(bundleDir: string): Promise<void> {
    const provisionedPath = path.join(this.vmImageDir, 'rootfs-provisioned.raw')
    if (fs.existsSync(provisionedPath)) return

    const rawImage = path.join(this.vmImageDir, 'rootfs.raw')
    if (!fs.existsSync(rawImage)) return

    console.log('[DarwinVMManager] Creating provisioned base image (one-time)…')

    const tmpOverlay = path.join(this.vmImageDir, 'rootfs-provisioning.raw')
    try {
      execSync(`cp -c "${rawImage}" "${tmpOverlay}"`, { stdio: 'pipe' })
    } catch {
      execSync(`cp "${rawImage}" "${tmpOverlay}"`, { stdio: 'pipe' })
    }
    // Ensure at least 10GB for growpart/resize2fs inside the VM
    const stat = fs.statSync(tmpOverlay)
    if (stat.size < 10 * 1024 * 1024 * 1024) {
      try { execSync(`truncate -s 10G "${tmpOverlay}"`, { stdio: 'pipe' }) } catch {}
    }

    const tmpWorkspace = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shogo-provision-ws-'))
    const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shogo-provision-'))
    const seedISOPath = path.join(dataDir, 'seed.iso')

    generateSeedISO(seedISOPath, {
      guestAgentPort: VM_DEFAULTS.guestAgentPort,
      useBundleMount: true,
      env: {},
    })

    const goProc = spawn(this.goHelperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const rpc = new JsonRpcClient(goProc)
    goProc.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim()
        if (!t || isNoisyVMLine(t)) continue
        console.error(`[shogo-vm-provision] ${t}`)
      }
    })

    try {
      await rpc.call('start', {
        kernelPath: path.join(this.vmImageDir, 'vmlinuz'),
        initrdPath: path.join(this.vmImageDir, 'initrd.img'),
        rootDiskPath: tmpOverlay,
        seedISOPath,
        memoryMB: VM_DEFAULTS.memoryMB,
        cpus: VM_DEFAULTS.cpus,
        shares: {
          workspace: tmpWorkspace,
          bundle: bundleDir,
        },
        readOnlyShares: {},
      })

      // Wait for cloud-init to finish (writes /var/lib/cloud/instance/boot-finished)
      const agentPort = await this.findFreePort(VM_DEFAULTS.agentTcpPort)
      await rpc.call('forward', {
        vsockPort: VM_DEFAULTS.agentVsockPort,
        hostPort: agentPort,
      })

      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        try {
          const res = await fetch(`http://localhost:${agentPort}/health`)
          if (res.ok) break
        } catch {}
      }

      // Give cloud-init a moment to fully finish after agent-runtime is healthy
      await new Promise(r => setTimeout(r, 3000))

      try { await rpc.call('stop', {}) } catch {}
    } finally {
      rpc.destroy()
      goProc.kill('SIGTERM')
      fs.rmSync(dataDir, { recursive: true, force: true })
      fs.rmSync(tmpWorkspace, { recursive: true, force: true })
    }

    fs.renameSync(tmpOverlay, provisionedPath)
    console.log('[DarwinVMManager] Provisioned base image created.')
  }

  private ensureOverlay(overlayPath: string): void {
    if (fs.existsSync(overlayPath)) return

    const parentDir = path.dirname(overlayPath)
    fs.mkdirSync(parentDir, { recursive: true })

    // Prefer the provisioned image (has all deps pre-installed) over the raw base
    const provisionedImage = path.join(this.vmImageDir, 'rootfs-provisioned.raw')
    const rawImage = path.join(this.vmImageDir, 'rootfs.raw')
    const qcow2Image = path.join(this.vmImageDir, 'rootfs.qcow2')

    const sourceImage = fs.existsSync(provisionedImage) ? provisionedImage : rawImage

    if (fs.existsSync(sourceImage)) {
      try {
        execSync(`cp -c "${sourceImage}" "${overlayPath}"`, { stdio: 'pipe' })
      } catch {
        try {
          execSync(`cp "${sourceImage}" "${overlayPath}"`, { stdio: 'pipe' })
        } catch (err: any) {
          throw new Error(`Failed to create overlay from ${path.basename(sourceImage)}: ${err.message}`)
        }
      }
      // Ensure overlay is at least 10GB (raw base image is already 10GB, this is a safety net)
      try {
        const stat = fs.statSync(overlayPath)
        if (stat.size < 10 * 1024 * 1024 * 1024) {
          execSync(`truncate -s 10G "${overlayPath}"`, { stdio: 'pipe' })
        }
      } catch {}
      return
    }

    if (fs.existsSync(qcow2Image)) {
      try {
        execSync(`qemu-img convert -f qcow2 -O raw "${qcow2Image}" "${overlayPath}"`, { stdio: 'pipe', timeout: 60000 })
      } catch (err: any) {
        throw new Error(`Failed to convert qcow2 to raw: ${err.message}`)
      }
      return
    }

    throw new Error(`No VM base image found in ${this.vmImageDir} (need rootfs.raw or rootfs.qcow2)`)
  }

  private getVMDataDir(vmId: string): string {
    try {
      const { app } = require('electron')
      return path.join(app.getPath('userData'), 'vm-data', vmId)
    } catch {
      const { tmpdir } = require('os')
      return path.join(tmpdir(), 'shogo-vm-data', vmId)
    }
  }

  private async findFreePort(preferred: number): Promise<number> {
    const { createServer } = require('net')
    for (let port = preferred; port < preferred + 100; port++) {
      const available = await new Promise<boolean>(resolve => {
        const server = createServer()
        server.once('error', () => resolve(false))
        server.once('listening', () => { server.close(() => resolve(true)) })
        server.listen(port, '127.0.0.1')
      })
      if (available) return port
    }
    throw new Error(`No free port found near ${preferred}`)
  }
}
