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
import { existsSync, mkdirSync, openSync, rmSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { allocatedBytes } from './disk'
import { FcApi, computeReclaimMiB } from './fc-api'
import { deriveNet, setupTap, teardownTap, defaultUplink, type VmNet } from './net'
import { RootfsProvisioner } from './rootfs'

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
  /** Actual allocated NVMe bytes of the per-VM rootfs (CoW-aware). */
  bytesRootfs: number
}

let VM_SEQ = 0

export class FirecrackerVMManager {
  private procs = new Map<string, Subprocess>()
  private uplink = defaultUplink()
  private rootfs: RootfsProvisioner

  constructor(private cfg = config) {
    mkdirSync(this.cfg.runDir, { recursive: true })
    mkdirSync(this.cfg.snapDir, { recursive: true })
    this.rootfs = new RootfsProvisioner(this.cfg)
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

    // Per-VM writable rootfs off the golden image (full copy / reflink CoW /
    // dm-snapshot depending on METAL_ROOTFS_COW).
    const rootfs = this.rootfs.provision(id)
    setupTap(net, this.uplink)

    this.spawnFc(id, socketPath, serialLog)
    await this.waitForSocket(socketPath)
    const api = new FcApi(socketPath)

    await api.bootSource(this.cfg.kernel, this.baseBootArgs(net, cfg.extraBootArgs))
    await api.rootDrive(rootfs, false)
    // Enable balloon statistics pre-boot when reclaim is on — they can't be
    // turned on after InstanceStart, and snapshotVM() polls them to size the
    // pre-snapshot reclaim.
    await api.machineConfig(vcpus, memoryMB, true, this.cfg.balloonReclaim ? 1 : 0)
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
    this.rootfs.release(handle.rootfs)
  }

  isRunning(handle: FcVmHandle): boolean {
    const proc = this.procs.get(handle.id)
    return !!proc && proc.exitCode === null && !proc.killed
  }

  /**
   * Tear down a per-VM rootfs's host resources (full/reflink: delete the file;
   * dm: remove the mapper device + loop + CoW store). Used by the GC to reclaim
   * an evicted snapshot's rootfs and to clean orphaned rootfs files.
   */
  releaseRootfs(rootfsPath: string): void {
    this.rootfs.release(rootfsPath)
  }

  /** Durable-store artifact + mode for a rootfs (see RootfsProvisioner). */
  durableRootfs(rootfsPath: string): { path: string; mode: 'full' | 'diff' } {
    return this.rootfs.durableArtifact(rootfsPath)
  }

  /** Local path a pulled durable rootfs artifact must be materialized at. */
  restoreRootfsArtifactPath(rootfsPath: string): string {
    return this.rootfs.restoreArtifactPath(rootfsPath)
  }

  /**
   * dm mode: is this VM's mapper device still live? The GC uses this as the
   * definitive orphan test for CoW store files — a CoW whose device is mapped
   * backs a live/suspended/claimed VM and must never be reclaimed.
   */
  rootfsDeviceMapped(vmId: string): boolean {
    return this.rootfs.deviceMapped(vmId)
  }

  // TAP networking → guest reachable directly; no host-port forwarding needed.
  async forwardPort(): Promise<void> {}
  async removeForward(): Promise<void> {}

  async setBalloonTargetMB(handle: FcVmHandle, targetMB: number): Promise<void> {
    const api = new FcApi(handle.socketPath)
    await api.setBalloon(targetMB, handle.memoryMB)
  }

  /**
   * Inflate the balloon to reclaim idle guest RAM right before a snapshot, then
   * wait (bounded) for the driver to converge. Stats-guided when available
   * (reclaim only what's free/reclaimable, leaving `balloonFloorMiB` headroom);
   * for VMs booted without stats (older snapshots) it falls back to a blind
   * reclaim of everything above the floor and simply waits out the window.
   * Fully best-effort — any error is logged and the snapshot proceeds.
   */
  private async reclaimBeforeSnapshot(api: FcApi, configuredMiB: number): Promise<void> {
    try {
      const stats = await api.balloonStats()
      const amount = stats
        ? computeReclaimMiB({
            configuredMiB,
            availableMiB: stats.availableMib,
            floorMiB: this.cfg.balloonFloorMiB,
          })
        : Math.max(0, configuredMiB - Math.max(0, this.cfg.balloonFloorMiB))
      if (amount <= 0) return

      await api.balloonInflate(amount)

      // Inflation is async and guest-driver paced (~seconds to reclaim GiBs).
      // Poll actual→target and stop as soon as it converges OR plateaus (the
      // driver can't get more — e.g. the rest is a pinned working set), so we
      // don't burn the whole window once reclaim is effectively done. With no
      // stats (older snapshots) we can't observe progress, so we wait out the
      // window to give the blind inflate time to land.
      const deadline = Date.now() + this.cfg.balloonMaxWaitMs
      let prev = -1
      let stagnant = 0
      while (Date.now() < deadline) {
        await Bun.sleep(this.cfg.balloonPollMs)
        const s = await api.balloonStats()
        if (!s) continue
        if (s.actualMib + 8 >= amount) break // reached target
        // Plateau: <8 MiB gained since last poll. Two in a row → driver is done.
        if (s.actualMib <= prev + 8) {
          if (++stagnant >= 2) break
        } else {
          stagnant = 0
        }
        prev = s.actualMib
      }
    } catch (err: any) {
      console.error('[fc] balloon reclaim before snapshot failed:', err?.message ?? err)
    }
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

    // Reclaim idle guest RAM before the freeze so the mem image is mostly zeros
    // (→ ~3x smaller mem.gz). Must run while the VM is Resumed (the driver can't
    // allocate while paused). Best-effort: never fail a snapshot over reclaim.
    if (this.cfg.balloonReclaim) await this.reclaimBeforeSnapshot(api, handle.memoryMB)

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
      // In dm mode handle.rootfs is the mapper DEVICE (allocatedBytes → 0); the
      // real per-VM footprint is the CoW store file, which durableArtifact()
      // resolves to. full/reflink resolve to the image file itself, so this is
      // correct for every mode and keeps GC cache accounting honest.
      bytesRootfs: allocatedBytes(this.rootfs.durableArtifact(handle.rootfs).path),
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
    // Ensure the rootfs backing path baked into the vmstate is live again
    // (dm-snapshot: rebuild the device from the persisted CoW store).
    this.rootfs.prepareRestore(snap.rootfs)

    this.spawnFc(id, socketPath, serialLog)
    await this.waitForSocket(socketPath)
    const api = new FcApi(socketPath)
    await api.loadSnapshot(snap.snapshotPath, snap.memFilePath, true)

    // The snapshot was taken with the balloon inflated (reclaimed RAM); deflate
    // now so the woken guest gets its full memory back. Best-effort: a failure
    // here just leaves the guest at the smaller footprint (deflate_on_oom still
    // hands pages back under pressure).
    if (this.cfg.balloonReclaim) {
      api.balloonDeflate().catch((err: any) =>
        console.error('[fc] balloon deflate after restore failed:', err?.message ?? err),
      )
    }

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
