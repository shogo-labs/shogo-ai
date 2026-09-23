// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-mode (desktop) agent model resolution goes through the one real
 * resolver in `agent-model-defaults.ts`, with the same precedence cloud and
 * v1.14.9 desktop use: explicit local LLM → cloud-configured defaults →
 * local admin overrides + entitlement-guarded per-tier defaults.
 *
 * Cloud-connected cases are ported from #971 (dxz6228). No `mock.module()`:
 * mocking shared modules leaks into sibling suites in the same bun process,
 * so `globalThis.fetch` is stubbed and the real modules are exercised.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

const saved: Record<string, string | undefined> = {}
for (const key of [
  'SHOGO_LOCAL_MODE',
  'SHOGO_API_KEY',
  'AI_MODE',
  'AGENT_BASIC_MODEL',
  'AGENT_ADVANCED_MODEL',
  'LOCAL_LLM_BASE_URL',
  'LOCAL_LLM_BASIC_MODEL',
  'LOCAL_LLM_ADVANCED_MODEL',
]) saved[key] = process.env[key]

// Before importing: the billing seam picks its implementation at load.
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_API_KEY = 'shogo_sk_test'
delete process.env.AI_MODE
delete process.env.AGENT_BASIC_MODEL
delete process.env.AGENT_ADVANCED_MODEL
delete process.env.LOCAL_LLM_BASE_URL
delete process.env.LOCAL_LLM_BASIC_MODEL
delete process.env.LOCAL_LLM_ADVANCED_MODEL

const CUSTOM_TIER = { id: '38e6339d-9135-4aff-8641-eba3ae7bebe5', provider: 'custom' }
const CLOUD_BODY = {
  basic: 'mimo-v2.5',
  advanced: 'mimo-v2.5',
  defaultMode: 'auto',
  autoTiers: { economy: CUSTOM_TIER, standard: CUSTOM_TIER, premium: CUSTOM_TIER },
  hasAdvancedModelAccess: true,
}
const HARDCODED_2_0_FALLBACK = 'claude-haiku-4-5-20251001'

type FetchMode = 'ok' | 'throw' | 'http500' | 'malformed'
let fetchMode: FetchMode = 'ok'
let fetchCalls = 0

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => {
  fetchCalls++
  if (fetchMode === 'throw') throw new Error('cloud unreachable')
  if (fetchMode === 'http500') return new Response('nope', { status: 500 })
  const body = fetchMode === 'malformed'
    ? { ...CLOUD_BODY, autoTiers: { economy: {}, standard: {}, premium: {} } }
    : CLOUD_BODY
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as any

const { resolveAgentModelEnv, resolveEffectiveAgentModelDefaults, serializeAutoTierMapEnv } = await import(
  '../lib/runtime/agent-model-defaults'
)
const { _resetAgentModelDefaultsCache } = await import('../lib/federated-upstream')
const { buildWorkspaceEnv } = await import('../lib/runtime/build-workspace-env')

const workspaceEnvSeams = {
  _loadWorkspace: async () => ({ name: 'Local', composioScope: 'workspace' }),
  _getProjectOwnerUserId: async () => 'owner-1',
  _getWorkspaceOwnerUserId: async () => 'owner-1',
  _generateProxyToken: async (projectId: string) => `tok-${projectId}`,
  _loadProjects: async (ids: string[]) => ids.map((id) => ({ id, name: id })),
}

async function expectLocalFallback(env: Awaited<ReturnType<typeof resolveAgentModelEnv>>) {
  const expected = await resolveEffectiveAgentModelDefaults('local-workspace')
  expect(env.AGENT_BASIC_MODEL).toBe(expected.basic)
  expect(env.AGENT_ADVANCED_MODEL).toBe(expected.advanced)
  expect(env.AGENT_AUTO_TIER_MAP).toBe(serializeAutoTierMapEnv(expected.autoTiers)!)
  // The divergent 2.0 shim pinned all three tiers to one hardcoded id.
  const tiers = JSON.parse(env.AGENT_AUTO_TIER_MAP)
  expect(new Set([tiers.economy.id, tiers.standard.id, tiers.premium.id]).size).toBeGreaterThan(1)
}

describe('local-mode agent model env (desktop)', () => {
  beforeEach(() => {
    fetchMode = 'ok'
    fetchCalls = 0
    _resetAgentModelDefaultsCache()
    delete process.env.AI_MODE
    delete process.env.LOCAL_LLM_BASE_URL
    delete process.env.LOCAL_LLM_BASIC_MODEL
  })

  test('the desktop spawn env (buildWorkspaceEnv) carries the cloud-configured Auto tiers', async () => {
    const env = await buildWorkspaceEnv('local-workspace', ['p-1'], workspaceEnvSeams as any)
    expect(JSON.parse(env.AGENT_AUTO_TIER_MAP)).toEqual(CLOUD_BODY.autoTiers)
    expect(env.AGENT_AUTO_TIER_MAP).not.toContain(HARDCODED_2_0_FALLBACK)
  })

  test('honours cloud-configured Auto tiers instead of a hardcoded fallback', async () => {
    const env = await resolveAgentModelEnv('local-workspace')
    expect(env.AGENT_BASIC_MODEL).toBe('mimo-v2.5')
    expect(env.AGENT_ADVANCED_MODEL).toBe('mimo-v2.5')
    expect(JSON.parse(env.AGENT_AUTO_TIER_MAP)).toEqual(CLOUD_BODY.autoTiers)
  })

  test('preserves the provider field on every tier', async () => {
    const tiers = JSON.parse((await resolveAgentModelEnv('local-workspace')).AGENT_AUTO_TIER_MAP)
    for (const tier of ['economy', 'standard', 'premium'] as const) {
      expect(tiers[tier].provider).toBe('custom')
      expect(tiers[tier].id).not.toBe(HARDCODED_2_0_FALLBACK)
    }
  })

  test('an explicit local LLM wins over cloud defaults and is never sent to the cloud', async () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434'
    process.env.LOCAL_LLM_BASIC_MODEL = 'qwen3:8b'
    const env = await resolveAgentModelEnv('local-workspace')
    expect(env.AGENT_BASIC_MODEL).toBe('qwen3:8b')
    expect(JSON.parse(env.AGENT_AUTO_TIER_MAP).economy).toEqual({ id: 'qwen3:8b', provider: 'local' })
    expect(fetchCalls).toBe(0)
  })

  test('falls back to the local resolver (not one hardcoded id) when the cloud rejects the read', async () => {
    fetchMode = 'http500'
    await expectLocalFallback(await resolveAgentModelEnv('local-workspace'))
  })

  test('falls back instead of throwing when the cloud is unreachable', async () => {
    fetchMode = 'throw'
    await expectLocalFallback(await resolveAgentModelEnv('local-workspace'))
  })

  test('ignores a malformed cloud payload with missing tier ids', async () => {
    fetchMode = 'malformed'
    await expectLocalFallback(await resolveAgentModelEnv('local-workspace'))
  })

  test('BYOK (AI_MODE=api-keys) skips the cloud and keeps per-tier defaults', async () => {
    process.env.AI_MODE = 'api-keys'
    await expectLocalFallback(await resolveAgentModelEnv('local-workspace'))
    expect(fetchCalls).toBe(0)
  })

  test('BYOK through the desktop spawn env keeps per-tier defaults', async () => {
    process.env.AI_MODE = 'api-keys'
    await expectLocalFallback(await buildWorkspaceEnv('local-workspace', ['p-1'], workspaceEnvSeams as any))
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  _resetAgentModelDefaultsCache()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
