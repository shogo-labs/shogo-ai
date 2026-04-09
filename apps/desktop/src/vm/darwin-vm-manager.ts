// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn, execSync, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import type { VMManager, VMConfig, VMHandle } from './types'
import { VM_DEFAULTS } from './types'
import { QMPClient } from './qmp-client'
import { generateSeedISO } from './cloud-init'
import { isNoisyVMLine } from './vm-log-filter'

/**
 * macOS VM Manager using QEMU with HVF (Hypervisor.framework) acceleration.
 *
 * Replaces the previous Apple Virtualization.framework approach which suffered
 * from unresolved kernel panics (Bad rss-counter state, el0_undef) under SMP
 * workloads. QEMU + HVF uses a different, lower-level Apple hypervisor API
 * that does not exhibit these bugs.
 *
 * Architecture mirrors Win32VMManager:
 * - Pre-provisioned base image with bun, templates pre-installed
 * - Agent-runtime bundle (server.js, shogo.js) embedded in seed ISO
 * - qcow2 overlays with backing-file (instant CoW, no 10GB raw copies)
 * - SLIRP networking with hostfwd (no vsock, no Go/Python bridges)
 * - QMP for graceful shutdown and dynamic port management
 */
export class DarwinVMManager implements VMManager {
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

    this.ensureOverlay(config.overlayPath)

    const qmpPort = await this.findFreePort(44440)
    const agentHostPort = await this.findFreePort(37100)
    const skillHostPort = config.skillServerHostPort || await this.findFreePort(38100)

    const extraFiles: Array<{ name: string; content: Buffer }> = []
    const bundleFiles = config.bundleFiles ?? this.readBundleDir(config.bundleDir)
    for (const [name, content] of Object.entries(bundleFiles)) {
      extraFiles.push({ name, content: typeof content === 'string' ? Buffer.from(content) : content })
    }

    const seedISOPath = path.join(dataDir, 'seed.iso')
    generateSeedISO(seedISOPath, {
      guestAgentPort: VM_DEFAULTS.guestAgentPort,
      useBundleMount: false,
      env: config.env,
      qemuDir: path.dirname(this.qemuPath),
      extraFiles,
    })

    const hostFwds = [
      `hostfwd=tcp::${agentHostPort}-:${VM_DEFAULTS.guestAgentPort}`,
      `hostfwd=tcp::${skillHostPort}-:${VM_DEFAULTS.guestSkillPort}`,
    ]

    const qemuArgs = this.buildQemuArgs({
      config,
      overlayPath: config.overlayPath,
      seedISOPath,
      qmpPort,
      hostFwds,
    })

