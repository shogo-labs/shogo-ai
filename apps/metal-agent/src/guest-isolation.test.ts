// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'

import { GuestIsolation, ISO_CHAIN, isolationHookArgs, isolationRules } from './guest-isolation'
import { deriveNet } from './net'

describe('SEC-31 guest-to-guest isolation', () => {
  test('drops traffic forwarded from one guest TAP to another', () => {
    expect(isolationRules()).toEqual([['-i', 'fctap+', '-o', 'fctap+', '-j', 'DROP']])
  })

  test('the wildcard covers the TAP names net.ts hands out', () => {
    for (const n of [0, 1, 27, 16383]) expect(deriveNet(n).tap.startsWith('fctap')).toBe(true)
  })

  test('never touches guest egress through the uplink', () => {
    for (const rule of isolationRules()) {
      expect(rule).toContain('-o')
      expect(rule[rule.indexOf('-o') + 1]).toBe('fctap+')
    }
  })

  test('apply builds the chain and hooks it at the top of FORWARD', () => {
    const calls: string[][] = []
    new GuestIsolation((args) => { calls.push(args) }).apply()
    expect(calls).toContainEqual(['-A', ISO_CHAIN, '-i', 'fctap+', '-o', 'fctap+', '-j', 'DROP'])
    expect(calls.at(-1)).toEqual(['-I', ...isolationHookArgs()])
    expect(calls.at(-1)?.[1]).toBe('FORWARD')
  })

  test('apply converges when the chain and hook already exist', () => {
    const calls: string[][] = []
    new GuestIsolation((args) => {
      calls.push(args)
      if (args[0] === '-N') throw new Error('Chain already exists')
    }).apply()
    expect(calls.filter((c) => c[0] === '-I')).toHaveLength(1)
    expect(calls.findIndex((c) => c[0] === '-D')).toBeLessThan(calls.findIndex((c) => c[0] === '-I'))
  })
})
