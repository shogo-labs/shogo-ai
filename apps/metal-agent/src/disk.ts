// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Disk accounting for the NVMe cache. The GC loop needs two things:
 *   1. host-level free/used on the METAL_WORK filesystem (statfs) — the
 *      authoritative capacity signal that drives the high/low watermarks;
 *   2. per-file *allocated* size — for CoW/sparse rootfs images the logical
 *      size (`stat.size`) massively overstates disk use, so we account by
 *      allocated blocks (`stat.blocks * 512`) which is what actually consumes
 *      NVMe. mem/vmstate are dense, so blocks≈size for them anyway.
 */

import { statfsSync, statSync } from 'fs'

export interface DiskUsage {
  totalBytes: number
  freeBytes: number
  usedBytes: number
  usedPct: number
}

/** statfs the filesystem containing `path`. Returns zeros if unavailable. */
export function diskUsage(path: string): DiskUsage {
  try {
    const s = statfsSync(path)
    const totalBytes = s.blocks * s.bsize
    const freeBytes = s.bavail * s.bsize // space available to unprivileged users
    const usedBytes = Math.max(0, totalBytes - freeBytes)
    const usedPct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0
    return { totalBytes, freeBytes, usedBytes, usedPct }
  } catch {
    return { totalBytes: 0, freeBytes: 0, usedBytes: 0, usedPct: 0 }
  }
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
