// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-VM rootfs provisioning off the read-only golden image.
 *
 * The whole density story hinges on this: a full copy of the ~8 GiB golden
 * rootfs per VM is almost entirely redundant (every VM starts identical to the
 * base). The project's real divergence — its workspace, node_modules deltas,
 * logs — is typically 100s of MiB. Three strategies extract that:
 *
 *   full    — a plain full copy. Correct everywhere, ~8 GiB/VM. The pre-GC
 *             behavior.
 *   reflink — COPYFILE_FICLONE copy-on-write clone on a reflink filesystem
 *             (XFS reflink=1 / Btrfs). Only diverged blocks consume NVMe. Falls
 *             back to a full copy (with a one-time warning) where unsupported,
 *             so it is always safe to enable. Local density only — the clone is
 *             not a separable diff, so durable pushes still send the full image.
 *   dm      — host-side device-mapper snapshot: one shared read-only base
 *             (loop-mounted once) + a small sparse per-VM CoW store, exposed as
 *             a single /dev/mapper device. Densest, and the CoW store IS the
 *             separable diff (enables slim durable pushes). Requires
 *             dmsetup/losetup on the host (host-bootstrap provisions them).
 *
 * Firecracker bakes the block-device backing path into the vmstate, so the path
 * returned here MUST be re-materializable at the same string on restore:
 *   - full/reflink: a file at {runDir}/{vmId}.rootfs.ext4 (persists across
 *     suspend, so restore just reuses it);
 *   - dm: /dev/mapper/mvm-{vmId} rebuilt from the persisted CoW store before
 *     LoadSnapshot (prepareRestore).
 */

import {
  closeSync,
  constants,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  promises as fsp,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs'
import { basename, join } from 'path'
import type { MetalConfig } from './config'
import { allocatedBytes } from './disk'
import { run } from './run'

export type RootfsMode = 'full' | 'reflink' | 'dm'

/**
 * Is the shared base loop still attached to the golden image that is on disk?
 *
 * A replaced image is renamed into place, and the kernel then reports the loop's
 * backing path as `<path> (deleted)` — the exact string that kept an old image
 * in service after a new one was renamed in (SHO-549). Anything other than the
 * current path is stale; an unreadable backing path is 'unknown' and must not be
 * treated as a switch.
 */
export function baseLoopState(backingFile: string, baseRootfs: string): 'current' | 'stale' | 'unknown' {
  if (!backingFile) return 'unknown'
  return backingFile === baseRootfs ? 'current' : 'stale'
}

/** Parse a size string like "2G"/"512M"/"1048576" into bytes. */
export function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgtKMGT]?)i?[bB]?$/.exec(s.trim())
  if (!m) return parseInt(s, 10) || 0
  const n = parseFloat(m[1])
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()] ?? 1
  return Math.round(n * mult)
}

/**
 * dm-snapshot chunk size, in 512-byte sectors. 8 → 4 KiB, matching the guest
 * filesystem's block size so a single guest write never straddles two chunks.
 */
const DM_CHUNK_SECTORS = 8
const DM_CHUNK_BYTES = DM_CHUNK_SECTORS * 512

/** Bytes per exception record in the persistent store: two 64-bit chunk numbers. */
const DM_EXCEPTION_RECORD_BYTES = 16

/**
 * The smallest CoW store that a snapshot over `originBytes` can never overflow.
 *
 * A persistent exception store interleaves metadata with data: one metadata
 * chunk describes as many exceptions as it has room for 16-byte records, then
 * come those exceptions' data chunks. So covering every chunk of the origin
 * costs the origin's own size plus roughly one part in `chunk/16` for metadata
 * (about 0.4% at 4 KiB chunks), plus a header chunk.
 *
 * Rounded up to a whole chunk and given a chunk of slack, because the cost of
 * overestimating is zero — the file is sparse — and the cost of
 * underestimating is a dead VM.
 */