    this.qemuProcess = spawn(this.qemuPath, qemuArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let accelReported = false
    let stdoutBuf = ''
    let stderrBuf = ''

    this.qemuProcess.stdout?.on('data', (data: Buffer) => {
      stdoutBuf += data.toString()
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
        stdoutBuf = stdoutBuf.slice(nl + 1)
        const t = line.trim()
        if (!t || isNoisyVMLine(t)) continue
        console.log(`[shogo-vm] ${t}`)
      }
    })
    this.qemuProcess.stderr?.on('data', (data: Buffer) => {
      stderrBuf += data.toString()
      let nl: number
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(nl + 1)
        const t = line.trim()
        if (!t || isNoisyVMLine(t)) continue
        if (!accelReported && /HVF|TCG/.test(t)) {
          accelReported = true
          if (/TCG/.test(t) && !/HVF/.test(t)) {
            console.warn('[shogo-vm] WARNING: Running with TCG (software emulation) — HVF acceleration unavailable')
          }
        }
        console.error(`[shogo-vm] ${t}`)
      }
    })

    this.qemuProcess.on('exit', (code) => {
      if (stdoutBuf.trim()) console.log(`[shogo-vm] ${stdoutBuf.trim()}`)
      if (stderrBuf.trim()) console.error(`[shogo-vm] ${stderrBuf.trim()}`)
      console.log(`[shogo-vm] QEMU exited with code ${code}`)
      this.vmRunning = false
    })

    await this.sleep(1000)
    this.qmpClient = new QMPClient(qmpPort)

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
      skillServerPort: skillHostPort,
      pid: this.qemuProcess.pid!,
      platform: 'darwin',
    }
  }

  async stopVM(handle: VMHandle): Promise<void> {
    if (!this.vmRunning) return
    try {
      if (this.qmpClient) {
        await this.qmpClient.shutdown()
        await this.waitForExit(VM_DEFAULTS.shutdownTimeoutMs)
      }
    } catch {}
    this.cleanup()

    const dataDir = this.getVMDataDir(handle.id)
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
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

  // -------------------------------------------------------------------------

  private buildQemuArgs(opts: {
    config: VMConfig
    overlayPath: string
    seedISOPath: string
    qmpPort: number
    hostFwds: string[]
  }): string[] {
    const { config, overlayPath, seedISOPath, qmpPort, hostFwds } = opts

    const args = [
      '-accel', 'hvf',
      '-machine', 'virt',
      '-cpu', 'host',
      '-m', String(config.memoryMB),
      '-smp', String(config.cpus),
      '-kernel', path.join(this.vmImageDir, 'vmlinuz'),
      '-initrd', path.join(this.vmImageDir, 'initrd.img'),
      '-append', 'root=/dev/vda1 console=ttyAMA0 ds=nocloud quiet systemd.mask=boot-efi.mount',
      '-drive', `file=${overlayPath},if=virtio,format=qcow2,cache=writeback`,
      ...(fs.existsSync(seedISOPath) ? ['-drive', `file=${seedISOPath},if=virtio,format=raw,readonly=on`] : []),
      '-netdev', `user,id=net0,${hostFwds.join(',')}`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-qmp', `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
      '-nographic',
      '-no-reboot',
    ]

    return args
  }

  ensureOverlay(overlayPath: string): void {
    if (fs.existsSync(overlayPath)) return

    fs.mkdirSync(path.dirname(overlayPath), { recursive: true })

    const source = path.join(this.vmImageDir, 'rootfs-provisioned.qcow2')
    if (!fs.existsSync(source)) throw new Error(`Base VM image not found: ${source}`)

    const qemuImg = this.findQemuImg()
    execSync(`"${qemuImg}" create -f qcow2 -b "${source}" -F qcow2 "${overlayPath}"`, { stdio: 'pipe', timeout: 10000 })
    execSync(`"${qemuImg}" resize "${overlayPath}" 10G`, { stdio: 'pipe', timeout: 10000 })
  }

  private findQemuImg(): string {
    const sameDirImg = path.join(path.dirname(this.qemuPath), 'qemu-img')
    if (fs.existsSync(sameDirImg)) return sameDirImg
    try {
      return execSync('which qemu-img', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    } catch {}
    return 'qemu-img'
  }

  private readBundleDir(bundleDir?: string): Record<string, Buffer> {
    if (!bundleDir || !fs.existsSync(bundleDir)) return {}

    const files: Record<string, Buffer> = {}
    for (const name of ['server.js', 'shogo.js']) {
      const p = path.join(bundleDir, name)
      if (fs.existsSync(p)) files[name] = fs.readFileSync(p)
    }

    const wasmPath = path.join(bundleDir, 'wasm', 'tree-sitter.wasm')
    if (fs.existsSync(wasmPath)) {
      files['tree-sitter.wasm'] = fs.readFileSync(wasmPath)
    } else {
      const bunModBase = path.join(bundleDir, '..', '..', 'node_modules', '.bun')
      if (fs.existsSync(bunModBase)) {
        try {
          for (const entry of fs.readdirSync(bunModBase, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.startsWith('web-tree-sitter@')) {
              const candidate = path.join(bunModBase, entry.name, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
              if (fs.existsSync(candidate)) { files['tree-sitter.wasm'] = fs.readFileSync(candidate); break }
            }
          }
        } catch {}
      }
    }

    return files
  }

  private getVMDataDir(vmId: string): string {
    try {
      const { app } = require('electron')
      return path.join(app.getPath('userData'), 'vm-data', vmId)
    } catch {
      return path.join(require('os').tmpdir(), 'shogo-vm-data', vmId)
    }
  }

  private cleanup(): void {
    if (this.qmpClient) { this.qmpClient.disconnect(); this.qmpClient = null }
    if (this.qemuProcess && !this.qemuProcess.killed) this.qemuProcess.kill('SIGTERM')
    this.qemuProcess = null
    this.vmRunning = false
    this.portForwards.clear()
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.qemuProcess) { resolve(); return }
      const timeout = setTimeout(() => {
        if (this.qemuProcess && !this.qemuProcess.killed) this.qemuProcess.kill('SIGKILL')
        resolve()
      }, timeoutMs)
      this.qemuProcess.on('exit', () => { clearTimeout(timeout); resolve() })
    })
  }

  private async findFreePort(preferred: number): Promise<number> {
    const net = require('net')
    for (let port = preferred; port < preferred + 100; port++) {
      if (await this.isPortInUse(net, port)) continue
      const canBind = await new Promise<boolean>(resolve => {
        const s = net.createServer()
        s.once('error', () => resolve(false))
        s.once('listening', () => { s.close(() => resolve(true)) })
        s.listen(port, '127.0.0.1')
      })
      if (canBind) return port
    }
    throw new Error(`No free port found near ${preferred}`)
  }

  private isPortInUse(net: any, port: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = new net.Socket()
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
      socket.setTimeout(300, () => { socket.destroy(); resolve(false) })
      socket.connect(port, '127.0.0.1')
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
