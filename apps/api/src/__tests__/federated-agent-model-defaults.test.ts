// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

const previousLocalMode = process.env.SHOGO_LOCAL_MODE
const previousApiKey = process.env.SHOGO_API_KEY
const previousAiMode = process.env.AI_MODE
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_API_KEY = 'shogo_sk_test'
delete process.env.AI_MODE

const originalFetch = globalThis.fetch
let fetchCalls = 0

const payload = {
  basic: 'mimo-v2.5',
  advanced: 'mimo-v2.5',
  defaultMode: 'auto',
  autoTiers: {
    economy: { id: 'mimo-v2.5', provider: 'custom' },
    standard: { id: 'mimo-v2.5', provider: 'custom' },
    premium: { id: 'mimo-v2.5', provider: 'custom' },
  },
  hasAdvancedModelAccess: true,
}

globalThis.fetch = (async () => {
  fetchCalls++
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}) as any

const {
  fetchCloudAgentModelDefaults,
  _resetAgentModelDefaultsCache,
  _resetUpstreamCredentialCache,
} = await import('../lib/federated-upstream')

beforeEach(() => {
  fetchCalls = 0
  delete process.env.AI_MODE
  _resetAgentModelDefaultsCache()
  _resetUpstreamCredentialCache()
})

describe('cloud agent model defaults federation', () => {
  test('fetches the connected cloud defaults and caches successful reads', async () => {
    const first = await fetchCloudAgentModelDefaults()
    const second = await fetchCloudAgentModelDefaults()

    expect(first).toEqual(payload)
    expect(second).toEqual(payload)
    expect(fetchCalls).toBe(1)
  })

  test('does not fetch cloud defaults when AI traffic is BYOK/local-LLM', async () => {
    process.env.AI_MODE = 'api-keys'

    expect(await fetchCloudAgentModelDefaults()).toBeNull()
    expect(fetchCalls).toBe(0)
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (previousLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = previousLocalMode
  if (previousApiKey === undefined) delete process.env.SHOGO_API_KEY
  else process.env.SHOGO_API_KEY = previousApiKey
  if (previousAiMode === undefined) delete process.env.AI_MODE
  else process.env.AI_MODE = previousAiMode
})
