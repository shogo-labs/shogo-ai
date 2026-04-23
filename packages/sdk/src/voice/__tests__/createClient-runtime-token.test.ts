// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * createClient() voice.telephony precedence tests for pod-native
 * runtime-token mode. Runtime-token mode must win when
 * `process.env.RUNTIME_AUTH_SECRET` + `projectId` are present, even if
 * `shogoApiKey` is also passed.
 *
 * Run: bun test packages/sdk/src/voice/__tests__/createClient-runtime-token.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createClient } from '../../client'
import {
  DirectTelephonyClient,
  HostedRuntimeTokenClient,
  HostedTelephonyClient,
} from '../telephony'

const ORIGINAL_RUNTIME = process.env.RUNTIME_AUTH_SECRET

beforeEach(() => {
  delete process.env.RUNTIME_AUTH_SECRET
})

afterEach(() => {
  if (ORIGINAL_RUNTIME === undefined) delete process.env.RUNTIME_AUTH_SECRET
  else process.env.RUNTIME_AUTH_SECRET = ORIGINAL_RUNTIME
})

describe('createClient() — voice.telephony precedence (runtime-token)', () => {
  test('RUNTIME_AUTH_SECRET + projectId → HostedRuntimeTokenClient', () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt_token_abc'
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
      projectId: 'proj_1',
    })
    expect(client.voice.telephony).toBeInstanceOf(HostedRuntimeTokenClient)
    expect(client.voice.telephony?.mode).toBe('hosted')
  })

  test('RUNTIME_AUTH_SECRET + projectId + shogoApiKey → runtime-token wins', () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt_token_abc'
    const originalWarn = console.warn
    let warned = ''
    console.warn = (msg: any) => {
      warned = String(msg)
    }
    try {
      const client = createClient({
        apiUrl: 'http://api.test',
        db: {} as any,
        projectId: 'proj_1',
        shogoApiKey: 'shogo_sk_ignored',
      })
      expect(client.voice.telephony).toBeInstanceOf(HostedRuntimeTokenClient)
      expect(warned).toContain('runtime-token')
    } finally {
      console.warn = originalWarn
    }
  })

  test('no RUNTIME_AUTH_SECRET + shogoApiKey + projectId → HostedTelephonyClient', () => {
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
      projectId: 'proj_1',
      shogoApiKey: 'shogo_sk_ext',
    })
    expect(client.voice.telephony).toBeInstanceOf(HostedTelephonyClient)
  })

  test('no RUNTIME_AUTH_SECRET + elevenlabs+twilio → DirectTelephonyClient', () => {
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
      elevenlabs: { apiKey: 'el_k', agentId: 'a' },
      twilio: { accountSid: 'AC', authToken: 't' },
    })
    expect(client.voice.telephony).toBeInstanceOf(DirectTelephonyClient)
  })

  test('nothing → voice.telephony is null', () => {
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
    })
    expect(client.voice.telephony).toBeNull()
  })

  test('RUNTIME_AUTH_SECRET set but no projectId → does NOT pick runtime-token', () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt_token_abc'
    // Without projectId we have no scope for the runtime token, so we
    // must not try to use it. Fall through to remaining paths (null here).
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
    })
    expect(client.voice.telephony).toBeNull()
  })
})
