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
import {
  computeDefaultExecMemoryMB,
  computeDefaultRuntimeMemoryMB,
  computeHostTier,
  normalizeExecMemoryMB,
  resolveExecMemoryMB,
  resolveHostTier,
} from '../runtime-memory'

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

  test('uses a shared low-tier budget for 8GB hosts', () => {
    expect(computeHostTier(8 * 1024, 8)).toBe('low')
    expect(computeHostTier(16 * 1024, 4)).toBe('low')
    expect(computeHostTier(16 * 1024, 8)).toBe('standard')
    expect(computeHostTier(32 * 1024, 8)).toBe('high')
  })

  test('honors an explicit host-tier override', () => {
    expect(resolveHostTier({ SHOGO_HOST_TIER: 'standard' }, 8 * 1024)).toBe('standard')
    expect(resolveHostTier({}, 8 * 1024)).toBe('low')
  })
})

describe('computeDefaultExecMemoryMB', () => {
  const GB = 1024

  test('REPRO: a 128 GB Mac gets 120 GB for commands, not the 8 GB runtime ceiling', () => {
    // SHO-203: a 22.5 GB model was killed at 21.3 GB on a 128 GB machine.
    expect(computeDefaultExecMemoryMB(128 * GB)).toBe(120 * GB)
    expect(computeDefaultExecMemoryMB(128 * GB)).toBeGreaterThan(22.5 * GB)
  })

  test('scales to max(50% of RAM, RAM - 8192)', () => {
    expect(computeDefaultExecMemoryMB(64 * GB)).toBe(56 * GB)
    expect(computeDefaultExecMemoryMB(32 * GB)).toBe(24 * GB)
    expect(computeDefaultExecMemoryMB(16 * GB)).toBe(8 * GB)
  })

  test('never drops below half of RAM on a small machine', () => {
    expect(computeDefaultExecMemoryMB(8 * GB)).toBe(4 * GB)
    expect(computeDefaultExecMemoryMB(4 * GB)).toBe(2 * GB)
  })

  test('falls back to 8 GB for invalid input', () => {
    expect(computeDefaultExecMemoryMB(0)).toBe(8192)
    expect(computeDefaultExecMemoryMB(NaN)).toBe(8192)
  })
})

describe('resolveExecMemoryMB', () => {
  const GB = 1024

  test("resolves 'auto' (and a missing value) from this machine's RAM", () => {
    expect(resolveExecMemoryMB('auto', 128 * GB)).toBe(120 * GB)
    expect(resolveExecMemoryMB(undefined, 32 * GB)).toBe(24 * GB)
  })

  test('keeps an explicit value, clamped to [1024, total RAM]', () => {
    expect(resolveExecMemoryMB(24 * GB, 128 * GB)).toBe(24 * GB)
    expect(resolveExecMemoryMB(100, 128 * GB)).toBe(1024)
    expect(resolveExecMemoryMB(256 * GB, 128 * GB)).toBe(128 * GB)
  })
})

describe('normalizeExecMemoryMB', () => {
  test('accepts auto and positive numbers, rejects everything else', () => {
    expect(normalizeExecMemoryMB('auto')).toBe('auto')
    expect(normalizeExecMemoryMB(24576)).toBe(24576)
    expect(normalizeExecMemoryMB(24576.4)).toBe(24576)
    expect(normalizeExecMemoryMB(0)).toBe('auto')
    expect(normalizeExecMemoryMB(-1)).toBe('auto')
    expect(normalizeExecMemoryMB('24576')).toBe('auto')
    expect(normalizeExecMemoryMB(null)).toBe('auto')
  })
})
