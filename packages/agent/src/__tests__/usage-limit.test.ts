// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { buildUsageLimitNotice, detectUsageLimit } from '../agent-loop'

const PROXY_402 =
  '402 {"error":{"message":"Usage limit reached. Enable usage-based pricing or upgrade your plan.",' +
  '"type":"billing_error","code":"usage_limit_reached","resetsAt":"2026-09-29T02:00:00.000Z",' +
  '"window":"5h","retryAfterSeconds":7200}}'

describe('detectUsageLimit', () => {
  it('parses the AI proxy 402 including reset time', () => {
    expect(detectUsageLimit(PROXY_402)).toEqual({ resetsAt: '2026-09-29T02:00:00.000Z', window: '5h' })
  })

  it('recognizes the already-parsed message form', () => {
    expect(detectUsageLimit('402 Usage limit reached. Enable usage-based pricing or upgrade your plan.')).toEqual({})
  })

  it('ignores upstream provider billing errors the user cannot fix', () => {
    expect(detectUsageLimit('402 {"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low"}}')).toBeNull()
    expect(detectUsageLimit('402 insufficient_quota')).toBeNull()
    expect(detectUsageLimit('API connection timeout')).toBeNull()
    expect(detectUsageLimit(undefined)).toBeNull()
  })

  // The OpenAI-compatible (Auto / Hoshi) path words it differently, and the
  // billing service answers with its own codes — all of them mean "upgrade
  // helps" and none of them matched before SHO-270, so 52% of the production
  // failures never showed the notice.
  it('recognizes the OpenAI-compatible usage-limit wording', () => {
    expect(detectUsageLimit("402 You've reached your usage limit. Please check your plan and billing details.")).toEqual({})
    expect(detectUsageLimit('400 You have reached your usage limit')).toEqual({})
  })

  it('recognizes the billing service overage codes', () => {
    expect(detectUsageLimit('402 {"error":{"code":"overage_cap_reached","message":"Spending cap reached"}}')).toEqual({})
    expect(detectUsageLimit('402 {"error":{"code":"overage_payment_pending","message":"Payment pending"}}')).toEqual({})
    expect(detectUsageLimit('402 You have reached your spending cap for this period')).toEqual({})
  })
})

describe('buildUsageLimitNotice', () => {
  const now = new Date('2026-09-29T00:00:00.000Z')

  it('includes progress, a relative reset time and the billing action', () => {
    const text = buildUsageLimitNotice(3, { resetsAt: '2026-09-29T02:00:00.000Z' }, now)
    expect(text).toContain("You've reached your usage limit")
    expect(text).toContain('I completed 3 steps')
    expect(text).toContain('in about 2 hours')
    expect(text).toContain('Settings > Billing')
    expect(text).not.toContain('provider error')
  })

  it('never tells the user to type "continue"', () => {
    for (const info of [{ resetsAt: '2026-09-29T02:00:00.000Z' }, {}, { resetsAt: 'garbage' }]) {
      const text = buildUsageLimitNotice(2, info, now)
      expect(text.toLowerCase()).not.toContain('continue')
      expect(text.toLowerCase()).not.toContain('say "continue"')
    }
  })

  it('uses minutes for short waits and singular step', () => {
    const text = buildUsageLimitNotice(1, { resetsAt: '2026-09-29T00:12:30.000Z' }, now)
    expect(text).toContain('I completed 1 step before')
    expect(text).toContain('in 13 minutes')
  })

  it('falls back to the billing action without a usable reset time', () => {
    for (const info of [{}, { resetsAt: 'garbage' }, { resetsAt: '2026-09-28T00:00:00.000Z' }]) {
      const text = buildUsageLimitNotice(2, info, now)
      expect(text).toContain('Settings > Billing')
      expect(text).toContain('Your work is saved and picks up exactly where it stopped')
    }
  })
})