export function safeCowBytes(originBytes: number): number {
  const exceptionsPerMetadataChunk = DM_CHUNK_BYTES / DM_EXCEPTION_RECORD_BYTES
  const metadata = Math.ceil(originBytes / exceptionsPerMetadataChunk)
  const total = originBytes + metadata + 2 * DM_CHUNK_BYTES
  return Math.ceil(total / DM_CHUNK_BYTES) * DM_CHUNK_BYTES
}

/**
 * Resolve the configured CoW size against the size that is actually safe.
 *
 * `raisedFloor` reports that an explicit setting was overridden, so the caller
 * can say so once rather than on every VM.
 */
export function cowTargetBytes(
  originBytes: number,
  configured: string,
): { bytes: number; raisedFloor: boolean } {
  const safe = safeCowBytes(originBytes)
  const want = parseSize(configured)
  if (want > safe) return { bytes: want, raisedFloor: false }
  return { bytes: safe, raisedFloor: want > 0 }
}

/**
 * Parse `dmsetup status` into a fleet view of CoW headroom.
 *
 * Split out from the call so the shapes dm actually emits — a healthy
 * fraction, and the bare words it prints once a store is unusable — are
 * pinned by tests rather than discovered during an incident.
 */
export function parseCowStatus(out: string, nearLimitPct = 80): CowUsage {
  const usage: CowUsage = { measured: 0, invalid: 0, nearLimit: 0, maxUsedPct: 0 }
  for (const line of out.split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const name = line.slice(0, idx)
    const rest = line.slice(idx + 1)
    if (!name.startsWith('mvm-') || !rest.trim()) continue
    usage.measured++
    if (/\b(Invalid|Overflow|Merge failed)\b/.test(rest)) {
      usage.invalid++
      usage.maxUsedPct = 100
      continue
    }
    const m = /\bsnapshot\s+(\d+)\/(\d+)\b/.exec(rest)
    if (!m) continue
    const total = Number(m[2])
    if (!total) continue
    const pct = (Number(m[1]) / total) * 100
    if (pct > usage.maxUsedPct) usage.maxUsedPct = pct
    if (pct >= nearLimitPct) usage.nearLimit++
  }
  return usage
}

/**
 * Extend a sparse CoW store to `targetBytes`, creating it if absent.
 *
 * Only ever grows. Appending to a persistent exception store is safe — the
 * existing areas keep their offsets and the new space is simply available for
 * more — but shrinking would strand allocated exceptions past the end of the
 * device, so a store that is already larger is left alone.
 */
export function ensureCowSize(path: string, targetBytes: number): 'created' | 'grown' | 'unchanged' {
  const before = existsSync(path) ? statSync(path).size : -1
  if (before >= targetBytes) return 'unchanged'
  const fd = openSync(path, before < 0 ? 'w' : 'r+')
  try {
    ftruncateSync(fd, targetBytes)
  } finally {
    closeSync(fd)
  }
  return before < 0 ? 'created' : 'grown'
}

/** Fleet-wide view of how close per-VM CoW stores are to their ceiling. */
export interface CowUsage {
  /** Mapped `mvm-*` devices whose status could be read. */
  measured: number
  /** Devices the kernel has already invalidated. Each one is a broken VM. */
  invalid: number
  /** Devices at or above the near-limit threshold. */
  nearLimit: number
  /** Utilisation of the fullest store, 0–100. */
  maxUsedPct: number
}

/** The one host command runner this module needs (injectable for tests). */
export type RootfsExec = (cmd: string, args: string[]) => Promise<string>

export class RootfsProvisioner {
  readonly mode: RootfsMode
  private warnedCowFloor = false
  private warnedReflinkFallback = false
  private baseLoop: string | null = null // shared RO loop for the golden base (dm mode)
  private baseLoopPending: Promise<string> | null = null
  /**
   * vmId → read-only loop of a base OTHER than `cfg.baseRootfs` (dm mode). Only
   * the boot probe creates these: it snapshots the staged image the way live
   * will snapshot it once the rename lands, so the probe sees the live boot path
   * instead of a full copy of it (SHO-563). Detached with the VM.
   */
  private probeBaseLoops = new Map<string, string>()

