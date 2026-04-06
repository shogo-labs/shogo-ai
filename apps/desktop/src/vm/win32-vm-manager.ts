// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import type { VMManager, VMConfig, VMHandle } from './types'
import { VM_DEFAULTS } from './types'
import { QMPClient } from './qmp-client'
import { generateSeedISO } from './cloud-init'

/**
 * Windows VM Manager using bundled QEMU with WHPX acceleration.
 *
 * Each VM runs a single agent-runtime process in pool mode (the equivalent
 * of a K8s pod). QEMU manages the VM lifecycle, 9p for file sharing,
 * and SLIRP user-mode networking with port forwarding.
 */
export class Win32VMManager implements VMManager {
  private qemuProcess: ChildProcess | null = null
  private qmpClient: QMPClient | null = null
  private vmRunning = false
  private portForwards = new Map<number, number>()

  constructor(
    private qemuPath: string,
    private vmImageDir: string
  ) {}

  async startVM(config: VMConfig): Promise<VMHandle> {
    if (this.vmRunning) throw new Error('VM already running')

    const vmId = crypto.randomUUID()
    const dataDir = this.getVMDataDir(vmId)
    fs.mkdirSync(dataDir, { recursive: true })

    const seedISOPath = path.join(dataDir, 'seed.iso')
    const credentialMounts = this.resolveCredentialMounts(config.credentialDirs)

    generateSeedISO(seedISOPath, {
      guestAgentPort: VM_DEFAULTS.guestAgentPort,
      workspaceMountTag: 'workspace',
      credentialMounts: credentialMounts.map(m => ({
        tag: m.tag,
        guestPath: m.guestPath,
      })),
    })

    this.ensureOverlay(config.overlayPath)

    const qmpPipePath = `\\\\.\\pipe\\shogo-vm-${vmId}`

    // Forward the guest agent-runtime port to a host port via SLIRP
    const agentHostPort = VM_DEFAULTS.agentTcpPort
    const hostFwds = [
      `hostfwd=tcp::${agentHostPort}-:${VM_DEFAULTS.guestAgentPort}`,
    ]

    const qemuArgs = this.buildQemuArgs({
      config,
      overlayPath: config.overlayPath,
      seedISOPath,
      qmpPipePath,
      credentialMounts,
      hostFwds,
    })

    this.qemuProcess = spawn(this.qemuPath, qemuArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.qemuProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[QEMU] ${data.toString().trim()}`)
    })
    this.qemuProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[QEMU] ${data.toString().trim()}`)
    })

    this.qemuProcess.on('exit', (code) => {
      console.log(`[QEMU] Process exited with code ${code}`)
      this.vmRunning = false
    })

    await this.sleep(1000)
    this.qmpClient = new QMPClient(qmpPipePath)

    let connected = false
    for (let i = 0; i < 30; i++) {
      try {
        await this.qmpClient.connect()
        connected = true
        break
      } catch {
        await this.sleep(500)
      }
    }
    if (!connected) {
      this.cleanup()
      throw new Error('Failed to connect to QEMU QMP')
    }

    this.vmRunning = true

    return {
      id: vmId,
      agentUrl: `http://localhost:${agentHostPort}`,
      pid: this.qemuProcess.pid!,
      platform: 'win32',
    }
  }

  async stopVM(_handle: VMHandle): Promise<void> {
    if (!this.vmRunning) return

    try {
      if (this.qmpClient) {
        await this.qmpClient.shutdown()
        await this.waitForExit(VM_DEFAULTS.shutdownTimeoutMs)
      }
    } catch {
      // force kill
    }

    this.cleanup()
  }

  isRunning(_handle: VMHandle): boolean {
    return this.vmRunning && this.qemuProcess !== null && !this.qemuProcess.killed
  }

  async forwardPort(_handle: VMHandle, guestPort: number, hostPort: number): Promise<void> {
    if (!this.qmpClient) throw new Error('VM not running')
    await this.qmpClient.addPortForward(hostPort, guestPort)
    this.portForwards.set(hostPort, guestPort)
  }

  async removeForward(_handle: VMHandle, hostPort: number): Promise<void> {
    if (!this.qmpClient) throw new Error('VM not running')
    await this.qmpClient.removePortForward(hostPort)
    this.portForwards.delete(hostPort)
  }

  private buildQemuArgs(opts: {
    config: VMConfig
    overlayPath: string
    seedISOPath: string
    qmpPipePath: string
    credentialMounts: Array<{ tag: string; hostPath: string; guestPath: string }>
    hostFwds: string[]
  }): string[] {
    const { config, overlayPath, seedISOPath, qmpPipePath, credentialMounts, hostFwds } = opts

    const args = [
      '-accel', 'whpx', '-accel', 'tcg',
      '-machine', 'q35', '-cpu', 'max',
      '-m', String(config.memoryMB),
      '-smp', String(config.cpus),
      '-kernel', path.join(this.vmImageDir, 'vmlinuz'),
      '-initrd', path.join(this.vmImageDir, 'initrd.img'),
      '-append', 'root=/dev/vda1 console=ttyS0 quiet',
      '-drive', `file=${overlayPath},if=virtio,format=qcow2`,
    ]

    if (fs.existsSync(seedISOPath)) {
      args.push('-drive', `file=${seedISOPath},if=virtio,format=raw,readonly=on`)
    }

    args.push(
      '-virtfs', `local,path=${config.workspaceDir},mount_tag=workspace,security_model=mapped-xattr,id=workspace`
    )

    for (const mount of credentialMounts) {
      args.push(
        '-virtfs', `local,path=${mount.hostPath},mount_tag=${mount.tag},security_model=none,readonly=on,id=${mount.tag}`
      )
    }

    args.push(
      '-netdev', `user,id=net0,${hostFwds.join(',')}`,
      '-device', 'virtio-net-pci,netdev=net0',
    )

    args.push('-qmp', `pipe:${qmpPipePath}`)
    args.push('-nographic')

    return args
  }

  private resolveCredentialMounts(dirs: string[]): Array<{ tag: string; hostPath: string; guestPath: string }> {
    const mounts: Array<{ tag: string; hostPath: string; guestPath: string }> = []
    const home = process.env.USERPROFILE || process.env.HOME || ''

    for (const dir of dirs) {
      const expanded = dir.replace(/^~/, home)
      if (!fs.existsSync(expanded)) continue

      const basename = path.basename(expanded).replace(/^\./, '')
      let guestPath: string

      switch (basename) {
        case 'ssh': guestPath = '/home/shogo/.ssh'; break
        case 'gitconfig': guestPath = '/home/shogo/.gitconfig'; break
        case 'gh': guestPath = '/home/shogo/.config/gh'; break
        default: guestPath = `/home/shogo/.${basename}`; break
      }

      mounts.push({ tag: basename, hostPath: expanded, guestPath })
    }

    return mounts
  }

  private ensureOverlay(overlayPath: string): void {
    if (fs.existsSync(overlayPath)) return

    const parentDir = path.dirname(overlayPath)
    fs.mkdirSync(parentDir, { recursive: true })

    const baseImage = path.join(this.vmImageDir, 'rootfs.qcow2')
    if (!fs.existsSync(baseImage)) {
      throw new Error(`Base VM image not found: ${baseImage}`)
    }

    const qemuImg = path.join(path.dirname(this.qemuPath), 'qemu-img.exe')
    const { execSync } = require('child_process')
    try {
      execSync(
        `"${qemuImg}" create -f qcow2 -b "${baseImage}" -F qcow2 "${overlayPath}"`,
        { stdio: 'pipe', timeout: 10000 }
      )
    } catch (err: any) {
      throw new Error(`Failed to create qcow2 overlay: ${err.message}`)
    }
  }

  private getVMDataDir(vmId: string): string {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'vm-data', vmId)
  }

  private cleanup(): void {
    if (this.qmpClient) {
      this.qmpClient.disconnect()
      this.qmpClient = null
    }
    if (this.qemuProcess && !this.qemuProcess.killed) {
      this.qemuProcess.kill('SIGTERM')
    }
    this.qemuProcess = null
    this.vmRunning = false
    this.portForwards.clear()
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.qemuProcess) { resolve(); return }
      const timeout = setTimeout(() => {
        if (this.qemuProcess && !this.qemuProcess.killed) {
          this.qemuProcess.kill('SIGKILL')
        }
        resolve()
      }, timeoutMs)

      this.qemuProcess.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
