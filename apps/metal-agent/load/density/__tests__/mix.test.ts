// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { DEFAULT_MIX, ROLES, allocateRoles, parseMix, roleCounts } from '../mix'

describe('parseMix', () => {
  test('reads fractions', () => {
    expect(parseMix('agent=0.16,app=0.01,idle=0.83')).toEqual({ agent: 0.16, app: 0.01, idle: 0.83 })
  })

  test('reads percentages', () => {
    const m = parseMix('agent=16,app=1,idle=83')
    expect(m.agent).toBeCloseTo(0.16, 6)
    expect(m.app).toBeCloseTo(0.01, 6)
    expect(m.idle).toBeCloseTo(0.83, 6)
  })

  test('normalises a mix that does not sum to 1', () => {
    const m = parseMix('agent=1,app=1,idle=2')
    expect(m.agent + m.app + m.idle).toBeCloseTo(1, 9)
    expect(m.idle).toBeCloseTo(0.5, 9)
  })

  test('a missing role is zero', () => {
    expect(parseMix('agent=1')).toEqual({ agent: 1, app: 0, idle: 0 })
  })

  test('rejects an unknown role', () => {
    expect(() => parseMix('agent=1,worker=1')).toThrow(/unknown role "worker"/)
  })

  test('rejects a negative share', () => {
    expect(() => parseMix('agent=-1,idle=2')).toThrow(/bad share/)
  })

  test('rejects an empty mix', () => {
    expect(() => parseMix('agent=0,app=0,idle=0')).toThrow(/no positive share/)
  })
})

describe('roleCounts', () => {
  test('always sums to n', () => {
    for (const n of [1, 2, 3, 7, 40, 80, 160, 161]) {
      const c = roleCounts(n, DEFAULT_MIX)
      expect(c.agent + c.app + c.idle).toBe(n)
    }
  })

  test('matches the prod mix at 160', () => {
    // 16% of 160 = 25.6, 1% = 1.6, 83% = 132.8 → floors sum to 158, and the two
    // leftover VMs go to the biggest fractions (idle .8, then agent .6).
    expect(roleCounts(160, DEFAULT_MIX)).toEqual({ agent: 26, app: 1, idle: 133 })
  })

  test('gives a single VM to the largest share', () => {
    expect(roleCounts(1, DEFAULT_MIX)).toEqual({ agent: 0, app: 0, idle: 1 })
  })

  test('rejects a non-integer n', () => {
    expect(() => roleCounts(1.5, DEFAULT_MIX)).toThrow(/non-negative integer/)
  })
})

describe('allocateRoles', () => {
  test('returns exactly n roles', () => {
    for (const n of [0, 1, 5, 40, 160]) expect(allocateRoles(n, DEFAULT_MIX)).toHaveLength(n)
  })

  test('counts match roleCounts', () => {
    const roles = allocateRoles(160, DEFAULT_MIX)
    const counts = roleCounts(160, DEFAULT_MIX)
    for (const r of ROLES) expect(roles.filter((x) => x === r)).toHaveLength(counts[r])
  })

  test('spreads roles across the index range, not all agents first', () => {
    const roles = allocateRoles(100, DEFAULT_MIX)
    // The first 10 VMs of a ramp must already contain an agent VM.
    expect(roles.slice(0, 10)).toContain('agent')
    // ...and the last 10 must too.
    expect(roles.slice(-10)).toContain('agent')
  })

  test('is deterministic', () => {
    expect(allocateRoles(80, DEFAULT_MIX)).toEqual(allocateRoles(80, DEFAULT_MIX))
  })
})