  constructor(
    private cfg: MetalConfig,
    private exec: RootfsExec = run,
  ) {
    this.mode = cfg.rootfsCow
    if (this.mode === 'dm') mkdirSync(cfg.dmCowDir, { recursive: true })
  }

  /**
   * Create a fresh writable rootfs for a new VM off `baseRootfsOverride`
   * (defaults to the standard `cfg.baseRootfs` — e.g. a docker-class VM's
   * layered image). Returns the FC backing path.
   *
   * dm mode snapshots only the golden base. Two other kinds of base exist:
   *   - `dmBase`: a file that WILL become the golden base — the staged image the
   *     boot probe boots before activation. It is snapshotted exactly the way
   *     live will snapshot it after the rename (its own read-only loop + a CoW
   *     store), because booting a full copy proves only that a copy boots, and
   *     that is not the path production takes (SHO-563).
   *   - anything else (the docker-class image): copied to its own file so it
   *     never shares the standard snapshot device.
   */
  provision(vmId: string, baseRootfsOverride?: string, opts: { dmBase?: boolean } = {}): Promise<string> {
    if (this.mode === 'dm' && baseRootfsOverride) {
      if (opts.dmBase) return this.provisionDm(vmId, baseRootfsOverride)
      if (baseRootfsOverride !== this.cfg.baseRootfs) {
        return this.provisionCopy(vmId, false, baseRootfsOverride)
      }
    }
    switch (this.mode) {
      case 'dm':
        return this.provisionDm(vmId)
      case 'reflink':
        return this.provisionCopy(vmId, true, baseRootfsOverride)
      default:
        return this.provisionCopy(vmId, false, baseRootfsOverride)
    }
  }

  /** Ensure a suspended VM's rootfs backing path is live before LoadSnapshot. */
  async prepareRestore(rootfsPath: string): Promise<void> {
    if (this.isDmPath(rootfsPath)) {
      await this.attachDm(this.vmIdFromDmPath(rootfsPath))
      return
    }
    if (!existsSync(rootfsPath)) {
      throw new Error(`rootfs backing file missing on restore: ${rootfsPath}`)
    }
  }

  /**
   * The artifact to push to the durable store for this rootfs, and its mode:
   *   full/reflink → the image file itself ('full');
   *   dm           → the small per-VM CoW store file ('diff'), NOT the mapper
   *                  device (streaming the device would read the whole 8 GiB).
   * The 'diff' restores against the host-local golden base, which is guaranteed
   * present on any host eligible to restore (restore requires a matching
   * rootfsIdentity == that base), so no base download is needed.
   */
  durableArtifact(rootfsPath: string): { path: string; mode: 'full' | 'diff' } {
    if (this.isDmPath(rootfsPath)) {
      return { path: this.cowFile(this.vmIdFromDmPath(rootfsPath)), mode: 'diff' }
    }
    return { path: rootfsPath, mode: 'full' }
  }

  /** Where a pulled durable rootfs artifact must land for this backing path. */
  restoreArtifactPath(rootfsPath: string): string {
    if (this.isDmPath(rootfsPath)) return this.cowFile(this.vmIdFromDmPath(rootfsPath))
    return rootfsPath
  }

  /**
   * dm mode: true if this VM's mapper device is currently live. A CoW store file
   * is a genuine orphan ONLY when its device is gone — while the device is
   * mapped the VM is live (running, suspended-in-place, or claimed mid-assign)
   * and the CoW backing file must never be reclaimed. This is the airtight
   * invariant the GC uses instead of relying solely on in-memory map bookkeeping
   * (which has a gap during the claim -> /pool/assign window).
   */
  deviceMapped(vmId: string): Promise<boolean> {
    return this.mode === 'dm' ? this.dmExists(vmId) : Promise.resolve(false)
  }

