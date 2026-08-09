// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { execFileSync } from 'child_process'
import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'os'

import { diskUsage, usageFromBlocks } from './disk'

describe('usageFromBlocks', () => {
  const KIB4 = 4096

  test('computes used/free/pct for an ordinary filesystem', () => {
    // 8 GiB total, 2 GiB available to unprivileged users.
    const u = usageFromBlocks(2 * 1024 * 1024, 512 * 1024, KIB4)
    expect(u).toBeDefined()
    expect(u!.totalBytes).toBe(8 * 1024 ** 3)
    expect(u!.freeBytes).toBe(2 * 1024 ** 3)
    expect(u!.usedBytes).toBe(6 * 1024 ** 3)
    expect(u!.usedPct).toBeCloseTo(75, 6)
  })

  test('rejects the signed-32-bit wrap that made a 28 TB host report 0% used', () => {
    // Verbatim from Bun's statfs on latitude-dal-1, whose /opt/fc-spike holds
    // 7,500,811,776 blocks — past 2^32, so the count came back negative. The old
    // code turned this into totalBytes < 0, usedBytes clamped to 0, and a
    // usedPct of 0 that silently disabled GC eviction on the largest host.
    expect(usageFromBlocks(-1089122816, 1228741198, KIB4)).toBeUndefined()
  })

  test('rejects readings that no real filesystem can produce', () => {
    expect(usageFromBlocks(0, 0, KIB4)).toBeUndefined() // no capacity
    expect(usageFromBlocks(1000, 100, 0)).toBeUndefined() // no block size
    expect(usageFromBlocks(1000, -1, KIB4)).toBeUndefined() // negative availability
    expect(usageFromBlocks(1000, 2000, KIB4)).toBeUndefined() // more free than exists
  })

  test('accepts a filesystem that is completely full or completely empty', () => {
    // The bounds are inclusive: 100% and 0% are both legitimate readings, and
    // rejecting either would hide precisely the state GC needs to act on.
    expect(usageFromBlocks(1000, 0, KIB4)!.usedPct).toBe(100)
    expect(usageFromBlocks(1000, 1000, KIB4)!.usedPct).toBe(0)
  })

  test('handles volumes beyond 2^32 blocks once the counts are not truncated', () => {
    // The real dal-1 numbers, as the OS reports them: ~30.7 TB, ~26% used.
    const u = usageFromBlocks(7500811776, 5523708494, KIB4)
    expect(u).toBeDefined()
    expect(u!.totalBytes).toBeGreaterThan(30e12)
    expect(u!.usedPct).toBeCloseTo(26.36, 1)
  })
})

describe('diskUsage', () => {
  test('agrees with df on this machine', () => {
    // The point of the fallback is to be right where statfs is not, so check it
    // against the same source of truth an operator would use.
    const path = tmpdir()
    const cols = execFileSync('df', ['-Pk', path], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .at(-1)!
      .split(/\s+/)
    const total = Number(cols[1]) * 1024
    const avail = Number(cols[3]) * 1024

    // statfs and df round differently and the filesystem moves under us, so
    // compare within a tolerance rather than exactly.
    const u = diskUsage(path)
    expect(u.totalBytes).toBeGreaterThan(0)
    expect(Math.abs(u.totalBytes - total) / total).toBeLessThan(0.02)
    expect(Math.abs(u.freeBytes - avail) / Math.max(avail, 1)).toBeLessThan(0.05)
    expect(u.usedPct).toBeGreaterThanOrEqual(0)
    expect(u.usedPct).toBeLessThanOrEqual(100)
  })

  test('reports no signal rather than an empty disk when the path is gone', () => {
    // Zeros mean "unknown". They must not read as 0% used, which would look
    // like abundant free space to the GC watermarks.
    const u = diskUsage('/definitely/not/a/real/path/xyzzy')
    expect(u).toEqual({ totalBytes: 0, freeBytes: 0, usedBytes: 0, usedPct: 0 })
  })
})
