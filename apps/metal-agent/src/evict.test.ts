// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The "ready to suspend" bucket's policy (SHO-444), as pure functions: when a
 * host is full, and which warm VM gives up its slot.
 *
 * The pool tests (pool-evict.test.ts) cover the wiring; these pin the rules
 * themselves, including the ones that must never fire.
 */

import { describe, expect, test } from 'bun:test'
import { hostFullness, resolveMemReserveMiB, selectEvictionVictim, type EvictCandidate } from './evict'

const base = { resident: 0, residentCap: 0, vmMemMiB: 1024, memReserveMiB: 0 }

describe('hostFullness', () => {
  test('a host with no count cap and no memory reserve is never full', () => {
    // The production default: METAL_MAX_RESIDENT_VMS_PER_HOST=0 and no meminfo
    // (or a 0 reserve). Nothing evicts until an operator opts in.
    expect(hostFullness({ ...base, resident: 500 })).toEqual({ full: false })
  })

  test('the count cap fires on the VM that would exceed it', () => {
    expect(hostFullness({ ...base, resident: 1, residentCap: 2 })).toEqual({ full: false })
    expect(hostFullness({ ...base, resident: 2, residentCap: 2 })).toEqual({ full: true, reason: 'slots' })
  })

  test('the memory trigger fires when the incoming VM would eat the reserve', () => {
    const mem = { ...base, memAvailableMiB: 3000, memReserveMiB: 2048 }
    // 3000 − 1024 = 1976 < 2048 → full.
    expect(hostFullness(mem)).toEqual({ full: true, reason: 'mem' })
    // 3000 − 512 = 2488 ≥ 2048 → room.
    expect(hostFullness({ ...mem, vmMemMiB: 512 })).toEqual({ full: false })
  })

  test('the memory trigger is off without meminfo (not Linux) or a zero reserve', () => {
    expect(hostFullness({ ...base, memAvailableMiB: undefined, memReserveMiB: 2048 })).toEqual({ full: false })
    expect(hostFullness({ ...base, memAvailableMiB: 1, memReserveMiB: 0 })).toEqual({ full: false })
  })

  test('slots win when both triggers fire, so the label is deterministic', () => {
    expect(
      hostFullness({ resident: 2, residentCap: 2, memAvailableMiB: 1, vmMemMiB: 1024, memReserveMiB: 2048 }),
    ).toEqual({ full: true, reason: 'slots' })
  })
})

describe('resolveMemReserveMiB', () => {
  test('an explicit reserve wins', () => {
    expect(resolveMemReserveMiB(4096, 262_144)).toBe(4096)
  })

  test('defaults to 10% of MemTotal', () => {
    expect(resolveMemReserveMiB(0, 262_144)).toBe(26_214)
  })

  test('is 0 when the host size is unknown, so the trigger stays off', () => {
    expect(resolveMemReserveMiB(0, undefined)).toBe(0)
  })
})

describe('selectEvictionVictim', () => {
  const cands: EvictCandidate[] = [
    { projectId: 'idle-5', idleMs: 5_000 },
    { projectId: 'idle-50', idleMs: 50_000 },
    { projectId: 'idle-20', idleMs: 20_000 },
  ]
  const none = new Set<string>()

  test('picks the longest-idle VM', () => {
    expect(selectEvictionVictim({ candidates: cands, exclude: none, evicting: none })?.projectId).toBe('idle-50')
  })

  test('never picks the project being assigned', () => {
    expect(
      selectEvictionVictim({ candidates: cands, exclude: new Set(['idle-50']), evicting: none })?.projectId,
    ).toBe('idle-20')
  })

  test('never picks a VM another assign is already evicting', () => {
    // Two concurrent assigns on a full host must evict two DIFFERENT VMs.
    expect(
      selectEvictionVictim({ candidates: cands, exclude: none, evicting: new Set(['idle-50']) })?.projectId,
    ).toBe('idle-20')
  })

  test('returns undefined when nothing is evictable', () => {
    expect(selectEvictionVictim({ candidates: [], exclude: none, evicting: none })).toBeUndefined()
    expect(
      selectEvictionVictim({ candidates: cands, exclude: none, evicting: new Set(cands.map((c) => c.projectId)) }),
    ).toBeUndefined()
  })
})
