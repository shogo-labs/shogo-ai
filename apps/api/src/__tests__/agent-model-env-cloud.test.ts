// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, describe, expect, mock, test } from 'bun:test'

const previousLocalMode = process.env.SHOGO_LOCAL_MODE
const previousApiKey = process.env.SHOGO_API_KEY
const previousAiMode = process.env.AI_MODE
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_API_KEY = 'shogo_sk_test'
delete process.env.AI_MODE

const cloudDefaults = {
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

mock.module('../services/billing.service', () => ({
  hasAdvancedModelAccess: async () => false,
}))

mock.module('../services/public-models.service', () => ({
  resolvePublicModelSync: () => null,
}))

mock.module('../lib/prisma', () => ({
  prisma: { platformSetting: { findUnique: async () => null } },
}))

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => new Response(JSON.stringify(cloudDefaults), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})) as any

const { resolveAgentModelEnv } = await import('../lib/runtime/agent-model-defaults')

describe('cloud-authoritative runtime model env', () => {
  test('uses cloud defaults instead of local fallback settings', async () => {
    const env = await resolveAgentModelEnv('local-workspace')

    expect(env.AGENT_BASIC_MODEL).toBe('mimo-v2.5')
    expect(env.AGENT_ADVANCED_MODEL).toBe('mimo-v2.5')
    expect(JSON.parse(env.AGENT_AUTO_TIER_MAP)).toEqual(cloudDefaults.autoTiers)
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
