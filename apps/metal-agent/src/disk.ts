// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Disk accounting for the NVMe cache. The GC loop needs two things:
 *   1. host-level free/used on the METAL_WORK filesystem — the capacity signal
 *      that drives the high/low watermarks. Read via statfs, falling back to
 *      `df` when statfs returns something impossible (see usageFromBlocks);
 *   2. per-file *allocated* size — for CoW/sparse rootfs images the logical
 *      size (`stat.size`) massively overstates disk use, so we account by
 *      allocated blocks (`stat.blocks * 512`) which is what actually consumes
 *      NVMe. Snapshot mem images are also sparse (see sparsify.ts: the freed,
 *      balloon-zeroed pages are hole-punched after CreateSnapshot), so the same
 *      allocated-blocks accounting is what keeps GC cache pressure honest.
 */

import { execFileSync } from 'child_process'
import { statfsSync, statSync } from 'fs'

export interface DiskUsage {
  totalBytes: number
  freeBytes: number
  usedBytes: number
  usedPct: number
}

const NO_USAGE: DiskUsage = { totalBytes: 0, freeBytes: 0, usedBytes: 0, usedPct: 0 }

/**
 * Turn raw block counts into a usage record, or undefined if they cannot be
 * describing a real filesystem.
 *
 * The guard exists because Bun's statfs truncates its counts to signed 32 bits,
 * so on a filesystem with more than 2^31 blocks — about 8 TiB at the usual 4 KiB
 * — the numbers wrap and can come back negative. A 28 TB host reported
 * `blocks: -1089122816`, which made `totalBytes` negative, `usedBytes` clamp to
 * zero and `usedPct` fall through its `totalBytes > 0` guard to 0%. Nothing
 * errored; the host simply claimed an empty disk. Since eviction only triggers
 * on `usedPct >= diskHighPct`, GC on that host could never run at all, and the
 * cache would have grown until the volume filled outright.
 *
 * So treat "implausible" as a failure rather than a number: a filesystem always
 * has a positive block size, positive capacity, and no more space available
 * than it has in total.
 */
export function usageFromBlocks(
  blocks: number,
  bavail: number,
  bsize: number,
): DiskUsage | undefined {
  if (!(bsize > 0) || !(blocks > 0) || !(bavail >= 0) || bavail > blocks) return undefined
  const totalBytes = blocks * bsize
  const freeBytes = bavail * bsize // space available to unprivileged users
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  return { totalBytes, freeBytes, usedBytes, usedPct: (usedBytes / totalBytes) * 100 }
}

/**
 * Ask `df` instead. Slower than statfs and not worth doing routinely, but it
 * reports 64-bit byte counts directly and so is right on the large volumes
 * where statfs is not.
 */
function dfUsage(path: string): DiskUsage | undefined {
  try {
    // -P for one line per filesystem, -k for 1 KiB units. Both are POSIX; the
    // GNU-only -B1 would give exact bytes but is absent on BSD/macOS, and dev
    // machines have to be able to run this too.
    const out = execFileSync('df', ['-Pk', path], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const cols = out.trim().split('\n').at(-1)?.split(/\s+/)
    if (!cols || cols.length < 4) return undefined
    return usageFromBlocks(Number(cols[1]), Number(cols[3]), 1024)
  } catch {
    return undefined
  }
}

/**
 * Free/used on the filesystem containing `path`. Returns zeros if it cannot be
 * determined — callers treat that as "no signal", not as an empty disk.
 */
export function diskUsage(path: string): DiskUsage {
  let fromStatfs: DiskUsage | undefined
  try {
    const s = statfsSync(path)
    fromStatfs = usageFromBlocks(s.blocks, s.bavail, s.bsize)
  } catch {
    fromStatfs = undefined
  }
  return fromStatfs ?? dfUsage(path) ?? NO_USAGE
}

/**
 * Actual NVMe bytes a file consumes (allocated blocks), not its logical size.
 * A reflink/sparse rootfs reports size≈8 GiB but blocks may be a few hundred
 * MiB — this returns the truthful, disk-pressure-relevant number.
 */
export function allocatedBytes(path: string): number {
  try {
    const s = statSync(path)
    // `blocks` is in 512-byte units on Linux/macOS regardless of bsize.
    if (typeof s.blocks === 'number' && s.blocks > 0) return s.blocks * 512
    return s.size
  } catch {
    return 0
  }
}

/** Logical size of a file (0 if missing). */
export function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
