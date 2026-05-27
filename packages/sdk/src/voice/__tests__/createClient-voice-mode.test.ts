// SPDX-License-Identifier: MIT
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
import { DirectTelephonyClient, HostedTelephonyClient } from '@shogo-ai/voice'

function baseConfig() {
  return {
    apiUrl: 'https://api.test',
    db: {} as any,
  }
}

describe('createClient() voice-mode resolution', () => {
  const ENV_VARS_TO_CLEAR = ['RUNTIME_AUTH_SECRET', 'SHOGO_API_KEY', 'SHOGO_PROJECT_ID']
  let savedEnv: Record<string, string | undefined> = {}
  const beforeEachFn = () => {
    savedEnv = {}
    for (const k of ENV_VARS_TO_CLEAR) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  }
  const afterEachFn = () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  // bun:test imports
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { beforeEach, afterEach } = require('bun:test') as typeof import('bun:test')
  beforeEach(beforeEachFn)
  afterEach(afterEachFn)

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
