// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { resolveIdleWindow, type IdleWindowInput } from './idle-policy'

const NOW = 1_000_000
const RELAXED = 4 * 3600_000
const AGGRESSIVE = 15 * 60_000

function input(over: Partial<IdleWindowInput> = {}): IdleWindowInput {
  return {
    directive: { idleMs: RELAXED, tier: 'relaxed', receivedAt: NOW - 1000 },
    now: NOW,
    staleAfterMs: 105_000,
    aggressiveMs: AGGRESSIVE,
    assigned: 10,
    maxVms: 80,
    hostGuardPct: 80,
    standalone: false,
    ...over,
  }
}

describe('resolveIdleWindow', () => {
  test('applies a fresh directive', () => {
    expect(resolveIdleWindow(input())).toEqual({ idleMs: RELAXED, tier: 'relaxed', reason: 'directive', directiveTier: 'relaxed' })
  })

  test('fails safe to the aggressive window with no directive or a stale one', () => {
    expect(resolveIdleWindow(input({ directive: undefined }))).toMatchObject({ idleMs: AGGRESSIVE, reason: 'stale' })
    const stale = resolveIdleWindow(input({ directive: { idleMs: RELAXED, tier: 'relaxed', receivedAt: NOW - 200_000 } }))
    expect(stale).toEqual({ idleMs: AGGRESSIVE, tier: 'aggressive', reason: 'stale', directiveTier: 'relaxed' })
  })

  test('rejects a non-positive directive window rather than disabling suspend', () => {
    expect(resolveIdleWindow(input({ directive: { idleMs: 0, tier: 'relaxed', receivedAt: NOW } })).idleMs).toBe(AGGRESSIVE)
  })

  test('a host near its VM cap goes aggressive whatever the region says', () => {
    expect(resolveIdleWindow(input({ assigned: 64 }))).toEqual({
      idleMs: AGGRESSIVE,
      tier: 'aggressive',
      reason: 'host_guard',
      directiveTier: 'relaxed',
    })
    expect(resolveIdleWindow(input({ assigned: 63 })).reason).toBe('directive')
  })

  test('never widens an aggressive directive', () => {
    const d = { idleMs: 60_000, tier: 'aggressive' as const, receivedAt: NOW }
    expect(resolveIdleWindow(input({ directive: d, assigned: 79 })).idleMs).toBe(60_000)
  })

  test('standalone hosts keep the static window', () => {
    expect(resolveIdleWindow(input({ standalone: true }))).toEqual({ idleMs: AGGRESSIVE, tier: 'aggressive', reason: 'static' })
  })
})
