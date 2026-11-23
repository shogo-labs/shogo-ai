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
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { classConfig, config, type VmClass } from './config'
import { DataDriveProvisioner, WORKSPACE_DRIVE_SUFFIX, WORKSPACE_DRIVE_WORKSPACE_REL } from './data-drive'
import { allocatedBytes } from './disk'
import { FcApi, computeReclaimMiB } from './fc-api'
import { pidAlive } from './live-registry'
import {
  deriveNet,
  setupTap,
  teardownTap,
  teardownTapByName,
  defaultUplink,
  existingTapIndices,
  existingTaps,
  tapCapacity,
  type HostTap,
  type VmNet,
} from './net'
import { RootfsProvisioner, type CowUsage } from './rootfs'
import { digHoles } from './sparsify'
import { packRescuedWorkspace, withReadOnlyMount, type RescuedArchives } from './workspace-rescue'

export interface FcVmConfig {
  /** Guest-visible RAM ceiling (MiB). Overrides the class default when set. */
  memoryMB?: number
  cpus?: number
  /** Pool VMs idle at this smaller footprint via balloon; deflated on assign. */
  poolMemoryMB?: number
  /** Extra kernel cmdline fragment. */
  extraBootArgs?: string
  /**
   * Which golden rootfs/kernel/sizing to boot from (see config.ts
   * classConfig). Defaults to 'standard' — every call site that doesn't pass
   * this gets byte-identical behavior to before VM classes existed.
   */
  vmClass?: VmClass
  /** Golden image to provision the rootfs from instead of the class base (the staged rootfs). */
  rootfsBase?: string
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
  /** VM class this handle was booted as. Absent on old/adopted callers = 'standard'. */
  vmClass: VmClass
  /** Second virtio-blk drive backing path (docker class only). */
  dataDrive?: string
  /** Workspace drive backing path (/app/workspace in the guest), when enabled. */
  workspaceDrive?: string
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
  /** VM class this snapshot was taken from. Absent = 'standard'. */
  vmClass?: VmClass
  /** Second data-drive backing path (docker class), carried through suspend/resume. */
  dataDrive?: string
  /** Workspace drive backing path, carried through suspend/resume. */
  workspaceDrive?: string
}

/** How often `waitForSocket` looks for the socket (and notices a dead child). */
const FC_SOCKET_POLL_MS = 5

/** Wall-clock half of the socket wait's budget (see {@link waitForSocket}). */
const FC_SOCKET_WAIT_MS = 10_000

/** Last lines of a VM's serial log, for an error message. */
function serialTail(path: string, lines = 10): string {
  try {
    const txt = readFileSync(path, 'utf8')
    if (!txt) return ''
    const tail = txt.trimEnd().split('\n').slice(-lines).join('\n')
    return tail ? `\n--- serial tail ---\n${tail}` : ''
  } catch {
    return ''
  }
}

/**
 * Grace before the orphan reaper will SIGKILL a firecracker process that is not
 * referenced by any pool map. Must exceed the longest legitimate window in which
 * a freshly-spawned FC is untracked (boot/restore under the heavy semaphore +
 * health polling + the /pool/assign round-trip). Anything untracked longer than
 * this is a genuine leak from a failure/race path.
 */
const ORPHAN_PROC_GRACE_MS = parseInt(process.env.METAL_ORPHAN_PROC_GRACE_MS || '120000', 10)

/**
 * How long an index handed out by `nextVmIndex` stays claimed against a
 * concurrent allocator. It only has to cover the gap until `setupTap` creates
 * the device (milliseconds), and is pruned on read, so a host that never runs
 * the tap GC cannot slowly accumulate permanently-taken indices.
 */
const TAP_RESERVATION_MS = 60_000

/**
 * Kernel cmdline for a guest boot. `clocksource=kvm-clock` is not optional:
 * a snapshot restore's `clock_realtime` (fc-api.loadSnapshot) only advances
 * kvm-clock, and the kernel picks its clocksource at boot. On a host with
 * `constant_tsc`/`nonstop_tsc` (every metal host) an unqualified guest switches
 * `kvm-clock` → `tsc` within milliseconds of boot, and TSC is not moved by
 * KVM_CLOCK_REALTIME — so the guest resumes with the wall clock frozen at the
 * moment the snapshot was taken (staging, 2026-10-25: 4h40m behind after a
 * 4h40m suspend, which is also what breaks outbound TLS with "certificate is
 * not yet valid"). Pinning the clocksource makes `clock_realtime` effective for
 * every snapshot taken from a VM booted with this cmdline. Snapshots taken
 * before this change keep their frozen clock until they cold-boot; the
 * `POST /pool/rehydrate` clock sync is the backstop for those.
 */
export function guestBootArgs(o: { bootIpArg: string; guestInit?: string; extra?: string }): string {
  return [
    'console=ttyS0',
    'reboot=k',
    'panic=1',
    'pci=off',
    'root=/dev/vda',
    'rw',
    'clocksource=kvm-clock',
    'i8042.noaux',
    'i8042.nomux',
    'i8042.nopnp',
    'i8042.dumbkbd',
    o.bootIpArg,
    o.guestInit ? `init=${o.guestInit}` : '',
    o.extra ?? '',
  ]
    .filter(Boolean)
    .join(' ')
}

