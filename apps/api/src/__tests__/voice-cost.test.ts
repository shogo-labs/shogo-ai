// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the USD voice cost helpers. Pure rounding + rate lookup,
 * no network or DB. Run:
 *
 *   bun test apps/api/src/__tests__/voice-cost.test.ts
 */

import { describe, test, expect } from 'bun:test'

import {
  calculateVoiceMinuteCost,
  calculateVoiceNumberCost,
  resolveVoiceRate,
} from '../lib/voice-cost'
import { VOICE_RAW_USD } from '../config/usage-plans'
import { MARKUP_MULTIPLIER } from '../lib/usage-cost'

describe('calculateVoiceMinuteCost', () => {
  test('0 seconds still bills one minute (EL always connects)', () => {
    const r = calculateVoiceMinuteCost(null, 'inbound', 0)
    expect(r.billedMinutes).toBe(1)
    expect(r.rawUsd).toBeCloseTo(VOICE_RAW_USD.minutesInbound, 10)
    expect(r.billedUsd).toBeCloseTo(VOICE_RAW_USD.minutesInbound * MARKUP_MULTIPLIER, 10)
  })

  test('60 seconds bills exactly one minute', () => {
    const r = calculateVoiceMinuteCost(null, 'inbound', 60)
    expect(r.billedMinutes).toBe(1)
  })

  test('61 seconds rounds up to two minutes', () => {
    const r = calculateVoiceMinuteCost(null, 'inbound', 61)
    expect(r.billedMinutes).toBe(2)
    expect(r.rawUsd).toBeCloseTo(VOICE_RAW_USD.minutesInbound * 2, 10)
    expect(r.billedUsd).toBeCloseTo(VOICE_RAW_USD.minutesInbound * 2 * MARKUP_MULTIPLIER, 10)
  })

  test('120 seconds stays at two minutes', () => {
    const r = calculateVoiceMinuteCost(null, 'outbound', 120)
    expect(r.billedMinutes).toBe(2)
    expect(r.rawUsd).toBeCloseTo(VOICE_RAW_USD.minutesOutbound * 2, 10)
    expect(r.billedUsd).toBeCloseTo(VOICE_RAW_USD.minutesOutbound * 2 * MARKUP_MULTIPLIER, 10)
  })

  test('121 seconds rounds up to three minutes', () => {
    const r = calculateVoiceMinuteCost(null, 'outbound', 121)
    expect(r.billedMinutes).toBe(3)
  })

  test('direction selects the correct rate', () => {
    const inb = calculateVoiceMinuteCost(null, 'inbound', 60)
    const outb = calculateVoiceMinuteCost(null, 'outbound', 60)
    expect(inb.rawUsdPerMinute).toBe(VOICE_RAW_USD.minutesInbound)
    expect(outb.rawUsdPerMinute).toBe(VOICE_RAW_USD.minutesOutbound)
    expect(inb.billedUsdPerMinute).toBeCloseTo(VOICE_RAW_USD.minutesInbound * MARKUP_MULTIPLIER, 10)
    expect(outb.billedUsdPerMinute).toBeCloseTo(VOICE_RAW_USD.minutesOutbound * MARKUP_MULTIPLIER, 10)
  })

  test('negative durations clamp to zero and still bill a minute', () => {
    const r = calculateVoiceMinuteCost(null, 'inbound', -30)
    expect(r.billedMinutes).toBe(1)
  })

  test('fractional rate multiplies through without integer truncation', () => {
    // Outbound rate is $0.24/min raw — 5 min should bill $1.20 raw + 20%,
    // not $1.00 or $1.25. Guards against anyone re-typing VOICE_RAW_USD as int.
    const r = calculateVoiceMinuteCost(null, 'outbound', 5 * 60)
    expect(r.billedMinutes).toBe(5)
    expect(r.rawUsdPerMinute).toBe(VOICE_RAW_USD.minutesOutbound)
    expect(r.rawUsd).toBeCloseTo(VOICE_RAW_USD.minutesOutbound * 5, 10)
    expect(r.billedUsd).toBeCloseTo(
      VOICE_RAW_USD.minutesOutbound * 5 * MARKUP_MULTIPLIER,
      10,
    )
  })

  test('billed cost = raw cost * MARKUP_MULTIPLIER', () => {
    const r = calculateVoiceMinuteCost(null, 'inbound', 60)
    expect(r.billedUsd / r.rawUsd).toBeCloseTo(MARKUP_MULTIPLIER, 10)
  })
})

describe('calculateVoiceNumberCost', () => {
  test('setup charge is a one-off number-setup rate plus markup', () => {
    const r = calculateVoiceNumberCost(null, 'setup')
    expect(r.rawUsd).toBe(VOICE_RAW_USD.numberSetup)
    expect(r.billedUsd).toBeCloseTo(VOICE_RAW_USD.numberSetup * MARKUP_MULTIPLIER, 10)
  })

  test('monthly charge uses numberMonthly rate plus markup', () => {
    const r = calculateVoiceNumberCost(null, 'monthly')
    expect(r.rawUsd).toBe(VOICE_RAW_USD.numberMonthly)
    expect(r.billedUsd).toBeCloseTo(VOICE_RAW_USD.numberMonthly * MARKUP_MULTIPLIER, 10)
  })
})

describe('resolveVoiceRate', () => {
  test('returns the flat VOICE_RAW_USD value when no plan override exists', () => {
    expect(resolveVoiceRate('free', 'minutesInbound')).toBe(VOICE_RAW_USD.minutesInbound)
    expect(resolveVoiceRate(undefined, 'numberSetup')).toBe(VOICE_RAW_USD.numberSetup)
    expect(resolveVoiceRate('pro_monthly', 'numberMonthly')).toBe(VOICE_RAW_USD.numberMonthly)
  })

  test('returns the base rate for keys untouched by PLAN_VOICE_RATE_OVERRIDES', () => {
    expect(resolveVoiceRate('free', 'minutesOutbound')).toBe(VOICE_RAW_USD.minutesOutbound)
  })
})
