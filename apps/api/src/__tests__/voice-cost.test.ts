// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the voice cost helpers. Pure rounding + rate lookup,
 * no network or DB. Run:
 *
 *   bun test apps/api/src/__tests__/voice-cost.test.ts
 */

import { describe, test, expect } from 'bun:test'

import { calculateVoiceMinuteCost, resolveVoiceRate } from '../lib/voice-cost'
import { VOICE_RATES } from '../config/credit-plans'

describe('calculateVoiceMinuteCost', () => {
  test('0 seconds still bills one minute (EL always connects)', () => {
    const r = calculateVoiceMinuteCost(null, 'inbound', 0)
    expect(r.billedMinutes).toBe(1)
    expect(r.creditCost).toBe(VOICE_RATES.minutesInbound)
  })

  test('60 seconds bills exactly one minute', () => {
    const r = calculateVoiceMinuteCost(null, 'inbound', 60)
    expect(r.billedMinutes).toBe(1)
  })

  test('61 seconds rounds up to two minutes', () => {
    const r = calculateVoiceMinuteCost(null, 'inbound', 61)
    expect(r.billedMinutes).toBe(2)
    expect(r.creditCost).toBe(VOICE_RATES.minutesInbound * 2)
  })

  test('120 seconds stays at two minutes', () => {
    const r = calculateVoiceMinuteCost(null, 'outbound', 120)
    expect(r.billedMinutes).toBe(2)
    expect(r.creditCost).toBe(VOICE_RATES.minutesOutbound * 2)
  })

  test('121 seconds rounds up to three minutes', () => {
    const r = calculateVoiceMinuteCost(null, 'outbound', 121)
    expect(r.billedMinutes).toBe(3)
  })

  test('direction selects the correct rate', () => {
    const inb = calculateVoiceMinuteCost(null, 'inbound', 60)
    const outb = calculateVoiceMinuteCost(null, 'outbound', 60)
    expect(inb.creditsPerMinute).toBe(VOICE_RATES.minutesInbound)
    expect(outb.creditsPerMinute).toBe(VOICE_RATES.minutesOutbound)
  })

  test('negative durations clamp to zero and still bill a minute', () => {
    const r = calculateVoiceMinuteCost(null, 'inbound', -30)
    expect(r.billedMinutes).toBe(1)
  })
})

describe('resolveVoiceRate', () => {
  test('returns the flat VOICE_RATES value when no plan override exists', () => {
    expect(resolveVoiceRate('free', 'minutesInbound')).toBe(
      VOICE_RATES.minutesInbound,
    )
    expect(resolveVoiceRate(undefined, 'numberSetup')).toBe(
      VOICE_RATES.numberSetup,
    )
    expect(resolveVoiceRate('pro_monthly', 'numberMonthly')).toBe(
      VOICE_RATES.numberMonthly,
    )
  })

  test('returns the base rate for keys untouched by PLAN_VOICE_RATE_OVERRIDES', () => {
    expect(resolveVoiceRate('free', 'minutesOutbound')).toBe(
      VOICE_RATES.minutesOutbound,
    )
  })
})