export class FirecrackerVMManager {
  private procs = new Map<string, Subprocess>()
  /**
   * id → pid for firecracker processes ADOPTED across a node-agent restart. We
   * don't own a Bun.Subprocess for them (the child was spawned by the previous
   * agent process and reparented to init when systemd `KillMode=process` let the
   * agent exit without its cgroup). Liveness and kill therefore go through the
   * pid; everything else (API socket, tap, rootfs) is unchanged.
   */
  private adopted = new Map<string, number>()
  /** id → spawn timestamp, for the age-gated orphan reaper. */
  private spawnedAt = new Map<string, number>()
  /**
   * Monotonic VM/tap index. `fctap<vmSeq>` + a /30 are derived from it, and
   * `setupTap` deletes-then-recreates that device — so an index handed out while
   * another VM still holds it destroys that VM's tap fd. A single agent lifetime
   * never reuses an index (this only ever increments), but it USED to be a
   * module global reset to 0 on every restart, so after a rolling deploy the
   * warm-pool spawner reused indices still held by ADOPTED VMs and broke their
   * networking ("Failed to write to tap: File descriptor in bad state"). It is
   * now an instance field seeded past every persisted (adopted + suspended) tap
   * index at startup via `seedVmSeq`, AND every allocation (`nextVmIndex`) skips
   * indices whose `fctap<n>` device physically exists on the host — so even a
   * registry wipe (runtime.ext4 rebuild) or a resumed VM re-taking its persisted
   * index can't cause a collision.
   */
  private vmSeq = 0
  /**
   * index → when `nextVmIndex` handed it out. A VM between reservation and
   * landing in one of the pool's maps owns a tap that no map can vouch for yet,
   * so the orphan-tap GC must leave recently-reserved indices alone. This is the
   * tap counterpart of `spawnedAt` for processes; entries age out of the window
   * and are pruned on read.
   */
  private reservedAt = new Map<number, number>()
  /**
   * index → the sweep timestamp at which a tap first looked orphaned. Reclaim
   * requires two consecutive sightings, so a tap can only be deleted after
   * surviving a full GC interval of suspicion — a second, timing-independent
   * guard behind the ownership and NO-CARRIER checks.
   */
  private tapOrphanStrikes = new Map<number, number>()
  /** NAT uplink, resolved once from the host's default route (first boot). */
  private uplinkPending: Promise<string | undefined> | null = null
  private rootfs: RootfsProvisioner
  private dataDrives: DataDriveProvisioner

  constructor(private cfg = config) {
    mkdirSync(this.cfg.runDir, { recursive: true })
    mkdirSync(this.cfg.snapDir, { recursive: true })
    this.rootfs = new RootfsProvisioner(this.cfg)
    this.dataDrives = new DataDriveProvisioner(this.cfg)
  }

  private baseBootArgs(net: VmNet, extra?: string): string {
    return guestBootArgs({ bootIpArg: net.bootIpArg, guestInit: this.cfg.guestInit, extra })
  }

  /** The host's default-route interface, resolved once (used as the NAT uplink). */
  private uplink(): Promise<string | undefined> {
    this.uplinkPending ??= defaultUplink()
    return this.uplinkPending
  }

  // protected so a restore can be exercised without a real FC binary (see
  // firecracker-vm-manager.restore-deflate.test.ts); nothing outside the class family.
  protected spawnFc(id: string, socketPath: string, serialLog: string): Subprocess {
    if (existsSync(socketPath)) rmSync(socketPath, { force: true })
    const fd = openSync(serialLog, 'a')
    const proc = spawn([this.cfg.fcBin, '--api-sock', socketPath, '--id', id], {
      stdout: fd,
      stderr: fd,
      stdin: 'ignore',
    })
    this.procs.set(id, proc)
    this.spawnedAt.set(id, Date.now())
    return proc
  }

