// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit test for the SDK's createClient() voice-mode resolution:
 *
 *   - shogoApiKey + projectId         → hosted (Mode B)
 *   - direct elevenlabs + twilio      → direct (Mode A)
 *   - both                             → hosted + console.warn
 *   - neither                          → voice.telephony is null
 *
 *   bun test packages/sdk/src/voice/__tests__/createClient-voice-mode.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { createClient } from '../../client'
import { DirectTelephonyClient, HostedTelephonyClient } from '../telephony'

function baseConfig() {
  return {
    apiUrl: 'https://api.test',
    db: {} as any,
  }
}

describe('createClient() voice-mode resolution', () => {
  test('hosted when shogoApiKey + projectId supplied', () => {
    const client = createClient({
      ...baseConfig(),
      shogoApiKey: 'shogo_sk_test',
      projectId: 'proj-1',
    })
    expect(client.voice.telephony).toBeInstanceOf(HostedTelephonyClient)
    expect(client.voice.telephony?.mode).toBe('hosted')
  })

  test('direct when elevenlabs + twilio supplied without a Shogo key', () => {
    const client = createClient({
      ...baseConfig(),
      projectId: 'proj-1',
      elevenlabs: { apiKey: 'sk_el', agentId: 'agent_1' },
      twilio: { accountSid: 'AC', authToken: 'tok' },
    })
    expect(client.voice.telephony).toBeInstanceOf(DirectTelephonyClient)
    expect(client.voice.telephony?.mode).toBe('direct')
  })

  test('hosted wins when both Shogo key and direct creds are supplied', () => {
    const warned: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: any[]) => {
      warned.push(args.map((a) => String(a)).join(' '))
    }
    try {
      const client = createClient({
        ...baseConfig(),
        shogoApiKey: 'shogo_sk_test',
        projectId: 'proj-1',
        elevenlabs: { apiKey: 'sk_el', agentId: 'agent_1' },
        twilio: { accountSid: 'AC', authToken: 'tok' },
      })
      expect(client.voice.telephony).toBeInstanceOf(HostedTelephonyClient)
      expect(warned.join('\n')).toContain('using hosted')
    } finally {
      console.warn = originalWarn
    }
  })

  test('voice.telephony is null without any voice creds', () => {
    const client = createClient({ ...baseConfig() })
    expect(client.voice.telephony).toBeNull()
  })

  test('setShogoApiKey can light up Mode B after construction', () => {
    const client = createClient({ ...baseConfig(), projectId: 'proj-1' })
    expect(client.voice.telephony).toBeNull()
    client.setShogoApiKey('shogo_sk_test')
    expect(client.voice.telephony).toBeInstanceOf(HostedTelephonyClient)
    client.setShogoApiKey(null)
    expect(client.voice.telephony).toBeNull()
  })
})
