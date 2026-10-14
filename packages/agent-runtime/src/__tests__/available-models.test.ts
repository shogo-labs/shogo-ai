// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  __resetAvailableModelsForTests,
  availableModelsHint,
  getAvailableModels,
  isAvailableModel,
  isAvailableModelListLoaded,
  refreshAvailableModels,
  resolveAutoTierModelId,
} from '../available-models'

const realFetch = globalThis.fetch
const savedEnv = {
  AI_PROXY_URL: process.env.AI_PROXY_URL,
  AI_PROXY_TOKEN: process.env.AI_PROXY_TOKEN,
  AGENT_AUTO_TIER_MAP: process.env.AGENT_AUTO_TIER_MAP,
}

function mockProxyModels(payload: unknown, status = 200) {
  const calls: Array<{ url: string; auth: string | null }> = []
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null })
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  }) as any
  return calls
}

const WORKSPACE_LIST = {
  object: 'list',
  data: [
    { id: 'claude-sonnet-5', object: 'model', owned_by: 'anthropic', display_name: 'Claude Sonnet 5', available: true },
    { id: 'gpt-6-luna', object: 'model', owned_by: 'openai', display_name: 'GPT-6 Luna', available: true },
    // Live (realtime) models are not chat models; the picker's chat list excludes them.
    { id: 'gpt-live-1', object: 'model', owned_by: 'openai', display_name: 'GPT-Live 1', kind: 'live', available: true },
    // Unconfigured providers are listed but not usable.
    { id: 'claude-fable-5-1', object: 'model', owned_by: 'anthropic', display_name: 'Claude Fable 5.1', available: false },
  ],
}

beforeEach(() => {
  __resetAvailableModelsForTests()
  process.env.AI_PROXY_URL = 'https://api.example.test/api/ai/v1'
  process.env.AI_PROXY_TOKEN = 'proxy-token'
  delete process.env.AGENT_AUTO_TIER_MAP
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetAvailableModelsForTests()
})

describe('isAvailableModel', () => {
  test('auto is always available', () => {
    expect(isAvailableModel('auto')).toBe(true)
  })

  test('accepts any concrete id until the list has loaded (cannot validate yet)', () => {
    expect(isAvailableModelListLoaded()).toBe(false)
    expect(isAvailableModel('claude-sonnet-5')).toBe(true)
  })

  test('once loaded, only ids the API offered are available', async () => {
    mockProxyModels(WORKSPACE_LIST)
    await refreshAvailableModels()
    expect(isAvailableModel('claude-sonnet-5')).toBe(true)
    expect(isAvailableModel('gpt-6-luna')).toBe(true)
    expect(isAvailableModel('gpt-live-1')).toBe(false)
    expect(isAvailableModel('claude-fable-5-1')).toBe(false)
    expect(isAvailableModel('made-up-model')).toBe(false)
  })
})

describe('refreshAvailableModels', () => {
  test('calls the proxy models endpoint with the proxy token', async () => {
    const calls = mockProxyModels(WORKSPACE_LIST)
    await refreshAvailableModels()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.example.test/api/ai/v1/models')
    expect(calls[0].auth).toBe('Bearer proxy-token')
  })

  test('keeps only usable chat models', async () => {
    mockProxyModels(WORKSPACE_LIST)
    await refreshAvailableModels()
    expect(getAvailableModels().map((m) => m.id)).toEqual(['claude-sonnet-5', 'gpt-6-luna'])
  })

  test('uses the cache within the TTL, and refetches when forced', async () => {
    const calls = mockProxyModels(WORKSPACE_LIST)
    await refreshAvailableModels()
    await refreshAvailableModels()
    expect(calls).toHaveLength(1)
    await refreshAvailableModels({ force: true })
    expect(calls).toHaveLength(2)
  })

  test('keeps the previous list when a refresh fails', async () => {
    mockProxyModels(WORKSPACE_LIST)
    await refreshAvailableModels()
    mockProxyModels({ error: 'boom' }, 500)
    await refreshAvailableModels({ force: true })
    expect(getAvailableModels().map((m) => m.id)).toContain('claude-sonnet-5')
  })

  test('does nothing without a configured proxy', async () => {
    delete process.env.AI_PROXY_URL
    const calls = mockProxyModels(WORKSPACE_LIST)
    await refreshAvailableModels()
    expect(calls).toHaveLength(0)
    expect(isAvailableModelListLoaded()).toBe(false)
  })
})

describe('availableModelsHint', () => {
  test('offers only auto before the list has loaded', () => {
    expect(availableModelsHint()).toBe('Use "auto" (recommended).')
  })

  test('lists the loaded model ids', async () => {
    mockProxyModels(WORKSPACE_LIST)
    await refreshAvailableModels()
    const hint = availableModelsHint()
    expect(hint).toContain('"auto" (recommended)')
    expect(hint).toContain('"claude-sonnet-5"')
    expect(hint).toContain('"gpt-6-luna"')
  })
})

describe('resolveAutoTierModelId', () => {
  test('reads the admin tier map the API injects', () => {
    process.env.AGENT_AUTO_TIER_MAP = JSON.stringify({ standard: { id: 'admin-standard' } })
    expect(resolveAutoTierModelId('standard')).toBe('admin-standard')
  })

  test('falls back to the package defaults on a malformed override', () => {
    process.env.AGENT_AUTO_TIER_MAP = '{not json'
    expect(resolveAutoTierModelId('economy')).toBeTruthy()
    expect(resolveAutoTierModelId('economy')).not.toBe('auto')
  })
})