  /** SIGKILL a tracked FC process and forget it. Safe to call repeatedly. */
  private killProc(id: string): void {
    const proc = this.procs.get(id)
    if (proc) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      this.procs.delete(id)
    }
    const adoptedPid = this.adopted.get(id)
    if (adoptedPid !== undefined) {
      try {
        process.kill(adoptedPid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      this.adopted.delete(id)
    }
    this.spawnedAt.delete(id)
  }

  /**
   * Re-attach to a firecracker process that survived a node-agent restart. The
   * caller (pool.adopt) has already verified the pid is alive, the API socket
   * exists, and the guest is healthy. From here the VM is a first-class member of
   * the manager: isRunning()/killProc()/snapshotVM() all work through the pid and
   * the persisted socket path exactly as for a VM we spawned ourselves.
   */
  adoptVM(handle: FcVmHandle): void {
    this.adopted.set(handle.id, handle.pid)
    // Treat as long-established so the age-gated orphan reaper never touches it.
    this.spawnedAt.set(handle.id, Date.now())
  }

  /**
   * Every firecracker process currently running on the host, with the `--id`
   * it was launched with (our handle id) parsed from /proc/<pid>/cmdline. Used
   * at startup to find VMs the previous agent left behind.
   */
  scanHostFcProcs(): Array<{ pid: number; id: string | null }> {
    const out: Array<{ pid: number; id: string | null }> = []
    let entries: string[] = []
    try {
      entries = readdirSync('/proc')
    } catch {
      return out
    }
    const fcName = this.cfg.fcBin.split('/').pop() || 'firecracker'
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue
      let argv: string[]
      try {
        argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean)
      } catch {
        continue // process vanished or not ours to read
      }
      if (argv.length === 0) continue
      const exe = argv[0]
      const isFc = exe === this.cfg.fcBin || exe.endsWith('/firecracker') || exe === fcName || exe === 'firecracker'
      if (!isFc) continue
      const idIdx = argv.indexOf('--id')
      const id = idIdx >= 0 && idIdx + 1 < argv.length ? argv[idIdx + 1] : null
      out.push({ pid: parseInt(name, 10), id })
    }
    return out
  }

  /**
   * SIGKILL every firecracker process on the host whose `--id` is NOT in
   * `keepIds`. Run ONCE at startup, AFTER adoption, to clear VMs the previous
   * agent left behind that we did not re-adopt: old warm-pool VMs (no state to
   * lose) and assigned VMs whose guest failed health. `keepIds` must be the set
   * of adopted handle ids. Returns the number reaped.
   */
  reapHostOrphans(keepIds: Set<string>): number {
    let killed = 0
    for (const { pid, id } of this.scanHostFcProcs()) {
      if (id && keepIds.has(id)) continue
      try {
        process.kill(pid, 'SIGKILL')
        killed++
      } catch {
        continue // already gone
      }
      if (id) {
        try {
          rmSync(join(this.cfg.runDir, `${id}.sock`), { force: true })
        } catch {
          /* ignore */
        }
      }
    }
    if (killed) console.warn(`[fc] reaped ${killed} non-adopted firecracker process(es) at startup`)
    return killed
  }

  /**
   * How long to wait for a freshly-spawned Firecracker process to create its API
   * socket — wall-clock AND a number of completed poll ticks, never one alone.
   *
   * Wall-clock alone is not enough: this loop shares its thread with every other
   * boot's work, so a synchronous `dmsetup`/`mkfs`/rootfs copy on the boot path
   * could freeze it past a short deadline and fail a boot whose socket had been
   * created the whole time (the parallel-assign `FC API socket never appeared`
   * failures — 19/40 on staging, SHO-545). Polling enough times is the actual
   * observation the wait needs, so both must expire before this gives up, and
   * the socket is looked at one final time after that.
   *
   * A child that has already exited fails immediately with its exit code and the
   * serial tail: that is a real Firecracker failure and must not be reported (or
   * waited out) as a socket timeout.
   *
   * protected for the same reason as spawnFc: a test can stand in for the socket.
   */
  protected async waitForSocket(
    id: string,
    socketPath: string,
    serialLog: string,
    budgetMs = FC_SOCKET_WAIT_MS,
  ): Promise<void> {
    const proc = this.procs.get(id)
    const deadline = Date.now() + budgetMs
    // Half the polls we'd make in an idle budget: enough that a frozen loop
    // (zero polls) can never satisfy it, few enough that a healthy boot doesn't.
    const minPolls = Math.max(1, Math.ceil(budgetMs / FC_SOCKET_POLL_MS / 2))
    let polls = 0
    while (true) {
      if (existsSync(socketPath)) return
      const code = proc?.exitCode
      if (code !== null && code !== undefined) {
        throw new Error(
          `FC process exited (code ${code}) before its API socket appeared: ${socketPath}` +
            serialTail(serialLog),
        )
      }
      if (Date.now() >= deadline && polls >= minPolls) break
      polls++
      await Bun.sleep(FC_SOCKET_POLL_MS)
    }
    // The socket can appear during the last sleep — check once more before failing.
    if (existsSync(socketPath)) return
    throw new Error(`FC API socket never appeared: ${socketPath}${serialTail(serialLog)}`)
  }

  // --- VMManager interface -------------------------------------------------

  /**
   * Ensure the next warm-VM/tap index is at least `nextAtLeast`. Called at
   * startup (pool.adopt) with `max(tap index of every adopted + suspended VM)+1`
   * so a freshly-spawned VM never collides with a live or persisted tap.
   */
  seedVmSeq(nextAtLeast: number): void {
    if (Number.isFinite(nextAtLeast) && nextAtLeast > this.vmSeq) {
      // The seed is only a starting scan position — `nextVmIndex` wraps and
      // skips occupied slots, so a seed at/above capacity is fine (it's taken
      // mod capacity). Keep it in range so `peekNextTap` never derives an
      // out-of-range IP.
      this.vmSeq = nextAtLeast % tapCapacity(this.cfg.tapCidrBase)
    }
  }

  /** Tap indices currently live on the host. Overridable seam for tests. */
  protected hostTapIndices(): Promise<Set<number>> {
    return existingTapIndices()
  }

  /** Host taps with their in-use flag. Overridable seam for tests. */
  protected hostTaps(): Promise<HostTap[]> {
    return existingTaps()
  }

  /** Delete one tap device by name. Overridable seam for tests. */
  protected deleteTap(name: string): Promise<void> {
    return teardownTapByName(name)
  }

  /**
   * Release a VM's /30 device. The pool routes tap teardown through the manager
   * for the same reason it routes rootfs teardown (`releaseRootfs`): host
   * resources are owned here, so there is one path to fix and one to stub.
   */
  async releaseTap(net: VmNet): Promise<void> {
    await this.deleteTap(net.tap)
  }

  /**
   * Reserve the next VM/tap index for a fresh spawn. Advances the monotonic
   * counter AND skips any `fctap<n>` device that physically exists on the host
   * right now. The counter alone is not enough: a `runtime.ext4` rebuild wipes
   * the durable registries so `seedVmSeq` can't learn the survivors' indices
   * (the counter resets to 0), and a resumed VM re-takes its persisted index
   * out-of-band. Cross-checking `ip link` closes both holes — we never hand a
   * fresh VM a device a live guest is still using, so setupTap's
   * delete-then-recreate can't blackhole a running guest. Reservations made by
   * an earlier `nextVmIndex` call are folded in as well, since the device does
   * not exist on the host yet — so two boots that scan concurrently still land
   * on distinct indices.
   */
  private async nextVmIndex(): Promise<number> {
    const now = Date.now()
    for (const [n, at] of [...this.reservedAt]) if (now - at > TAP_RESERVATION_MS) this.reservedAt.delete(n)
    const taken = new Set(await this.hostTapIndices())
    for (const n of this.reservedAt.keys()) taken.add(n)
    const cap = tapCapacity(this.cfg.tapCidrBase)
    // Scan upward from the last position for locality, but WRAP within
    // [0, cap) and skip every physically-present device. Both live and
    // suspended VMs keep their `fctap<n>` on the host (suspend leaves the tap
    // for cheap restore), so `ip link` is a complete "in use" set — wrapping
    // can't collide with a running or resumable guest. This reclaims indices
    // freed by teardown and, critically, never returns an index >= cap (which
    // `deriveNet` would turn into an invalid IP, 500-ing every /assign — the
    // prod incident where the monotonic counter climbed past 16383).
    const start = ((this.vmSeq % cap) + cap) % cap
    for (let i = 0; i < cap; i++) {
      const n = (start + i) % cap
      if (!taken.has(n)) {
        this.vmSeq = (n + 1) % cap
        // Claim it against the orphan-tap GC before `setupTap` has even run:
        // for the next few seconds this index exists only here.
        this.reservedAt.set(n, Date.now())
        return n
      }
    }
    throw new Error(
      `metal: TAP address space exhausted — all ${cap} /30 slots occupied on this host`,
    )
  }

  /**
   * The index + `fctap<n>` name the NEXT spawned VM will use, WITHOUT consuming
   * it. This is the observable end of the restart collision-safety invariant: a
   * freshly-started agent must never hand a new warm VM a tap still owned by an
   * adopted (live) or suspended (resume-on-demand) VM, since `setupTap`
   * deletes-then-recreates the device. Used in restart diagnostics and asserted
   * by the pool seeding tests.
   */
  peekNextTap(): { index: number; tap: string } {
    const cap = tapCapacity(this.cfg.tapCidrBase)
    const index = ((this.vmSeq % cap) + cap) % cap
    return { index, tap: deriveNet(index, this.cfg.tapCidrBase).tap }
  }

  async startVM(cfg: FcVmConfig = {}): Promise<FcVmHandle> {
    const vmClass: VmClass = cfg.vmClass ?? 'standard'
    const cc = classConfig(this.cfg, vmClass)

    const n = await this.nextVmIndex()
    const id = `fcvm-${n}-${Date.now().toString(36)}`
    const net = deriveNet(n, this.cfg.tapCidrBase)
    const vcpus = cfg.cpus ?? cc.vcpus
    const memoryMB = cfg.memoryMB ?? cc.memMiB

    const socketPath = join(this.cfg.runDir, `${id}.sock`)
    const serialLog = join(this.cfg.runDir, `${id}.serial`)

    // Per-VM writable rootfs off the class's golden image (full copy / reflink
    // CoW / dm-snapshot depending on METAL_ROOTFS_COW). dm mode is restricted
    // to 'standard' by isVmClassSupported()/callers, so it never reaches here
    // with a non-default base — provision() always uses cfg.baseRootfs in dm
    // mode regardless of what's passed.
    const rootfs = await this.rootfs.provision(id, cfg.rootfsBase ?? cc.baseRootfs)
    let dataDrive: string | undefined
    let workspaceDrive: string | undefined
    // From here on any throw must NOT leak the FC process / tap / rootfs: a
    // partial boot (socket never appears, an FC API call fails, guest never
    // starts) otherwise leaves a live `firecracker` child untracked by the pool
    // — the churn leak that piled up ~700 processes and thrashed the host.
    // The cleanup is awaited as well: these are child processes now, so a
    // fire-and-forget teardown could still be running when the next boot reuses
    // the index.
    try {
      await setupTap(net, await this.uplink())

      this.spawnFc(id, socketPath, serialLog)
      await this.waitForSocket(id, socketPath, serialLog)
      const api = new FcApi(socketPath)

      await api.bootSource(cc.kernel, this.baseBootArgs(net, cfg.extraBootArgs))
      await api.rootDrive(rootfs, false)
      if (cc.dataDriveMiB > 0) {
        dataDrive = await this.dataDrives.provision(id, cc.dataDriveMiB)
        await api.dataDrive(dataDrive)
      }
      // After the docker drive so that one stays /dev/vdb for the docker
      // rootfs; fc-init finds this one by label, not by device name.
      if (this.cfg.workspaceDriveMiB > 0) {
        workspaceDrive = await this.dataDrives.provision(id, this.cfg.workspaceDriveMiB, 'workspace')
        await api.dataDrive(workspaceDrive, 'workspace')
      }
      // Enable balloon statistics pre-boot when reclaim is on — they can't be
      // turned on after InstanceStart, and both the idle pass and snapshotVM()
      // poll them to size the reclaim. Free page reporting is pre-boot only too.
      await api.machineConfig(
        vcpus,
        memoryMB,
        true,
        this.cfg.balloonReclaim || this.cfg.idleReclaim ? 1 : 0,
        this.cfg.balloonFreePageReporting,
      )
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
        vmClass,
        dataDrive,
        workspaceDrive,
      }
    } catch (err) {
      this.killProc(id)
      try { await teardownTap(net) } catch { /* ignore */ }
      try { rmSync(socketPath, { force: true }) } catch { /* ignore */ }
      try { await this.rootfs.release(rootfs) } catch { /* ignore */ }
      try { if (dataDrive) await this.dataDrives.release(dataDrive) } catch { /* ignore */ }
      try { if (workspaceDrive) await this.dataDrives.release(workspaceDrive) } catch { /* ignore */ }
      throw err
    }
  }

  /**
   * `keepRootfs` stops the VM but leaves its disks (rootfs AND workspace drive)
   * in place so the host can still read the workspace off them (see
   * pool.rescueWorkspace); the caller then owns calling {@link releaseRootfs} /
   * {@link releaseDataDrive} or {@link quarantineRootfs}.
   */
  async stopVM(handle: FcVmHandle, opts: { keepRootfs?: boolean } = {}): Promise<void> {
    this.killProc(handle.id)
    await teardownTap(handle.net)
    rmSync(handle.socketPath, { force: true })
    if (!opts.keepRootfs) await this.rootfs.release(handle.rootfs)
    if (handle.dataDrive) this.dataDrives.release(handle.dataDrive)
    if (handle.workspaceDrive && !opts.keepRootfs) this.dataDrives.release(handle.workspaceDrive)
  }

  /**
   * Pack `/app/workspace` (source + `.git`) off a stopped VM's disks: its
   * workspace drive when it had one, else the rootfs.
   */
  async extractWorkspace(
    disks: { rootfs: string; workspaceDrive?: string },
    outDir: string,
  ): Promise<RescuedArchives> {
    const scratch = join(this.cfg.runDir, 'rescue')
    if (disks.workspaceDrive) {
      if (!this.dataDrives.exists(disks.workspaceDrive)) {
        throw new Error(`workspace drive missing: ${disks.workspaceDrive}`)
      }
      return withReadOnlyMount(disks.workspaceDrive, scratch, { loop: true }, (root) =>
        packRescuedWorkspace(root, outDir, undefined, WORKSPACE_DRIVE_WORKSPACE_REL),
      )
    }
    const { device, loop } = await this.rootfs.readOnlySource(disks.rootfs)
    return withReadOnlyMount(device, scratch, { loop }, (root) => packRescuedWorkspace(root, outDir))
  }

  /** Keep a stopped VM's disk out of GC's reach. Returns the kept path or null. */
  quarantineRootfs(rootfsPath: string, label: string): Promise<string | null> {
    return this.rootfs.quarantine(rootfsPath, label)
  }

  /**
   * Keep a stopped VM's workspace drive out of GC's reach, under
   * `<runDir>/quarantine/` (the orphan sweep only lists runDir's top level).
   * Returns the kept path or null.
   */
  quarantineWorkspaceDrive(drivePath: string, label: string): string | null {
    const safe = label.replace(/[^A-Za-z0-9._-]/g, '_')
    try {
      const dir = join(this.cfg.runDir, 'quarantine')
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, `${safe}${WORKSPACE_DRIVE_SUFFIX}`)
      renameSync(drivePath, dest)
      return dest
    } catch (err: any) {
      console.error(`[fc] could not quarantine workspace drive ${drivePath}:`, err?.message ?? err)
      return null
    }
  }

  /** Tear down an orphaned/evicted data-drive file directly by path (GC path). */
  releaseDataDrive(dataDrivePath: string): void {
    this.dataDrives.release(dataDrivePath)
  }

  /**
   * Provision a fresh, empty, formatted data-drive file — used when a
   * durable-store resume needs a docker-class data volume that was never
   * pushed off-box (see data-drive.ts). Not tied to a running VM's lifecycle
   * the way `startVM`'s provisioning is; the caller attaches the returned path
   * as the snapshot's `dataDrive` before restoreVM.
   */
  provisionFreshDataDrive(id: string, sizeMiB: number): Promise<string> {
    return this.dataDrives.provision(id, sizeMiB)
  }

  /**
   * SIGKILL any tracked firecracker process that no live VM references — a
   * safety net for FC processes orphaned by a failure/race path (the churn
   * leak). `liveIds` is the set of ids the pool still tracks (warm + assigned);
   * suspended VMs have no process (killed at snapshot). Age-gated so a VM still
   * booting/restoring/assigning (legitimately untracked for a few seconds) is
   * never killed. Returns the number reaped.
   *
   * Kills the process only — the /30 it held is reclaimed by
   * {@link reconcileOrphanTaps}, which can identify the device from the host
   * side (this path has no handle, so it has no `VmNet` to tear down).
   */
  reapOrphans(liveIds: Set<string>, graceMs = ORPHAN_PROC_GRACE_MS): number {
    const now = Date.now()
    let killed = 0
    for (const id of [...this.procs.keys()]) {
      if (liveIds.has(id)) continue
      const born = this.spawnedAt.get(id) ?? now
      if (now - born < graceMs) continue // within the boot/restore/assign window
      this.killProc(id)
      try { rmSync(join(this.cfg.runDir, `${id}.sock`), { force: true }) } catch { /* ignore */ }
      killed++
    }
    if (killed) console.warn(`[fc] reaped ${killed} orphaned firecracker process(es)`)
    return killed
  }

  /** Count of live firecracker processes this manager is tracking. */
  procCount(): number {
    return this.procs.size + this.adopted.size
  }

  isRunning(handle: FcVmHandle): boolean {
    const proc = this.procs.get(handle.id)
    if (proc) return proc.exitCode === null && !proc.killed
    const adoptedPid = this.adopted.get(handle.id)
    if (adoptedPid !== undefined) return pidAlive(adoptedPid)
    return false
  }

  /**
   * Tear down a per-VM rootfs's host resources (full/reflink: delete the file;
   * dm: remove the mapper device + loop + CoW store). Used by the GC to reclaim
   * an evicted snapshot's rootfs and to clean orphaned rootfs files.
   */
  async releaseRootfs(rootfsPath: string): Promise<void> {
    await this.rootfs.release(rootfsPath)
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
  rootfsDeviceMapped(vmId: string): Promise<boolean> {
    return this.rootfs.deviceMapped(vmId)
  }

  /**
   * Reclaim orphaned dm devices / loops / CoW files with no owning VM (see
   * RootfsProvisioner.reconcileOrphanDevices). `keepVmIds` are the rootfs-device
   * vmIds the pool still tracks; everything else that's unused + past the grace
   * window is a leaked orphan. Returns the number of devices reclaimed.
   */
  async reconcileOrphanRootfs(keepVmIds: Set<string>, graceMs: number, max = 200): Promise<number> {
    return this.rootfs.reconcileOrphanDevices(keepVmIds, graceMs, max)
  }

  /**
   * Reclaim `fctap<n>` devices that belong to no VM the pool tracks — the leak
   * that silently consumed this host's /30 space until the allocator ran out of
   * indices and started deriving invalid addresses (the prod incident where
   * every /assign died on `ip addr add 172.16.8282.225/30`).
   *
   * The leak is structural, not a single bug: a tap is only deleted by
   * `stopVM`/`destroy`, while `snapshotVM` deliberately keeps it (a suspended VM
   * restores onto the same device), and the process reapers kill firecracker
   * without knowing which /30 it held. Anything that removed a VM without
   * walking that one path left the device behind, holding its four addresses
   * forever. Rather than add a teardown to each of those paths and hope the next
   * one remembers, this reconciles the host against the pool: a tap no VM claims
   * is by definition reclaimable.
   *
   * Three independent guards, any one of which is enough to spare a device, so a
   * bug in the ownership bookkeeping cannot cut a live guest's networking:
   *   - `keepIndices` — every warm, assigned, in-flight and SUSPENDED VM's index
   *     (suspended ones keep their tap for a cheap restore);
   *   - recently reserved — an index handed out by `nextVmIndex` within
   *     `graceMs`, i.e. a VM mid-boot that no map references yet;
   *   - NO-CARRIER — nothing holds the tap's fd, the kernel's own answer to "is
   *     a firecracker attached", which an unparseable `ip link` line answers
   *     conservatively (see {@link existingTaps}).
   * On top of that, reclaim needs two consecutive sweeps to agree.
   *
   * Bounded per call (following `reconcileOrphanDevices`) so a host that has
   * accumulated thousands drains over several sweeps instead of stalling the GC
   * timer inside a burst of netlink calls. Returns what it removed and how many
   * taps are currently in use, for the capacity gauge.
   */
  async reconcileOrphanTaps(
    keepIndices: Set<number>,
    graceMs: number,
    max = 200,
  ): Promise<{ removed: number; suspected: number; inUse: number }> {
    const now = Date.now()
    const cutoff = now - graceMs
    for (const [n, at] of [...this.reservedAt]) if (at < cutoff) this.reservedAt.delete(n)

    const taps = await this.hostTaps()
    const suspects: number[] = []
    for (const t of taps) {
      if (keepIndices.has(t.index)) continue
      if (this.reservedAt.has(t.index)) continue
      if (t.attached) continue
      suspects.push(t.index)
    }

    const suspected = new Set(suspects)
    // Drop strikes against taps that no longer look orphaned (an index reused by
    // a new VM, or a suspended entry the pool has since re-registered), so a tap
    // never carries a stale strike into a later sweep.
    for (const n of [...this.tapOrphanStrikes.keys()]) if (!suspected.has(n)) this.tapOrphanStrikes.delete(n)

    let removed = 0
    for (const n of suspects) {
      if (!this.tapOrphanStrikes.has(n)) {
        this.tapOrphanStrikes.set(n, now) // first sighting — decide next sweep
        continue
      }
      if (removed >= max) break // the rest keep their strike for the next sweep
      await this.deleteTap(`fctap${n}`)
      this.tapOrphanStrikes.delete(n)
      this.reservedAt.delete(n)
      removed++
    }
    return { removed, suspected: suspects.length, inUse: taps.length - removed }
  }

  /**
   * How close per-VM CoW stores are to overflowing, and how many already have
   * (see RootfsProvisioner.sampleCowUsage). Empty in non-dm rootfs modes.
   */
  sampleCowUsage(): Promise<CowUsage> {
    return this.rootfs.sampleCowUsage()
  }

  // TAP networking → guest reachable directly; no host-port forwarding needed.
  async forwardPort(): Promise<void> {}
  async removeForward(): Promise<void> {}

  async setBalloonTargetMB(handle: FcVmHandle, targetMB: number): Promise<void> {
    const api = new FcApi(handle.socketPath)
    await api.setBalloon(targetMB, handle.memoryMB)
  }

  /**
   * Hand all ballooned RAM back to the guest (balloon target → 0). Fire-and-forget
   * by callers: `deflate_on_oom` already returns pages under pressure, so nothing
   * user-facing depends on this landing before the next request.
   */
  async deflate(handle: FcVmHandle): Promise<void> {
    await new FcApi(handle.socketPath).balloonDeflate()
  }

  /**
   * MiB the balloon is currently targeting (0 = nothing reclaimed), or undefined
   * on a guest with no balloon statistics. Used to re-adopt a VM's balloon state
   * after an agent restart — the target lives in the guest/vmstate, not in us.
   */
  async balloonTargetMiB(handle: FcVmHandle): Promise<number | undefined> {
    const stats = await new FcApi(handle.socketPath).balloonStats()
    return stats?.targetMib
  }

  /**
   * Reclaim a running VM's free guest RAM through the virtio-balloon. The ONE
   * inflate implementation: the idle pass and the pre-snapshot path both come
   * through here, so there is a single place that decides how much to ask for
   * and how long to wait.
   *
   * Stats-guided and never blind: we read the balloon's available/free estimate
   * and target what is actually reclaimable, leaving `floorMiB` of headroom, then
   * never lower a target that is already higher (an idle VM being topped up
   * before its snapshot must not be deflated first and re-inflated).
   *
   * `maxWaitMs` bounds the wait for the driver to converge: inflation is async
   * and takes seconds for GiBs, which the snapshot path must wait out (the pause
   * follows) but a reaper tick must not. `0` sets the target and returns.
   *
   * A VM with no balloon stats (booted by an agent that never enabled them) is
   * skipped rather than blindly inflated — there is no way to ask it for RAM
   * back later without guessing how much it can spare.
   */
  async reclaimIdle(
    handle: FcVmHandle,
    opts: { floorMiB: number; maxWaitMs: number },
  ): Promise<{ reclaimedMiB: number; increasedMiB: number; statsAvailable: boolean }> {
    const api = new FcApi(handle.socketPath)
    const stats = await api.balloonStats()
    if (!stats) return { reclaimedMiB: 0, increasedMiB: 0, statsAvailable: false }

    const floorMiB = Math.max(0, opts.floorMiB)
    const want = Math.max(
      stats.targetMib,
      computeReclaimMiB({ configuredMiB: handle.memoryMB, availableMiB: stats.availableMib, floorMiB }),
    )
    // Nothing new to ask for. Without a wait budget that is the whole answer; with
    // one (the snapshot path, where the pause follows) still wait out an inflation
    // an earlier pass set, so the mem image is as empty as it can be.
    if (want <= stats.targetMib) {
      const converged = stats.actualMib + 8 >= want
      if (opts.maxWaitMs <= 0 || converged) {
        return { reclaimedMiB: stats.targetMib, increasedMiB: 0, statsAvailable: true }
      }
    } else {
      await api.balloonInflate(want)
    }

    // Poll actual→target and stop as soon as it converges OR plateaus (the
    // driver can't get more — e.g. the rest is a pinned working set), so we don't
    // burn the whole window once reclaim is effectively done.
    const deadline = Date.now() + Math.max(0, opts.maxWaitMs)
    let prev = -1
    let stagnant = 0
    while (Date.now() < deadline) {
      await Bun.sleep(this.cfg.balloonPollMs)
      const s = await api.balloonStats()
      if (!s) continue
      if (s.actualMib + 8 >= want) break // reached target
      // Plateau: <8 MiB gained since last poll. Two in a row → driver is done.
      if (s.actualMib <= prev + 8) {
        if (++stagnant >= 2) break
      } else {
        stagnant = 0
      }
      prev = s.actualMib
    }
    return {
      reclaimedMiB: want,
      increasedMiB: Math.max(0, want - stats.targetMib),
      statsAvailable: true,
    }
  }

  /**
   * Pre-snapshot reclaim: top the balloon up to the snapshot floor and wait for
   * it to land, so the mem image is mostly zeros (→ ~3x smaller mem.gz). Fully
   * best-effort — any error is logged and the snapshot proceeds.
   */
  private async reclaimBeforeSnapshot(api: FcApi, handle: FcVmHandle): Promise<void> {
    try {
      await this.reclaimIdle(handle, {
        floorMiB: this.cfg.balloonFloorMiB,
        maxWaitMs: this.cfg.balloonMaxWaitMs,
      })
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
    if (this.cfg.balloonReclaim) await this.reclaimBeforeSnapshot(api, handle)

    await api.pause()
    await api.createSnapshot(snapshotPath, memFilePath)

    // Sparsify the local mem image. reclaimBeforeSnapshot() above zeroed the
    // freed guest pages, but FC writes the WHOLE guest-RAM region as dense
    // blocks — so those zeros still occupy local NVMe even though they gzip away
    // in the durable copy. Punch the all-zero ranges out: a hole reads back as
    // zeros (exactly the reclaimed content), so restore is byte-identical.
    // Best-effort. Measured on staging: a 4.29 GiB mem file drops to ~1.28 GiB,
    // ~2-3x more suspended projects per host before the GC evicts to S3.
    await digHoles(memFilePath)

    // Free RAM: the suspended VM no longer occupies the host.
    this.killProc(handle.id)
    rmSync(handle.socketPath, { force: true })

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
      // Post-dig-holes the mem file is SPARSE, so account for allocated blocks
      // (what actually consumes NVMe) — not the logical 4 GiB — or the GC would
      // massively overcount cache pressure and evict far too aggressively.
      bytesMem: allocatedBytes(memFilePath),
      bytesState: stStat.size ?? 0,
      // In dm mode handle.rootfs is the mapper DEVICE (allocatedBytes → 0); the
      // real per-VM footprint is the CoW store file, which durableArtifact()
      // resolves to. full/reflink resolve to the image file itself, so this is
      // correct for every mode and keeps GC cache accounting honest.
      // The workspace drive is part of the same per-VM disk footprint.
      bytesRootfs:
        allocatedBytes(this.rootfs.durableArtifact(handle.rootfs).path) +
        (handle.workspaceDrive ? this.dataDrives.allocatedBytes(handle.workspaceDrive) : 0),
      vmClass: handle.vmClass,
      // The data-drive file is left in place (same "suspend keeps everything
      // but the FC process" contract as the rootfs/tap) — just carry its path
      // forward so restoreVM() can rebuild the same handle shape.
      dataDrive: handle.dataDrive,
      workspaceDrive: handle.workspaceDrive,
    }
  }

  /**
   * Recreate a restored VM's tap on the host. Split into a method (rather than
   * calling `setupTap` inline) only so a restore can be exercised somewhere other
   * than a rooted Linux host: it needs CAP_NET_ADMIN, and everything else in
   * `restoreVM` is FC control traffic plus files.
   */
  protected async setupRestoreTap(net: VmNet): Promise<void> {
    await setupTap(net, await this.uplink())
  }

  /**
   * Restore a snapshot into a fresh FC process and resume it.
   * The tap must exist again before LoadSnapshot (network device is part of
   * the vmstate). Returns a handle addressing the same guest IP as before.
   */
  async restoreVM(snap: FcSnapshot): Promise<FcVmHandle> {
    // Bounded, short id — FC's --id is capped at 64 chars, so we must NOT
    // chain the prior id across repeated restores. Advance the scan cursor with
    // a wrap so restores don't grow `vmSeq` unboundedly (the id keeps a unique
    // Date suffix regardless); the restored VM re-takes its OWN persisted tap
    // via setupTap(snap.net), so this counter only ever seeds fresh spawns.
    const seq = this.vmSeq
    this.vmSeq = (this.vmSeq + 1) % tapCapacity(this.cfg.tapCidrBase)
    const id = `fcr-${seq.toString(36)}-${Date.now().toString(36).slice(-5)}`
    const socketPath = join(this.cfg.runDir, `${id}.sock`)
    const serialLog = join(this.cfg.runDir, `${id}.serial`)

    await this.setupRestoreTap(snap.net) // recreate the exact device name
    // Ensure the rootfs backing path baked into the vmstate is live again
    // (dm-snapshot: rebuild the device from the persisted CoW store).
    await this.rootfs.prepareRestore(snap.rootfs)
    // The data drive is a plain file that suspend never touched — it should
    // simply still be there. A missing file (evicted/corrupted local state)
    // must fail loudly here rather than let LoadSnapshot bake a dangling
    // block-device path into a "successfully" restored guest.
    if (snap.dataDrive && !this.dataDrives.exists(snap.dataDrive)) {
      throw new Error(`data-drive backing file missing on restore: ${snap.dataDrive}`)
    }
    // The vmstate bakes this path in and the guest has it mounted, so
    // restoring without it would hand the guest a dangling /app/workspace.
    if (snap.workspaceDrive && !this.dataDrives.exists(snap.workspaceDrive)) {
      throw new Error(`workspace drive missing on restore: ${snap.workspaceDrive}`)
    }

    // A partial restore (bad socket / LoadSnapshot failure) must not leak the
    // FC child. Kill it + drop the fresh socket + tap, but LEAVE snap.rootfs
    // (the suspended project's persistent CoW/image) so the caller can retry or
    // cold-boot without losing the workspace.
    try {
      this.spawnFc(id, socketPath, serialLog)
      await this.waitForSocket(id, socketPath, serialLog)
      const api = new FcApi(socketPath)
      await api.loadSnapshot(snap.snapshotPath, snap.memFilePath, true)

      // The snapshot was taken with the balloon inflated (reclaimed RAM); deflate
      // now so the woken guest gets its full memory back. Best-effort: a failure
      // here just leaves the guest at the smaller footprint (deflate_on_oom still
      // hands pages back under pressure).
      //
      // Also when only idle reclaim is on: an idle-inflated VM that gets
      // snapshotted carries the balloon in its vmstate, and the pool's accounting
      // does not survive the round trip — the restored VM gets a fresh AssignedVm
      // with no `balloonedMiB`, so `touch()` no-ops and nothing would ever deflate
      // it. The guest would then run its first turn short of RAM until a full idle
      // window re-seeded the accounting. Whichever feature inflated it, restore
      // deflates it.
      if (this.cfg.balloonReclaim || this.cfg.idleReclaim) {
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
        vmClass: snap.vmClass ?? 'standard',
        dataDrive: snap.dataDrive,
        workspaceDrive: snap.workspaceDrive,
      }
    } catch (err) {
      this.killProc(id)
      try { await teardownTap(snap.net) } catch { /* ignore */ }
      try { rmSync(socketPath, { force: true }) } catch { /* ignore */ }
      throw err
    }
  }
}
