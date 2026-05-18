// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * createClient() client.llm precedence tests for pod-native runtime-token
 * mode. Mirrors the voice precedence suite at
 * `packages/voice/src/__tests__/createClient-runtime-token.test.ts`.
 *
 *   bun test packages/sdk/src/__tests__/client-llm-runtime-token.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createClient } from '../client'

const ORIGINAL_RUNTIME = process.env.RUNTIME_AUTH_SECRET

beforeEach(() => {
  delete process.env.RUNTIME_AUTH_SECRET
})

afterEach(() => {
  if (ORIGINAL_RUNTIME === undefined) delete process.env.RUNTIME_AUTH_SECRET
  else process.env.RUNTIME_AUTH_SECRET = ORIGINAL_RUNTIME
})

describe('createClient() — client.llm precedence (runtime-token)', () => {
  test('RUNTIME_AUTH_SECRET alone → client.llm is non-null', () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt_v1_p_' + 'a'.repeat(64)
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
      projectId: 'proj_1',
    })
    expect(client.llm).not.toBeNull()
  })

  test('RUNTIME_AUTH_SECRET + shogoApiKey → runtime wins, warning emitted', () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt_v1_p_' + 'a'.repeat(64)
    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (msg: any) => {
      warnings.push(String(msg))
    }
    try {
      const client = createClient({
        apiUrl: 'http://api.test',
        db: {} as any,
        projectId: 'proj_1',
        shogoApiKey: 'shogo_sk_ignored',
      })
      expect(client.llm).not.toBeNull()
      expect(warnings.some((w) => w.includes('client.llm') && w.includes('runtime-token'))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  test('shogoApiKey alone → client.llm is non-null (existing behavior)', () => {
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
      shogoApiKey: 'shogo_sk_ext',
    })
    expect(client.llm).not.toBeNull()
  })

  test('neither runtime nor shogoApiKey → client.llm is null', () => {
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
    })
    expect(client.llm).toBeNull()
  })

  test('setShogoApiKey(null) keeps runtime-derived llm when env still present', () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt_v1_p_' + 'a'.repeat(64)
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
      shogoApiKey: 'shogo_sk_initial',
    })
    expect(client.llm).not.toBeNull()
    client.setShogoApiKey(null)
    expect(client.llm).not.toBeNull()
  })

  test('setShogoApiKey(null) drops llm when no runtime token is in env', () => {
    const client = createClient({
      apiUrl: 'http://api.test',
      db: {} as any,
      shogoApiKey: 'shogo_sk_initial',
    })
    expect(client.llm).not.toBeNull()
    client.setShogoApiKey(null)
    expect(client.llm).toBeNull()
  })
})
