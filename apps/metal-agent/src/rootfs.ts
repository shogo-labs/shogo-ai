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
 *   full    — copyFileSync. Correct everywhere, ~8 GiB/VM. The pre-GC behavior.
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

import { constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { basename, join } from 'path'
import type { MetalConfig } from './config'
import { allocatedBytes } from './disk'

export type RootfsMode = 'full' | 'reflink' | 'dm'

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
}

/** Parse a size string like "2G"/"512M"/"1048576" into bytes. */
export function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgtKMGT]?)i?[bB]?$/.exec(s.trim())
  if (!m) return parseInt(s, 10) || 0
  const n = parseFloat(m[1])
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()] ?? 1
  return Math.round(n * mult)
}

export class RootfsProvisioner {
  readonly mode: RootfsMode
  private warnedReflinkFallback = false
  private baseLoop: string | null = null // shared RO loop for the golden base (dm mode)

  constructor(private cfg: MetalConfig) {
    this.mode = cfg.rootfsCow
    if (this.mode === 'dm') mkdirSync(cfg.dmCowDir, { recursive: true })
  }

  /** Create a fresh writable rootfs for a new VM. Returns the FC backing path. */
  provision(vmId: string): string {
    switch (this.mode) {
      case 'dm':
        return this.provisionDm(vmId)
      case 'reflink':
        return this.provisionCopy(vmId, true)
      default:
        return this.provisionCopy(vmId, false)
    }
  }

