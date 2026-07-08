// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Sparsify a file by punching out its all-zero ranges (FALLOC_FL_PUNCH_HOLE, via
 * `fallocate --dig-holes`).
 *
 * Used on Firecracker snapshot mem images. `reclaimBeforeSnapshot()` inflates
 * the balloon so the guest's freed pages are zeroed right before the freeze, but
 * FC's CreateSnapshot writes the WHOLE guest-RAM region as DENSE blocks — so
 * those zeros still consume local NVMe (they only vanish when the durable copy
 * is gzipped). Digging holes deallocates every fully-zero block, so the local
 * snapshot cache holds just the non-zero working set. A hole reads back as
 * zeros — byte-identical to what was there — so a later LoadSnapshot/restore is
 * unaffected. Measured on staging: a 4.29 GiB mem file drops to ~1.28 GiB.
 *
 * Async so the multi-GiB scan never blocks the event loop during a background
 * suspend, and best-effort: returns false on any failure (tool missing, fs
 * without hole-punch support) so callers treat it as a pure optimization.
 * Linux + a punch-hole-capable fs (ext4/xfs) only.
 */

import { spawn } from 'bun'

export async function digHoles(path: string): Promise<boolean> {
  try {
    const proc = spawn(['fallocate', '--dig-holes', path], {
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code === 0) return true
    const err = await new Response(proc.stderr).text().catch(() => '')
    console.error(`[sparsify] dig-holes failed (exit ${code}) for ${path}: ${err.trim()}`)
    return false
  } catch (err: any) {
    console.error(`[sparsify] dig-holes failed for ${path}:`, err?.message ?? err)
    return false
  }
}
