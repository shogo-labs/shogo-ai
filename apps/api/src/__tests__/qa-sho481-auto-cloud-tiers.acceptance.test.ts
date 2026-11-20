// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-481 acceptance (API half) — what a cloud-connected desktop actually puts
 * on the wire for an Auto turn.
 *
 * The regression: SHO-417 built the per-turn Auto map from
 * `resolveEffectiveAgentModelDefaults()` (this server's admin settings, empty on
 * a desktop ⇒ nano / haiku / **Sonnet**), and that map beat the correct cloud
 * map in `AGENT_AUTO_TIER_MAP`. The turn's `[Auto] → Sonnet 4.6 (COMPLEX…)` came
 * from the body, not from the env map.
 *
 * This spec drives the real resolver on a desktop whose cloud sets every tier to
 * Hoshi 2.0 and asserts the *serialized* body — the exact JSON
 * `project-chat.ts` / `workspace-chat.ts` / `conversation-agent-dispatcher.ts`
 * stamp — is the cloud map with its providers intact, and that
 * `AGENT_AUTO_TIER_MAP` (the runtime's process map) says the same thing. The
 * literal is then used verbatim by the runtime half
 * (`packages/agent-runtime/src/__tests__/qa-sho481-auto-cloud-tiers.acceptance.test.ts`),
 * which routes it: the gateway cannot be imported from here (see the note in
 * `qa-sho221-personal-build-redirect.acceptance.test.ts`).
 *
 *   bun test src/__tests__/qa-sho481-auto-cloud-tiers.acceptance.test.ts
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const HOSHI_ID = '4fa677d1-9f70-4c4b-9a52-5f0d1c9b6f31'
const SONNET = 'claude-sonnet-4-6'
/** Every tier set to Hoshi 2.0, the way prod's platform_settings has it. */
const CLOUD_TIER = { id: HOSHI_ID, provider: 'custom' }
const CLOUD_BODY = {
  basic: HOSHI_ID,
  advanced: HOSHI_ID,
  defaultMode: 'auto',
  autoTiers: { economy: CLOUD_TIER, standard: CLOUD_TIER, premium: CLOUD_TIER },
  hasAdvancedModelAccess: true,
}

const saved: Record<string, string | undefined> = {}
for (const key of ['SHOGO_LOCAL_MODE', 'SHOGO_API_KEY', 'SHOGO_CLOUD_URL', 'AI_MODE']) saved[key] = process.env[key]

/** Mutable state the prisma stub reads. */
const state = { role: 'owner' as string, modelRows: [] as any[] }

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
    accessPolicy: { findMany: async () => [] },
    workspaceModelVisibility: { findMany: async () => [] },
    workspaceAgentProfile: { findUnique: async () => ({ defaultModel: null }) },
    platformSetting: { findUnique: async () => null },
    modelDefinition: { findMany: async () => state.modelRows },
    modelProvider: { findMany: async () => [] },
  },
}))

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: any) => {
  const url = typeof input === 'string' ? input : input.url
  if (url.includes('/api/platform/agent-model-defaults')) {
    return new Response(JSON.stringify(CLOUD_BODY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response('{}', { status: 404 })
}) as any

const { resolveAgentRunModelFor } = await import('../services/agent-run-model.service')
const { resolveAgentModelEnv } = await import('../lib/runtime/agent-model-defaults')
const { invalidateModelRegistry } = await import('../services/model-registry.service')
const { _resetAgentModelDefaultsCache } = await import('../lib/federated-upstream')
const { __clearAccessCache } = await import('../services/access-policy.service')

beforeEach(async () => {
  state.role = 'owner'
  state.modelRows = []
  delete process.env.AI_MODE
  delete process.env.SHOGO_CLOUD_URL
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_API_KEY = 'shogo_sk_sho481_qa'
  _resetAgentModelDefaultsCache()
  __clearAccessCache()
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

describe('SHO-481 — the Auto body a cloud-connected desktop stamps', () => {
  test('all three tiers go on the wire as the cloud model, providers intact', async () => {
    // The desktop's catalog mirror: the package defaults, not the cloud's
    // model. This is the state that produced Sonnet — the local tier ids are
    // usable, so narrowing happily substituted them for the cloud's id.
    state.modelRows = [
      modelRow('gpt-5.4-nano', 'economy'),
      modelRow('claude-haiku-4-5-20251001', 'standard'),
      modelRow(SONNET, 'premium'),
    ]

    const run = await resolveAgentRunModelFor(null, 'ws-qa-481', 'user-1')
    expect(run?.model).toBe('auto')

    // Exactly what the chat routes hand the runtime as `body.autoTiers`.
    const wire = JSON.stringify(run!.autoTiers)

    expect(JSON.parse(wire)).toEqual({
      economy: CLOUD_TIER,
      standard: CLOUD_TIER,
      premium: CLOUD_TIER,
    })
    expect(wire).not.toContain(SONNET)

    // The process-wide map the same turn's runtime was spawned with.
    const env = await resolveAgentModelEnv('ws-qa-481')
    expect(JSON.parse(env.AGENT_AUTO_TIER_MAP!)).toEqual(JSON.parse(wire))

    // `basic`/`advanced` follow the cloud too: a surface that never reads the
    // tier map must not land back on a local default.
    expect(env.AGENT_BASIC_MODEL).toBe(HOSHI_ID)
    expect(env.AGENT_ADVANCED_MODEL).toBe(HOSHI_ID)
  })

  test('a cloud id the local catalog has never seen is not swapped for a local one', async () => {
    // No mirrored model row: the desktop's catalog cannot judge the id.
    state.modelRows = []

    const run = await resolveAgentRunModelFor(null, 'ws-qa-481-unknown', 'user-1')

    expect(Object.values(run!.autoTiers!).map((t) => t.id)).toEqual([HOSHI_ID, HOSHI_ID, HOSHI_ID])
    expect(JSON.stringify(run!.autoTiers)).not.toContain(SONNET)
  })
})