  /** Ensure a suspended VM's rootfs backing path is live before LoadSnapshot. */
  prepareRestore(rootfsPath: string): void {
    if (this.isDmPath(rootfsPath)) {
      this.attachDm(this.vmIdFromDmPath(rootfsPath))
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
  deviceMapped(vmId: string): boolean {
    return this.mode === 'dm' && this.dmExists(vmId)
  }

  /** Tear down per-VM rootfs resources (device/loop/cow or the copy). */
  release(rootfsPath: string): void {
    if (this.isDmPath(rootfsPath)) {
      const vmId = this.vmIdFromDmPath(rootfsPath)
      const removed = this.detachDm(vmId)
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
  reconcileOrphanDevices(keepVmIds: Set<string>, graceMs: number, max = 200): number {
    if (this.mode !== 'dm') return 0
    let names: string[] = []
    try {
      names = sh('dmsetup', ['ls'])
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
      if (this.deviceOpenCount(name) > 0) continue // a VM is using it right now
      const cow = this.cowFile(vmId)
      try {
        // A present-but-fresh CoW means an in-flight boot; a missing CoW means a
        // definitively dead orphan (unrestorable) — reap it.
        if (existsSync(cow) && statSync(cow).mtimeMs > cutoff) continue
      } catch {
        /* stat failed → treat as reapable */
      }
      try {
        execFileSync('dmsetup', ['remove', '--retry', name])
      } catch {
        continue // still busy — a later sweep retries
      }
      this.detachCowLoops(cow)
      try {
        rmSync(cow, { force: true })
      } catch {
        /* ignore */
      }
      removed++
    }
    // Belt-and-suspenders: detach loop devices still bound to already-deleted CoW
    // files (the old buggy path deleted the file but leaked the loop).
    this.detachDeletedCowLoops(max)
    return removed
  }

  /** Open count of a mapper device (0 when nothing has it open, or on error). */
  private deviceOpenCount(dmName: string): number {
    try {
      const m = /Open count:\s*(\d+)/.exec(sh('dmsetup', ['info', dmName]))
      return m ? parseInt(m[1], 10) : 0
    } catch {
      return 0
    }
  }

  /** Detach loop devices whose backing CoW file was already deleted (orphans). */
  private detachDeletedCowLoops(max: number): number {
    let detached = 0
    let out = ''
    try {
      out = sh('losetup', ['-a'])
    } catch {
      return 0
    }
    for (const line of out.split('\n')) {
      if (detached >= max) break
      if (!line.includes(this.cfg.dmCowDir) || !line.includes('(deleted)')) continue
      const dev = line.split(':')[0]?.trim()
      if (!dev) continue
      try {
        execFileSync('losetup', ['-d', dev])
        detached++
      } catch {
        /* still referenced by a live dm device — leave it */
      }
    }
    return detached
  }

  // --- copy / reflink ------------------------------------------------------

  private provisionCopy(vmId: string, reflink: boolean): string {
    const dst = join(this.cfg.runDir, `${vmId}.rootfs.ext4`)
    if (reflink) {
      // FICLONE (not FICLONE_FORCE) attempts a reflink and transparently falls
      // back to a full copy on a non-reflink fs — always correct, just denser
      // where the fs supports it.
      copyFileSync(this.cfg.baseRootfs, dst, constants.COPYFILE_FICLONE)
      this.detectReflinkFallback(dst)
    } else {
      copyFileSync(this.cfg.baseRootfs, dst)
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

  /** Loop-mount the golden base read-only, once, shared by all VMs. */
  private ensureBaseLoop(): string {
    if (this.baseLoop && existsSync(this.baseLoop)) return this.baseLoop
    this.baseLoop = sh('losetup', ['--find', '--show', '--read-only', this.cfg.baseRootfs])
    return this.baseLoop
  }

  private baseSectors(): number {
    return Math.floor(statSync(this.cfg.baseRootfs).size / 512)
  }

  private provisionDm(vmId: string): string {
    const cow = this.cowFile(vmId)
    // Sparse CoW store: only written (diverged) blocks consume NVMe.
    const bytes = parseSize(this.cfg.dmCowSize)
    execFileSync('truncate', ['-s', String(bytes), cow])
    this.attachDm(vmId, true)
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
  private attachDm(vmId: string, fresh = false): void {
    const base = this.ensureBaseLoop()
    const cow = this.cowFile(vmId)
    if (!existsSync(cow)) throw new Error(`dm CoW store missing for ${vmId}: ${cow}`)
    // Already mapped → reuse (no remove/recreate, no new loop). See above.
    if (this.dmExists(vmId)) return
    // Fresh mapping: clear any stale loop still bound to this CoW first so we
    // never accumulate orphaned loop devices across restore cycles.
    this.detachCowLoops(cow)
    const cowLoop = sh('losetup', ['--find', '--show', cow])
    const sectors = this.baseSectors()
    // snapshot target: <origin> <cow> <persistent> <chunksize(sectors)>
    // 'P' = persistent (survives device removal so the diff is restorable); 8 = 4KiB chunks.
    const table = `0 ${sectors} snapshot ${base} ${cowLoop} P 8`
    execFileSync('dmsetup', ['create', this.dmName(vmId), '--table', table])
    void fresh
  }

  /**
   * Remove a VM's mapper device. Returns whether it is actually gone afterwards.
   * `--retry`: right after the VM's FC process is SIGKILL'd the device can be
   * briefly held ("Device or resource busy"); retrying instead of giving up is
   * what stops us orphaning the device (and then deleting its CoW), the leak that
   * piled up ~12k devices on staging. The boolean lets release() keep the CoW
   * when removal genuinely failed so a later sweep can retry both.
   */
  private detachDm(vmId: string): boolean {
    let gone = true
    try {
      if (this.dmExists(vmId)) execFileSync('dmsetup', ['remove', '--retry', this.dmName(vmId)])
    } catch {
      gone = !this.dmExists(vmId)
    }
    this.detachCowLoops(this.cowFile(vmId))
    return gone
  }

  /** Detach any loop devices still bound to a CoW store file (best-effort). */
  private detachCowLoops(cow: string): void {
    try {
      const out = sh('losetup', ['-j', cow])
      for (const line of out.split('\n')) {
        const dev = line.split(':')[0]?.trim()
        if (dev) execFileSync('losetup', ['-d', dev])
      }
    } catch {
      /* best-effort */
    }
  }

  private dmExists(vmId: string): boolean {
    try {
      execFileSync('dmsetup', ['info', this.dmName(vmId)], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
}
