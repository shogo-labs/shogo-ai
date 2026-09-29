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
    expect(detectUsageLimit('API connection timeout')).toBeNull()
    expect(detectUsageLimit(undefined)).toBeNull()
  })
})

describe('buildUsageLimitNotice', () => {
  const now = new Date('2026-09-29T00:00:00.000Z')

  it('includes progress and a relative reset time', () => {
    const text = buildUsageLimitNotice(3, { resetsAt: '2026-09-29T02:00:00.000Z' }, now)
    expect(text).toContain("You've reached your usage limit")
    expect(text).toContain('I completed 3 steps')
    expect(text).toContain('in about 2 hours')
    expect(text).toContain('Send "continue"')
    expect(text).not.toContain('provider error')
  })

  it('uses minutes for short waits and singular step', () => {
    const text = buildUsageLimitNotice(1, { resetsAt: '2026-09-29T00:12:30.000Z' }, now)
    expect(text).toContain('I completed 1 step before')
    expect(text).toContain('in 13 minutes')
  })

  it('falls back to generic guidance without a usable reset time', () => {
    for (const info of [{}, { resetsAt: 'garbage' }, { resetsAt: '2026-09-28T00:00:00.000Z' }]) {
      const text = buildUsageLimitNotice(2, info, now)
      expect(text).toContain('once your usage resets or you upgrade')
      expect(text).toContain('Settings > Billing')
    }
  })
})