  /**
   * The block device / image to mount when reading a STOPPED VM's disk from
   * the host. dm: the mapper device (re-attached if it was dropped); file
   * modes: the image itself, which needs a loop mount.
   */
  async readOnlySource(rootfsPath: string): Promise<{ device: string; loop: boolean }> {
    if (this.isDmPath(rootfsPath)) {
      await this.attachDm(this.vmIdFromDmPath(rootfsPath))
      return { device: rootfsPath, loop: false }
    }
    if (!existsSync(rootfsPath)) throw new Error(`rootfs missing: ${rootfsPath}`)
    return { device: rootfsPath, loop: true }
  }

  /**
   * Keep a dead VM's disk instead of releasing it, moved under
   * `<dir>/quarantine/` where neither the GC's top-level sweeps nor
   * reconcileOrphanDevices look. dm: the device is removed and the CoW store
   * moved; it is only readable against the golden base it was taken from (the
   * caller records that identity). Returns the kept path, or null on failure.
   */
  async quarantine(rootfsPath: string, label: string): Promise<string | null> {
    const safe = label.replace(/[^A-Za-z0-9._-]/g, '_')
    try {
      if (this.isDmPath(rootfsPath)) {
        const vmId = this.vmIdFromDmPath(rootfsPath)
        await this.detachDm(vmId)
        const dir = join(this.cfg.dmCowDir, 'quarantine')
        mkdirSync(dir, { recursive: true })
        const dest = join(dir, `${safe}.cow`)
        renameSync(this.cowFile(vmId), dest)
        return dest
      }
      const dir = join(this.cfg.runDir, 'quarantine')
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, `${safe}.rootfs.ext4`)
      renameSync(rootfsPath, dest)
      return dest
    } catch (err: any) {
      console.error(`[rootfs] could not quarantine ${rootfsPath}:`, err?.message ?? err)
      return null
    }
  }

  /** Tear down per-VM rootfs resources (device/loop/cow or the copy). */
  async release(rootfsPath: string): Promise<void> {
    if (this.isDmPath(rootfsPath)) {
      const vmId = this.vmIdFromDmPath(rootfsPath)
      const removed = await this.detachDm(vmId)
      await this.detachProbeBaseLoop(vmId)
      // Only drop the CoW backing file once its device is ACTUALLY gone. Deleting
      // it while the device is still mapped (a failed "busy" remove) is exactly
      // what orphaned ~12k devices on staging AND defeated the GC's CoW sweep,
      // which skips any file whose device is still mapped. If the remove failed,
      // leave the file so reconcileOrphanDevices() can retry both later.
      if (removed) rmSync(this.cowFile(vmId), { force: true })
      return
    }
    rmSync(rootfsPath, { force: true })
  }

  /**
   * Reclaim dm-snapshot devices (+ their loops + CoW files) that belong to no VM
   * the pool still tracks — the catch-up net for teardown races that leaked
   * ~12k devices / ~13k loops on staging. Two failure modes converge here:
   *   - detachDm used to delete the CoW while `dmsetup remove` failed "busy",
   *     orphaning the device; and
   *   - the GC's CoW-file sweep skips any file whose device is still mapped, so a
   *     leaked device pinned its CoW forever.
   * This enumerates MAPPED devices and drops the unowned ones. Guards keep it
   * safe: dm mode only; never touch a kept vmId, an in-use device (Open count>0,
   * i.e. a VM booting/restoring/live), or one whose CoW was written within
   * `graceMs` (an in-flight boot). Bounded by `max` per call so a big backlog
   * drains over several GC sweeps instead of stalling the timer.
   */
  async reconcileOrphanDevices(keepVmIds: Set<string>, graceMs: number, max = 200): Promise<number> {
    if (this.mode !== 'dm') return 0
    let names: string[] = []
    try {
      names = (await this.exec('dmsetup', ['ls']))
        .split('\n')
        .map((l) => l.split(/\s+/)[0])
        .filter((n) => n.startsWith('mvm-'))
    } catch {
      return 0 // dmsetup unavailable / no devices
    }
    const cutoff = Date.now() - graceMs
    let removed = 0
    for (const name of names) {
      if (removed >= max) break
      const vmId = name.slice('mvm-'.length)
      if (keepVmIds.has(vmId)) continue
      if ((await this.deviceOpenCount(name)) > 0) continue // a VM is using it right now
      const cow = this.cowFile(vmId)
      try {
        // A present-but-fresh CoW means an in-flight boot; a missing CoW means a
        // definitively dead orphan (unrestorable) — reap it.
        if (existsSync(cow) && statSync(cow).mtimeMs > cutoff) continue
      } catch {
        /* stat failed → treat as reapable */
      }
      try {
        await this.exec('dmsetup', ['remove', '--retry', name])
      } catch {
        continue // still busy — a later sweep retries
      }
      await this.detachCowLoops(cow)
      try {
        rmSync(cow, { force: true })
      } catch {
        /* ignore */
      }
      removed++
    }
    // Belt-and-suspenders: detach loop devices still bound to already-deleted CoW
    // files (the old buggy path deleted the file but leaked the loop).
    await this.detachDeletedCowLoops(max)
    return removed
  }

  /** Open count of a mapper device (0 when nothing has it open, or on error). */
  private async deviceOpenCount(dmName: string): Promise<number> {
    try {
      const m = /Open count:\s*(\d+)/.exec(await this.exec('dmsetup', ['info', dmName]))
      return m ? parseInt(m[1], 10) : 0
    } catch {
      return 0
    }
  }

  /** Detach loop devices whose backing CoW file was already deleted (orphans). */
  private async detachDeletedCowLoops(max: number): Promise<number> {
    let detached = 0
    let out = ''
    try {
      out = await this.exec('losetup', ['-a'])
    } catch {
      return 0
    }
    for (const line of out.split('\n')) {
      if (detached >= max) break
      if (!line.includes(this.cfg.dmCowDir) || !line.includes('(deleted)')) continue
      const dev = line.split(':')[0]?.trim()
      if (!dev) continue
      try {
        await this.exec('losetup', ['-d', dev])
        detached++
      } catch {
        /* still referenced by a live dm device — leave it */
      }
    }
    return detached
  }

  // --- copy / reflink ------------------------------------------------------

  private async provisionCopy(
    vmId: string,
    reflink: boolean,
    baseRootfsOverride?: string,
  ): Promise<string> {
    const base = baseRootfsOverride || this.cfg.baseRootfs
    const dst = join(this.cfg.runDir, `${vmId}.rootfs.ext4`)
    if (reflink) {
      // FICLONE (not FICLONE_FORCE) attempts a reflink and transparently falls
      // back to a full copy on a non-reflink fs — always correct, just denser
      // where the fs supports it.
      await fsp.copyFile(base, dst, constants.COPYFILE_FICLONE)
      this.detectReflinkFallback(dst)
    } else {
      await fsp.copyFile(base, dst)
    }
    return dst
  }

  private detectReflinkFallback(dst: string): void {
    if (this.warnedReflinkFallback) return
    try {
      const logical = statSync(dst).size
      const allocated = allocatedBytes(dst)
      // A real reflink shares blocks → allocated is a small fraction of logical.
      if (logical > 0 && allocated >= logical * 0.9) {
        this.warnedReflinkFallback = true
        console.warn(
          `[rootfs] METAL_ROOTFS_COW=reflink but the copy consumed ${(allocated / 1e9).toFixed(2)}GB ` +
            `(~full size) — ${this.cfg.runDir} is likely NOT on a reflink filesystem (XFS reflink=1 / Btrfs). ` +
            `Density will be poor; see scripts/metal-agent/host-bootstrap.sh.`,
        )
      }
    } catch {
      /* best-effort diagnostic */
    }
  }

  // --- dm-snapshot ---------------------------------------------------------

  private dmName(vmId: string): string {
    return `mvm-${vmId}`
  }
  private dmPath(vmId: string): string {
    return `/dev/mapper/${this.dmName(vmId)}`
  }
  private isDmPath(p: string): boolean {
    return p.startsWith('/dev/mapper/mvm-')
  }
  private vmIdFromDmPath(p: string): string {
    return basename(p).replace(/^mvm-/, '')
  }
  private cowFile(vmId: string): string {
    return join(this.cfg.dmCowDir, `${vmId}.cow`)
  }

  /**
   * Loop-mount the golden base read-only, once, shared by all VMs.
   *
   * The shared loop is created at most once even under parallel boots: the
   * in-flight promise is cached, so the second boot awaits the first instead of
   * running its own `losetup --find --show` (which would leak a loop device per
   * concurrent boot — the same class of leak as the restore path's).
   *
   * The cached device is re-examined rather than trusted. A golden image is
   * replaced by rename — `activateStagedImages`, or an operator rebuild straight
   * over `METAL_ROOTFS` — and a loop attached before that rename keeps pointing
   * at the old inode for the life of the process: the host then snapshots the
   * *previous* image for every new VM while the file on disk is the new one.
   * That is how a fixed image stayed inert on staging (SHO-549): the replacement
   * carried /usr/local/bin/fc-init, the loop still bound the image that did not,
   * and every cold boot kept panicking with
   * `Requested init /usr/local/bin/fc-init failed (error -2)`.
   */
  private ensureBaseLoop(): Promise<string> {
    this.baseLoopPending ??= this.resolveBaseLoop().finally(() => {
      this.baseLoopPending = null
    })
    return this.baseLoopPending
  }

  private async resolveBaseLoop(): Promise<string> {
    if (this.baseLoop) {
      const state = baseLoopState(this.baseLoopBackingFile(this.baseLoop), this.cfg.baseRootfs)
      // 'unknown' is a lost sysfs read, not evidence of a switch — keep the old
      // device-node test for that case only.
      if (state === 'current' || (state === 'unknown' && existsSync(this.baseLoop))) return this.baseLoop
      await this.detachBaseLoop()
    }
    const dev = await this.exec('losetup', ['--find', '--show', '--read-only', this.cfg.baseRootfs])
    this.baseLoop = dev
    return dev
  }

  /** The path a loop device is attached to, as the kernel reports it. */
  private baseLoopBackingFile(loop: string): string {
    try {
      return readFileSync(`/sys/class/block/${basename(loop)}/loop/backing_file`, 'utf8').trim()
    } catch {
      return ''
    }
  }

  /**
   * Drop our shared base loop. A loop that a live dm-snapshot still uses as its
   * origin refuses to detach (EBUSY) and that is fine: those VMs keep the image
   * they booted, the next attach simply picks a fresh device for the new one.
   */
  private async detachBaseLoop(): Promise<void> {
    const loop = this.baseLoop
    this.baseLoop = null
    if (!loop) return
    try {
      await this.exec('losetup', ['-d', loop])
    } catch {
      /* still an origin for a live snapshot — leave it to the GC */
    }
  }

  private baseSectors(base: string = this.cfg.baseRootfs): number {
    return Math.floor(statSync(base).size / 512)
  }

  /**
   * Target size for a per-VM CoW store. Sparse, so this is a ceiling on what
   * the VM may diverge rather than an allocation.
   *
   * An operator's explicit `METAL_DM_COW_SIZE` acts as a floor and is raised to
   * the derived size when it is smaller, because a snapshot that runs out of
   * exceptions does not degrade — the kernel invalidates it and every write on
   * that device fails from then on.
   */
  private cowTargetBytes(base: string = this.cfg.baseRootfs): number {
    const { bytes, raisedFloor } = cowTargetBytes(
      statSync(base).size,
      this.cfg.dmCowSize,
    )
    if (raisedFloor && !this.warnedCowFloor) {
      this.warnedCowFloor = true
      console.warn(
        `[rootfs] METAL_DM_COW_SIZE=${this.cfg.dmCowSize} is smaller than the ` +
          `${(bytes / 1024 ** 3).toFixed(1)} GiB needed to cover the golden image; using the larger ` +
          `figure. A CoW that fills does not slow a VM down, it kills it.`,
      )
    }
    return bytes
  }

  private async provisionDm(vmId: string, base: string = this.cfg.baseRootfs): Promise<string> {
    const cow = this.cowFile(vmId)
    // Sparse CoW store: only written (diverged) blocks consume NVMe.
    ensureCowSize(cow, this.cowTargetBytes(base))
    await this.attachDm(vmId, true, base)
    return this.dmPath(vmId)
  }

  /**
   * (Re)create the dm-snapshot device for a VM from base + its CoW store.
   *
   * Idempotent on restore: if the device is already mapped (the common case —
   * suspendVM leaves the rootfs in place, so the device persists across a
   * suspend), REUSE it. It already maps base + this exact CoW store, which holds
   * all of the VM's divergence. The previous "always dmsetup remove + recreate"
   * was doubly harmful:
   *   1. right after the FC process is SIGKILL'd on suspend the device can still
   *      be held briefly → `dmsetup remove` fails "Device or resource busy",
   *      which surfaced as a failed second resume; and
   *   2. every resume ran `losetup --find --show` for a NEW loop without
   *      detaching the old one, leaking a loop device per suspend/resume cycle
   *      until the host runs out of /dev/loop* on a long-lived node.
   */
  private async attachDm(vmId: string, fresh = false, basePath: string = this.cfg.baseRootfs): Promise<void> {
    const base = basePath === this.cfg.baseRootfs ? await this.ensureBaseLoop() : await this.ensureProbeBaseLoop(vmId, basePath)
    const cow = this.cowFile(vmId)
    if (!existsSync(cow)) throw new Error(`dm CoW store missing for ${vmId}: ${cow}`)
    // Already mapped → reuse (no remove/recreate, no new loop). See above.
    if (await this.dmExists(vmId)) return
    // Fresh mapping: clear any stale loop still bound to this CoW first so we
    // never accumulate orphaned loop devices across restore cycles.
    await this.detachCowLoops(cow)
    this.growCow(vmId, cow, basePath)
    const cowLoop = await this.exec('losetup', ['--find', '--show', cow])
    const sectors = this.baseSectors(basePath)
    // snapshot target: <origin> <cow> <persistent> <chunksize(sectors)>
    // 'P' = persistent (survives device removal so the diff is restorable).
    const table = `0 ${sectors} snapshot ${base} ${cowLoop} P ${DM_CHUNK_SECTORS}`
    await this.exec('dmsetup', ['create', this.dmName(vmId), '--table', table])
    void fresh
  }

  /**
   * The read-only loop for a base other than the live golden image: the staged
   * image a boot probe is vetting. One per probe VM, so two parallel probes never
   * fight over one loop, and detached with the VM (see `detachProbeBaseLoop`).
   */
  private async ensureProbeBaseLoop(vmId: string, base: string): Promise<string> {
    const existing = this.probeBaseLoops.get(vmId)
    if (existing) {
      const state = baseLoopState(this.baseLoopBackingFile(existing), base)
      if (state === 'current' || (state === 'unknown' && existsSync(existing))) return existing
      await this.detachProbeBaseLoop(vmId)
    }
    const dev = await this.exec('losetup', ['--find', '--show', '--read-only', base])
    this.probeBaseLoops.set(vmId, dev)
    return dev
  }

  /**
   * Detach a probe VM's own base loop. A loop a live snapshot still uses as its
   * origin refuses (EBUSY) and that is fine: `release` removes the device first.
   */
  private async detachProbeBaseLoop(vmId: string): Promise<void> {
    const loop = this.probeBaseLoops.get(vmId)
    if (!loop) return
    this.probeBaseLoops.delete(vmId)
    try {
      await this.exec('losetup', ['-d', loop])
    } catch {
      /* still an origin for a live snapshot — the GC catches it */
    }
  }

  /**
   * Extend an undersized CoW store before it is mapped.
   *
   * Every VM provisioned under the old fixed 2 GiB is carrying a store it can
   * outgrow, and those VMs outlive a deploy: suspend keeps the CoW and resume
   * maps it again. Growing here means each one picks up the headroom the next
   * time it is attached, rather than only new VMs being safe.
   *
   * Only ever grows. Appending to a persistent exception store is safe — the
   * existing areas keep their offsets and the extra space is simply available
   * for new ones — but it must happen while the device is unmapped, which is
   * exactly where this sits. Shrinking would strand allocated exceptions past
   * the end of the device, so a store that is already larger is left alone.
   */
  private growCow(vmId: string, cow: string, base: string = this.cfg.baseRootfs): void {
    try {
      const before = statSync(cow).size
      const target = this.cowTargetBytes(base)
      if (ensureCowSize(cow, target) === 'grown') {
        console.log(
          `[rootfs] grew CoW store for ${vmId} from ${(before / 1024 ** 3).toFixed(1)} to ` +
            `${(target / 1024 ** 3).toFixed(1)} GiB (sparse)`,
        )
      }
    } catch (err: any) {
      // Not fatal: the VM still attaches at its old size, which is what it had
      // before this existed. It is just still exposed to overflow.
      console.warn(`[rootfs] could not grow CoW store for ${vmId}:`, err?.message ?? err)
    }
  }

  /**
   * Remove a VM's mapper device. Returns whether it is actually gone afterwards.
   * `--retry`: right after the VM's FC process is SIGKILL'd the device can be
   * briefly held ("Device or resource busy"); retrying instead of giving up is
   * what stops us orphaning the device (and then deleting its CoW), the leak that
   * piled up ~12k devices on staging. The boolean lets release() keep the CoW
   * when removal genuinely failed so a later sweep can retry both.
   */
  private async detachDm(vmId: string): Promise<boolean> {
    let gone = true
    try {
      if (await this.dmExists(vmId)) await this.exec('dmsetup', ['remove', '--retry', this.dmName(vmId)])
    } catch {
      gone = !(await this.dmExists(vmId))
    }
    await this.detachCowLoops(this.cowFile(vmId))
    return gone
  }

  /** Detach any loop devices still bound to a CoW store file (best-effort). */
  private async detachCowLoops(cow: string): Promise<void> {
    try {
      const out = await this.exec('losetup', ['-j', cow])
      for (const line of out.split('\n')) {
        const dev = line.split(':')[0]?.trim()
        if (dev) await this.exec('losetup', ['-d', dev])
      }
    } catch {
      /* best-effort */
    }
  }

  /**
   * Utilisation of every mapped CoW store, from one `dmsetup status` call.
   *
   * A snapshot that fills is not a slow VM, it is a dead one: the kernel logs
   * "Invalidating snapshot: Unable to allocate exception" and every write on
   * the device fails afterwards. Nothing in the agent notices, because the
   * guest is still up and still answering — it just cannot write. So the fleet
   * needs both halves: how close the worst store is to its ceiling, and how
   * many have already gone over.
   *
   * dm reports a snapshot's status as `<allocated>/<total> <metadata>`, or a
   * bare `Invalid` / `Overflow` / `Merge failed` once it is unusable.
   */
  async sampleCowUsage(nearLimitPct = 80): Promise<CowUsage> {
    if (this.mode !== 'dm') return { measured: 0, invalid: 0, nearLimit: 0, maxUsedPct: 0 }
    try {
      return parseCowStatus(await this.exec('dmsetup', ['status']), nearLimitPct)
    } catch {
      return { measured: 0, invalid: 0, nearLimit: 0, maxUsedPct: 0 }
    }
  }

  private async dmExists(vmId: string): Promise<boolean> {
    try {
      await this.exec('dmsetup', ['info', this.dmName(vmId)])
      return true
    } catch {
      return false
    }
  }
}
