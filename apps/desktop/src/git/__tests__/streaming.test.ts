// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Tests for the stderr progress-line parser used by streaming git ops.
// We test the pure parser only; the spawn/IPC layer is integration-tested
// via the real renderer.

import { describe, expect, it } from 'bun:test'
import { parseProgressLine } from '../streaming'

describe('parseProgressLine', () => {
  it('returns null for empty input', () => {
    expect(parseProgressLine('')).toBeNull()
  })

  it('parses a percentage line', () => {
    expect(parseProgressLine('Receiving objects:  47% (47/100), 1.23 MiB | 5.43 MiB/s')).toEqual({
      phase: 'Receiving objects',
      percent: 47,
      raw: 'Receiving objects:  47% (47/100), 1.23 MiB | 5.43 MiB/s',
    })
  })

  it('parses a remote-prefixed percentage line', () => {
    expect(parseProgressLine('remote: Counting objects:  74% (3/4)')).toMatchObject({
      phase: 'Counting objects',
      percent: 74,
    })
  })

  it('parses a phase-only line (no percentage)', () => {
    expect(parseProgressLine('remote: Enumerating objects: 5, done.')).toMatchObject({
      phase: 'remote',
      percent: null,
    })
  })

  it('clamps absurd percentages to 0..100', () => {
    expect(parseProgressLine('foo: 999%')?.percent).toBe(100)
    expect(parseProgressLine('foo: 0%')?.percent).toBe(0)
  })

  it('falls back to a phase-only event for arbitrary status lines', () => {
    expect(parseProgressLine('Already up to date.')).toMatchObject({
      phase: 'Already up to date.',
      percent: null,
    })
  })

  it('captures the raw line for the debug log surface', () => {
    const raw = 'Resolving deltas:  20% (1/5)'
    expect(parseProgressLine(raw)?.raw).toBe(raw)
  })
})
