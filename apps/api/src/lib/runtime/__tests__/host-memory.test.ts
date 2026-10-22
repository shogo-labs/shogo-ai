// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-143: raising the background pool to 10 runtimes is only safe because
 * host memory — not the cap — decides when another agent may stay warm. These
 * pin the floor and the "is this host low right now" answer that
 * `admitBackgroundStart` acts on.
 */
import { describe, expect, it } from 'bun:test'
import { resolveBackgroundMemoryFloorMb, sampleHostMemory, toMb } from '../host-memory'

describe('resolveBackgroundMemoryFloorMb', () => {
  it('scales to 10% of the machine, clamped to 1–1.5 GB', () => {
    expect(resolveBackgroundMemoryFloorMb(4_000, null)).toBe(1024) // 400 → floor
    expect(resolveBackgroundMemoryFloorMb(8_000, null)).toBe(1024) // 800 → floor
    expect(resolveBackgroundMemoryFloorMb(16_000, null)).toBe(1536) // 1600 → clamp
    expect(resolveBackgroundMemoryFloorMb(64_000, null)).toBe(1536)
  })

  it('honours WORKSPACE_BACKGROUND_MIN_FREE_MB, including 0 to disable the guard', () => {
    expect(resolveBackgroundMemoryFloorMb(16_000, '4096')).toBe(4096)
    expect(resolveBackgroundMemoryFloorMb(16_000, '0')).toBe(0)
  })

  it('ignores an unparseable override and an unknown host size', () => {
    expect(resolveBackgroundMemoryFloorMb(16_000, 'lots')).toBe(1536)
    expect(resolveBackgroundMemoryFloorMb(Number.NaN, null)).toBe(1024)
  })
})

describe('sampleHostMemory', () => {
  it('reports low when free memory is under the floor', () => {
    const sample = sampleHostMemory({ totalMb: 16_000, freeMb: 900, floorMb: 1536 })
    expect(sample.low).toBe(true)
    expect(sample.freeMb).toBe(900)
  })

  it('reports roomy when free memory clears the floor', () => {
    expect(sampleHostMemory({ totalMb: 16_000, freeMb: 9_000 }).low).toBe(false)
  })

  it('treats a zero floor as "never low" — the escape hatch for a pinned host', () => {
    expect(sampleHostMemory({ totalMb: 16_000, freeMb: 1, floorMb: 0 }).low).toBe(false)
  })
})

describe('toMb', () => {
  it('rounds bytes to whole megabytes', () => {
    expect(toMb(1024 * 1024 * 10)).toBe(10)
    expect(toMb(1024 * 1024 * 10.6)).toBe(11)
  })
})
