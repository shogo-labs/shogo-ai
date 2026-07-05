// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * FirecrackerVMManager — the Linux/bare-metal implementation of the desktop
 * `VMManager` interface (apps/desktop/src/vm/types.ts), plus snapshot/restore.
 *
 * Desktop parity:
 *   - startVM / stopVM / isRunning / setBalloonTargetMB behave like
 *     Darwin/Win32 managers, so the warm-pool controller logic transfers.
 *   - forwardPort/removeForward are no-ops: with TAP networking the guest is
 *     reachable directly at its /30 address (no SLIRP hostfwd needed).
 *
 * New for the microVM substrate:
 *   - snapshotVM(): Pause -> CreateSnapshot(vmstate + mem) -> stop (frees host
 *     RAM). This is the "suspend to snapshot on idle".
 *   - restoreVM(): re-create the tap, spawn a fresh FC, LoadSnapshot(mmap) +
 *     Resume. This is the sub-second "wake".
 */

import { spawn, type Subprocess } from 'bun'
import { copyFileSync, existsSync, mkdirSync, openSync, rmSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { FcApi } from './fc-api'
import { deriveNet, setupTap, teardownTap, defaultUplink, type VmNet } from './net'

export interface FcVmConfig {
  /** Guest-visible RAM ceiling (MiB). */
  memoryMB?: number
  cpus?: number
  /** Pool VMs idle at this smaller footprint via balloon; deflated on assign. */
  poolMemoryMB?: number
  /** Extra kernel cmdline fragment. */
  extraBootArgs?: string
}

export interface FcVmHandle {
  id: string
  /** http://<guestIp>:<guestPort> — where the in-guest agent listens. */
  agentUrl: string
  guestIp: string
  pid: number
  platform: 'linux'
  net: VmNet
  rootfs: string
  socketPath: string
  serialLog: string
  vcpus: number
  memoryMB: number
}

export interface FcSnapshot {
  vmId: string
  snapshotPath: string
  memFilePath: string
  net: VmNet
  rootfs: string
  vcpus: number
  memoryMB: number
  createdAt: number
  bytesMem: number
  bytesState: number
}

let VM_SEQ = 0

export class FirecrackerVMManager {
  private procs = new Map<string, Subprocess>()
  private uplink = defaultUplink()

  constructor(private cfg = config) {
    mkdirSync(this.cfg.runDir, { recursive: true })
    mkdirSync(this.cfg.snapDir, { recursive: true })
  }

  private baseBootArgs(net: VmNet, extra?: string): string {
    return [
      'console=ttyS0',
      'reboot=k',
      'panic=1',
      'pci=off',
      'root=/dev/vda',
      'rw',
      'i8042.noaux',
      'i8042.nomux',
      'i8042.nopnp',
      'i8042.dumbkbd',
      net.bootIpArg,
      this.cfg.guestInit ? `init=${this.cfg.guestInit}` : '',
      extra ?? '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  private spawnFc(id: string, socketPath: string, serialLog: string): Subprocess {
    if (existsSync(socketPath)) rmSync(socketPath, { force: true })
    const fd = openSync(serialLog, 'a')
    const proc = spawn([this.cfg.fcBin, '--api-sock', socketPath, '--id', id], {
      stdout: fd,
      stderr: fd,
      stdin: 'ignore',
    })
    this.procs.set(id, proc)
    return proc
  }

  private async waitForSocket(socketPath: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (existsSync(socketPath)) return
      await Bun.sleep(5)
    }
    throw new Error(`FC API socket never appeared: ${socketPath}`)
  }

  // --- VMManager interface -------------------------------------------------

  async startVM(cfg: FcVmConfig = {}): Promise<FcVmHandle> {
    const n = VM_SEQ++
    const id = `fcvm-${n}-${Date.now().toString(36)}`
    const net = deriveNet(n, this.cfg.tapCidrBase)
    const vcpus = cfg.cpus ?? this.cfg.vcpus
    const memoryMB = cfg.memoryMB ?? this.cfg.memMiB

    const socketPath = join(this.cfg.runDir, `${id}.sock`)
    const serialLog = join(this.cfg.runDir, `${id}.serial`)
    const rootfs = join(this.cfg.runDir, `${id}.rootfs.ext4`)

    // Per-VM writable rootfs copy off the golden image.
    copyFileSync(this.cfg.baseRootfs, rootfs)
    setupTap(net, this.uplink)

    this.spawnFc(id, socketPath, serialLog)
    await this.waitForSocket(socketPath)
    const api = new FcApi(socketPath)

    await api.bootSource(this.cfg.kernel, this.baseBootArgs(net, cfg.extraBootArgs))
    await api.rootDrive(rootfs, false)
    await api.machineConfig(vcpus, memoryMB, true)
    await api.networkInterface('eth0', net.tap, net.guestMac)
    await api.instanceStart()

    const proc = this.procs.get(id)!
    return {
      id,
      agentUrl: `http://${net.guestIp}:${this.cfg.guestPort}`,
      guestIp: net.guestIp,
      pid: proc.pid,
      platform: 'linux',
      net,
      rootfs,
      socketPath,
      serialLog,
      vcpus,
      memoryMB,
    }
  }

  async stopVM(handle: FcVmHandle): Promise<void> {
    const proc = this.procs.get(handle.id)
    if (proc) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      this.procs.delete(handle.id)
    }
    teardownTap(handle.net)
    rmSync(handle.socketPath, { force: true })
    rmSync(handle.rootfs, { force: true })
  }

  isRunning(handle: FcVmHandle): boolean {
    const proc = this.procs.get(handle.id)
    return !!proc && proc.exitCode === null && !proc.killed
  }

  // TAP networking → guest reachable directly; no host-port forwarding needed.
  async forwardPort(): Promise<void> {}
  async removeForward(): Promise<void> {}

  async setBalloonTargetMB(handle: FcVmHandle, targetMB: number): Promise<void> {
    const api = new FcApi(handle.socketPath)
    await api.setBalloon(targetMB, handle.memoryMB)
  }

  // --- Snapshot / restore (the substrate's reason to exist) ----------------

  /**
   * Suspend a running VM to a full snapshot and free its host RAM.
   * Pause -> CreateSnapshot(vmstate + mem) -> SIGKILL the FC process.
   * The tap and rootfs are left in place so restore is cheap.
   */
  async snapshotVM(handle: FcVmHandle): Promise<FcSnapshot> {
    const api = new FcApi(handle.socketPath)
    const snapshotPath = join(this.cfg.snapDir, `${handle.id}.vmstate`)
    const memFilePath = join(this.cfg.snapDir, `${handle.id}.mem`)

    await api.pause()
    await api.createSnapshot(snapshotPath, memFilePath)

    // Free RAM: the suspended VM no longer occupies the host.
    const proc = this.procs.get(handle.id)
    if (proc) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      this.procs.delete(handle.id)
    }
    rmSync(handle.socketPath, { force: true })

    const memStat = await Bun.file(memFilePath).stat().catch(() => ({ size: 0 }) as any)
    const stStat = await Bun.file(snapshotPath).stat().catch(() => ({ size: 0 }) as any)
    return {
      vmId: handle.id,
      snapshotPath,
      memFilePath,
      net: handle.net,
      rootfs: handle.rootfs,
      vcpus: handle.vcpus,
      memoryMB: handle.memoryMB,
      createdAt: Date.now(),
      bytesMem: memStat.size ?? 0,
      bytesState: stStat.size ?? 0,
    }
  }

  /**
   * Restore a snapshot into a fresh FC process and resume it.
   * The tap must exist again before LoadSnapshot (network device is part of
   * the vmstate). Returns a handle addressing the same guest IP as before.
   */
  async restoreVM(snap: FcSnapshot): Promise<FcVmHandle> {
    // Bounded, short id — FC's --id is capped at 64 chars, so we must NOT
    // chain the prior id across repeated restores.
    const id = `fcr-${(VM_SEQ++).toString(36)}-${Date.now().toString(36).slice(-5)}`
    const socketPath = join(this.cfg.runDir, `${id}.sock`)
    const serialLog = join(this.cfg.runDir, `${id}.serial`)

    setupTap(snap.net, this.uplink) // recreate the exact device name

    this.spawnFc(id, socketPath, serialLog)
    await this.waitForSocket(socketPath)
    const api = new FcApi(socketPath)
    await api.loadSnapshot(snap.snapshotPath, snap.memFilePath, true)

    const proc = this.procs.get(id)!
    return {
      id,
      agentUrl: `http://${snap.net.guestIp}:${this.cfg.guestPort}`,
      guestIp: snap.net.guestIp,
      pid: proc.pid,
      platform: 'linux',
      net: snap.net,
      rootfs: snap.rootfs,
      socketPath,
      serialLog,
      vcpus: snap.vcpus,
      memoryMB: snap.memoryMB,
    }
  }
}
