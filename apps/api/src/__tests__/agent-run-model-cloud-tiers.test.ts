// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-481 — a cloud-connected desktop's Auto turn must use the cloud's tier
 * map, not the local defaults.
 *
 * SHO-417 (#2048) built the per-turn Auto map from
 * `resolveEffectiveAgentModelDefaults()`, which reads *this* server's admin
 * overrides. A desktop has none, so it fell back to nano / haiku / **Sonnet**
 * and the per-turn map beat the correct cloud map the runtime was spawned with.
 * The regression showed up as `[Auto] → Sonnet 4.6 (COMPLEX)` on a desktop
 * whose cloud sets all three tiers to Hoshi 2.0.
 *
 * These tests exercise the real resolver chain (`resolveAgentRunModelFor` →
 * `allowedAutoTiers`) with the cloud answer stubbed on `globalThis.fetch` and a
 * prisma stub — no `mock.module()` of shared services, which leaks into sibling
 * suites in the same bun process.
 *
 *   bun test apps/api/src/__tests__/agent-run-model-cloud-tiers.test.ts
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const HOSHI_ID = '4fa677d1-9f70-4c4b-9a52-5f0d1c9b6f31'
const CLOUD_TIER = { id: HOSHI_ID, provider: 'custom' }
const CLOUD_BODY = {
  basic: HOSHI_ID,
  advanced: HOSHI_ID,
  defaultMode: 'auto',
  autoTiers: { economy: CLOUD_TIER, standard: CLOUD_TIER, premium: CLOUD_TIER },
  hasAdvancedModelAccess: true,
}

const saved: Record<string, string | undefined> = {}
for (const key of [
  'SHOGO_LOCAL_MODE',
  'SHOGO_API_KEY',
  'SHOGO_CLOUD_URL',
  'AI_MODE',
  'LOCAL_LLM_BASE_URL',
  'LOCAL_LLM_BASIC_MODEL',
]) saved[key] = process.env[key]

// A cloud-connected desktop: local mode + a Shogo Cloud key, no BYOK override.
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_API_KEY = 'shogo_sk_sho481'
delete process.env.AI_MODE
delete process.env.LOCAL_LLM_BASE_URL
delete process.env.LOCAL_LLM_BASIC_MODEL

/** Mutable per-test state the prisma stub reads. */
const state = {
  role: 'owner' as string,
  policyRows: [] as any[],
  modelRows: [] as any[],
  cloudReachable: true,
}

function modelRow(id: string, tier: string) {
  return {
    id,
    provider: 'custom',
    providerId: null,
    apiModel: id,
    displayName: id,
    shortDisplayName: id,
    tier,
    family: 'hoshi',
    generation: '2',
    kind: 'chat',
    maxOutputTokens: 8192,
    enabled: true,
    sortOrder: null,
    aliases: [],
    capabilities: {},
    description: null,
    contextWindow: 128000,
    reasoningEffort: null,
    inputPerMillion: 1,
    cachedInputPerMillion: 0,
    cacheWritePerMillion: 0,
    outputPerMillion: 1,
  }
}

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    agentConfig: { findUnique: async () => ({ modelName: null }) },
    member: { findFirst: async () => (state.role ? { role: state.role } : null) },
    userGroupMember: { findMany: async () => [] },
    accessPolicy: { findMany: async () => state.policyRows },
    workspaceModelVisibility: { findMany: async () => [] },
    workspaceAgentProfile: { findUnique: async () => ({ defaultModel: null }) },
    platformSetting: { findUnique: async () => null },
    modelDefinition: { findMany: async () => state.modelRows },
    modelProvider: { findMany: async () => [] },
  },
}))

