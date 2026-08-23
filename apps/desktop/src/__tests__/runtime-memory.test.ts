// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION: a real user's desktop `main.log` (v1.13.32) showed the local
 * agent-runtime for a normal project restarting every ~15-30s forever, each
 * time hitting the flat `RUNTIME_MEMORY_MB=2048` ceiling within seconds of
 * respawn (RSS 2874-3028MB vs. a 2048MB cap) — surfacing to the user as a
 * persistent "Connection interrupted / Reconnecting" banner indistinguishable
 * from a real network outage. `computeDefaultRuntimeMemoryMB` replaces the
 * flat 2048MB default with one scaled to the host's actual RAM.
 */
import { describe, expect, test } from 'bun:test'
import { computeDefaultRuntimeMemoryMB } from '../runtime-memory'

describe('computeDefaultRuntimeMemoryMB', () => {
  test('REPRO: no longer returns the flat 2048MB that caused the restart-loop incident', () => {
    // A common 16GB dev laptop should get well more than the old flat 2048MB.
    expect(computeDefaultRuntimeMemoryMB(16 * 1024)).toBeGreaterThan(2048)
  })

  test('scales to 40% of total RAM within the floor/cap band', () => {
    expect(computeDefaultRuntimeMemoryMB(16 * 1024)).toBe(Math.floor(16 * 1024 * 0.4))
  })

  test('floors at 3072MB for low-RAM machines', () => {
    expect(computeDefaultRuntimeMemoryMB(4 * 1024)).toBe(3072)
    expect(computeDefaultRuntimeMemoryMB(1 * 1024)).toBe(3072)
  })

  test('caps at 8192MB for very high-RAM machines', () => {
    expect(computeDefaultRuntimeMemoryMB(64 * 1024)).toBe(8192)
    expect(computeDefaultRuntimeMemoryMB(128 * 1024)).toBe(8192)
  })

  test('falls back to the floor for invalid input', () => {
    expect(computeDefaultRuntimeMemoryMB(0)).toBe(3072)
    expect(computeDefaultRuntimeMemoryMB(-1)).toBe(3072)
    expect(computeDefaultRuntimeMemoryMB(NaN)).toBe(3072)
  })
})
