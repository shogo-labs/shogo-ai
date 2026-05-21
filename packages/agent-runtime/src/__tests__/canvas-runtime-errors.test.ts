// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, beforeEach } from 'bun:test'
import {
  pushCanvasRuntimeError,
  getCanvasRuntimeErrors,
  clearCanvasRuntimeErrors,
  type CanvasRuntimeError,
} from '../canvas-runtime-errors'

function mk(i: number, over: Partial<CanvasRuntimeError> = {}): CanvasRuntimeError {
  return {
    phase: 'render',
    error: `boom-${i}`,
    timestamp: 1000 + i,
    ...over,
  }
}

describe('canvas-runtime-errors', () => {
  beforeEach(() => clearCanvasRuntimeErrors())

  it('starts empty', () => {
    expect(getCanvasRuntimeErrors()).toEqual([])
  })

  it('pushes and reads back entries in insertion order', () => {
    pushCanvasRuntimeError(mk(1))
    pushCanvasRuntimeError(mk(2))
    const errors = getCanvasRuntimeErrors()
    expect(errors).toHaveLength(2)
    expect(errors[0].error).toBe('boom-1')
    expect(errors[1].error).toBe('boom-2')
  })

  it('preserves optional route + recentActions', () => {
    pushCanvasRuntimeError(
      mk(3, {
        route: '/dashboard?tab=a#x',
        recentActions: [{ ts: 1, kind: 'click', target: 'btn', route: '/dashboard' }],
      }),
    )
    const [e] = getCanvasRuntimeErrors()
    expect(e.route).toBe('/dashboard?tab=a#x')
    expect(e.recentActions).toEqual([
      { ts: 1, kind: 'click', target: 'btn', route: '/dashboard' },
    ])
  })

  it('caps the ring buffer at 20 entries and drops oldest', () => {
    for (let i = 0; i < 25; i++) pushCanvasRuntimeError(mk(i))
    const errors = getCanvasRuntimeErrors()
    expect(errors).toHaveLength(20)
    // first 5 should have been spliced out; oldest remaining is index 5
    expect(errors[0].error).toBe('boom-5')
    expect(errors[19].error).toBe('boom-24')
  })

  it('clear() empties the buffer', () => {
    pushCanvasRuntimeError(mk(1))
    pushCanvasRuntimeError(mk(2))
    clearCanvasRuntimeErrors()
    expect(getCanvasRuntimeErrors()).toEqual([])
  })

  it('returns a live reference (callers should not mutate)', () => {
    pushCanvasRuntimeError(mk(1))
    const ref1 = getCanvasRuntimeErrors()
    pushCanvasRuntimeError(mk(2))
    const ref2 = getCanvasRuntimeErrors()
    expect(ref1).toBe(ref2)
    expect(ref2).toHaveLength(2)
  })
})