const originalFetch = globalThis.fetch
let cloudCalls = 0
globalThis.fetch = (async (input: any) => {
  const url = typeof input === 'string' ? input : input.url
  if (url.includes('/api/platform/agent-model-defaults')) {
    cloudCalls++
    if (!state.cloudReachable) return new Response('nope', { status: 500 })
    return new Response(JSON.stringify(CLOUD_BODY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response('{}', { status: 404 })
}) as any

const { resolveAgentRunModelFor } = await import('../services/agent-run-model.service')
const { invalidateModelRegistry } = await import('../services/model-registry.service')
const { _resetAgentModelDefaultsCache } = await import('../lib/federated-upstream')
const { __clearAccessCache, accessModelCatalog } = await import('../services/access-policy.service')

beforeEach(async () => {
  state.role = 'owner'
  state.policyRows = []
  state.modelRows = []
  state.cloudReachable = true
  cloudCalls = 0
  delete process.env.AI_MODE
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_API_KEY = 'shogo_sk_sho481'
  _resetAgentModelDefaultsCache()
  __clearAccessCache()
  // `resolveEffectiveAgentModelDefaults` caches nothing, but the registry and
  // the summarizer do; reload so each test sees only its own model rows.
  await invalidateModelRegistry()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  _resetAgentModelDefaultsCache()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('SHO-481 — desktop Auto uses the cloud tier map', () => {
  test('AC1: a cloud id the local catalog knows still wins over local defaults', async () => {
    // The cloud's model is mirrored into the desktop's catalog, so the
    // narrowing pass can judge it.
    state.modelRows = [modelRow(HOSHI_ID, 'standard')]

    const run = await resolveAgentRunModelFor(null, 'ws-cloud-known', 'user-1')

    expect(run?.model).toBe('auto')
    expect(run?.autoTiers).toEqual({
      economy: { id: HOSHI_ID, provider: 'custom' },
      standard: { id: HOSHI_ID, provider: 'custom' },
      premium: { id: HOSHI_ID, provider: 'custom' },
    })
    expect(JSON.stringify(run?.autoTiers)).not.toContain('claude-sonnet-4-6')
  })

  test('AC2: a cloud id the local catalog does not know is passed through, not substituted', async () => {
    // No mirrored row: the local catalog cannot judge this id, and substituting
    // a local model for it is exactly the bug.
    state.modelRows = []

    const run = await resolveAgentRunModelFor(null, 'ws-cloud-unknown', 'user-1')

    expect(run?.autoTiers).toEqual({
      economy: { id: HOSHI_ID, provider: 'custom' },
      standard: { id: HOSHI_ID, provider: 'custom' },
      premium: { id: HOSHI_ID, provider: 'custom' },
    })
  })

  test('a known model outside the member grant is still narrowed (SHO-417 preserved)', async () => {
    // Local-only setup: a member whose role policy grants the economy tier only.
    state.cloudReachable = false
    state.role = 'member'
    state.policyRows = [{
      subjectType: 'role',
      subjectId: 'member',
      abilities: null,
      modelTiers: ['economy'],
      modelIds: null,
    }]

    const run = await resolveAgentRunModelFor(null, 'ws-narrowed', 'user-2')
    const ids = Object.values(run!.autoTiers!).map((t) => t.id)
    const economyIds = accessModelCatalog().filter((m) => m.tier === 'economy').map((m) => m.id)

    expect(ids).toHaveLength(3)
    for (const id of ids) {
      // Every tier resolves to a model the member may use; the premium default
      // must not be Sonnet (nor any standard-tier model) any more.
      expect(id).not.toBe('claude-sonnet-4-6')
      expect(economyIds).toContain(id)
    }
  })

  test('AC3: offline, premium falls back to the standard model, never Sonnet', async () => {
    state.cloudReachable = false
    process.env.AI_MODE = 'api-keys'

    const run = await resolveAgentRunModelFor(null, 'ws-offline', 'user-1')

    expect(cloudCalls).toBe(0)
    expect(run?.autoTiers?.premium.id).toBe('claude-haiku-4-5-20251001')
    expect(run?.autoTiers?.premium.id).not.toBe('claude-sonnet-4-6')
  })
})
