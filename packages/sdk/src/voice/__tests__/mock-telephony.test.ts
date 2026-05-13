// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MockTelephonyClient unit tests.
 *
 * Verifies that:
 *  - Every method returns deterministic, well-typed fixture data
 *  - No network requests are made (global fetch is observed and asserted to
 *    never be called for the duration of the test)
 *  - The TelephonyClient interface is satisfied wire-compat with the real
 *    clients (callers should not need to know they're talking to a mock)
 *
 * Run: bun test packages/sdk/src/voice/__tests__/mock-telephony.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { MockTelephonyClient, isVoiceMockEnv } from '../mock-telephony'

let originalFetch: typeof globalThis.fetch
let fetchCallCount = 0

beforeEach(() => {
  fetchCallCount = 0
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (..._args: unknown[]) => {
    fetchCallCount++
    throw new Error('MockTelephonyClient must not invoke global fetch')
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('MockTelephonyClient', () => {
  test('mode === "mock"', () => {
    const client = new MockTelephonyClient()
    expect(client.mode).toBe('mock')
  })

  test('provisionNumber returns the placeholder phone number, no fetch', async () => {
    const client = new MockTelephonyClient()
    const result = await client.provisionNumber()
    expect(result.phoneNumber).toBe('+14155550143')
    expect(result.twilioPhoneSid).toMatch(/^PNmock/)
    expect(result.elevenlabsPhoneId).toMatch(/^phn_mock/)
    expect(result.setupBilledUsd).toBe(0)
    expect(result.monthlyBilledUsd).toBe(0)
    expect(fetchCallCount).toBe(0)
  })

  test('provisionNumber accepts opts without crashing', async () => {
    const client = new MockTelephonyClient()
    const result = await client.provisionNumber({ areaCode: '212', friendlyName: 'demo' })
    expect(result.phoneNumber).toBe('+14155550143')
  })

  test('outboundCall returns a unique synthetic callSid each invocation, no fetch', async () => {
    const client = new MockTelephonyClient()
    const a = await client.outboundCall({ to: '+14155550100' })
    const b = await client.outboundCall({ to: '+14155550101' })
    const c = await client.outboundCall({ to: '+14155550102' })
    expect(a.callSid).not.toBe(b.callSid)
    expect(b.callSid).not.toBe(c.callSid)
    expect(a.callSid).toMatch(/^CAmock/)
    expect(a.conversationId).toBe('mock_conv_001')
    expect(b.conversationId).toBe('mock_conv_002')
    expect(c.conversationId).toBe('mock_conv_003')
    expect(a.estimatedBilledUsd).toBe(0)
    expect(fetchCallCount).toBe(0)
  })

  test('listCalls returns the rotating fixture, length-limited', async () => {
    const client = new MockTelephonyClient()
    const all = await client.listCalls()
    expect(all.length).toBe(3)
    expect(all[0].id).toBe('mock_call_001')
    expect(all[1].id).toBe('mock_call_002')
    expect(all[2].id).toBe('mock_call_003')

    const limited = await client.listCalls({ limit: 2 })
    expect(limited.length).toBe(2)
    expect(fetchCallCount).toBe(0)
  })

  test('listCalls includes transcript when includeTranscript=true', async () => {
    const client = new MockTelephonyClient()
    const calls = await client.listCalls({ includeTranscript: true })
    expect(calls[0].transcript).toBeArray()
    expect(calls[0].transcript!.length).toBeGreaterThan(3)
    expect(calls[0].transcript![0].role).toBe('agent')
    expect(calls[0].transcript![0].message).toContain('AI assistant')

    const without = await client.listCalls({ includeTranscript: false })
    expect(without[0].transcript).toBeUndefined()
  })

  test('getCall finds by id, conversationId, or callSid', async () => {
    const client = new MockTelephonyClient()
    const byId = await client.getCall('mock_call_001')
    expect(byId.id).toBe('mock_call_001')
    expect(byId.transcript).toBeArray()

    const byConv = await client.getCall('mock_conv_002')
    expect(byConv.id).toBe('mock_call_002')

    const bySid = await client.getCall('CAmock00000000000000000000000000003')
    expect(bySid.id).toBe('mock_call_003')
  })

  test('getCall on unknown id returns a synthetic placeholder, never throws', async () => {
    const client = new MockTelephonyClient()
    const result = await client.getCall('does-not-exist')
    expect(result.id).toBe('does-not-exist')
    expect(result.transcript).toBeNull()
    expect(result.billed).toBe(false)
  })

  test('getUsage aggregates fixtures, no fetch', async () => {
    const client = new MockTelephonyClient()
    const usage = await client.getUsage()
    expect(usage.totals.outboundCalls).toBe(3)
    expect(usage.totals.minutesOutbound).toBe(6) // 4 + 1 + 1
    expect(usage.totals.billedUsd).toBe(0)
    expect(usage.events).toEqual([])
    expect(fetchCallCount).toBe(0)
  })

  test('releaseNumber always succeeds, no fetch', async () => {
    const client = new MockTelephonyClient()
    const result = await client.releaseNumber()
    expect(result.released).toBe(true)
    expect(fetchCallCount).toBe(0)
  })

  test('callFixtures override drives listCalls + getUsage', async () => {
    const client = new MockTelephonyClient({
      callFixtures: [
        {
          id: 'custom_001',
          conversationId: 'conv_custom_001',
          callSid: 'CAcustom001',
          direction: 'inbound',
          durationSeconds: 60,
          billedMinutes: 1,
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:01:00Z',
          createdAt: '2026-01-01T00:00:00Z',
          billed: true,
          hasTranscript: false,
          transcriptSummary: null,
        },
      ],
    })
    const calls = await client.listCalls()
    expect(calls.length).toBe(1)
    expect(calls[0].id).toBe('custom_001')
    const usage = await client.getUsage()
    expect(usage.totals.inboundCalls).toBe(1)
    expect(usage.totals.outboundCalls).toBe(0)
  })

  test('phoneNumber override is reflected in provisionNumber', async () => {
    const client = new MockTelephonyClient({ phoneNumber: '+12125550199' })
    const result = await client.provisionNumber()
    expect(result.phoneNumber).toBe('+12125550199')
  })
})

describe('isVoiceMockEnv', () => {
  const ORIGINAL = process.env.SHOGO_VOICE_MODE

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SHOGO_VOICE_MODE
    else process.env.SHOGO_VOICE_MODE = ORIGINAL
  })

  test('returns false when env is unset', () => {
    delete process.env.SHOGO_VOICE_MODE
    expect(isVoiceMockEnv()).toBe(false)
  })

  test('returns true for "mock", "demo", "fake" (case-insensitive)', () => {
    process.env.SHOGO_VOICE_MODE = 'mock'
    expect(isVoiceMockEnv()).toBe(true)
    process.env.SHOGO_VOICE_MODE = 'MOCK'
    expect(isVoiceMockEnv()).toBe(true)
    process.env.SHOGO_VOICE_MODE = 'demo'
    expect(isVoiceMockEnv()).toBe(true)
    process.env.SHOGO_VOICE_MODE = 'fake'
    expect(isVoiceMockEnv()).toBe(true)
  })

  test('returns false for unrelated values', () => {
    process.env.SHOGO_VOICE_MODE = 'real'
    expect(isVoiceMockEnv()).toBe(false)
    process.env.SHOGO_VOICE_MODE = 'hosted'
    expect(isVoiceMockEnv()).toBe(false)
  })
})
