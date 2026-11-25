// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-497 — a direct chat's per-message model pick is what the turn runs on.
 *
 * SHO-417's run-model step always started from `resolveAgentRunModel()`, the
 * *agent's configured* model, so every send replaced the person's `agentMode`
 * with the agent's model (usually `auto`) before the runtime ever saw it. These
 * tests pin the fixed rule on the real resolver chain:
 *
 *   - a request that names a model keeps it;
 *   - a request that names nothing still uses the agent's configured model
 *     (the channel-run path — `conversation-agent-dispatcher` passes no pick);
 *   - a pick above the person's grant is downgraded for the run, with the
 *     downgrade reported, and the pick itself is the one named as `from`;
 *   - in shadow mode the pick still runs (only an audit row is written);
 *   - a pick the local catalog cannot judge is passed through, not replaced
 *     (the SHO-481 rule for a cloud-connected desktop).
 *
 *   bun test apps/api/src/__tests__/agent-run-model-picked.test.ts
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const OPUS_ID = 'a1b2c3d4-0000-4000-8000-0000000000a1'
const HAIKU_ID = 'a1b2c3d4-0000-4000-8000-0000000000a2'
const SONNET_ID = 'a1b2c3d4-0000-4000-8000-0000000000a3'

const saved: Record<string, string | undefined> = {}
for (const key of ['SHOGO_LOCAL_MODE', 'SHOGO_API_KEY', 'SHOGO_CLOUD_URL', 'AI_MODE']) {
  saved[key] = process.env[key]
}
// Local, offline: the Auto tier map comes from this instance's own defaults, so
// nothing here depends on a cloud round-trip.
process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL
delete process.env.AI_MODE

const state = {
  role: 'owner' as string | null,
  policyRows: [] as any[],
  /** The agent's configured model (`AgentConfig.modelName`). */
  configuredModel: 'auto' as string | null,
}

function modelRow(id: string, tier: string, displayName: string, aliases: string[] = []) {
  return {
    id,
    provider: 'anthropic',
    providerId: null,
    apiModel: id,
    displayName,
    shortDisplayName: displayName,
    tier,
    family: 'claude',
    generation: 'current',
    kind: 'chat',
    maxOutputTokens: 8192,
    enabled: true,
    sortOrder: null,
    aliases,
    capabilities: {},
    description: null,
    contextWindow: 200000,
    reasoningEffort: null,
    inputPerMillion: 1,
    cachedInputPerMillion: 0,
    cacheWritePerMillion: 0,
    outputPerMillion: 1,
  }
}

/**
 * A slug the Opus row used to be keyed by, kept as an alias. Deliberately not a
 * static-catalog alias, so only the DB row can resolve it.
 */
const OPUS_LEGACY_SLUG = 'opus-4-5-legacy-slug'

const catalogRows = [
  modelRow(OPUS_ID, 'premium', 'Claude Opus 4.5', [OPUS_LEGACY_SLUG]),
  modelRow(SONNET_ID, 'standard', 'Claude Sonnet 4.6'),
  modelRow(HAIKU_ID, 'economy', 'Claude Haiku 4.5'),
]

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    agentConfig: {
      findUnique: async () =>
        state.configuredModel === null ? null : { modelName: state.configuredModel },
    },
    member: { findFirst: async () => (state.role ? { role: state.role } : null) },
    userGroupMember: { findMany: async () => [] },
    accessPolicy: { findMany: async () => state.policyRows },
    workspaceModelVisibility: { findMany: async () => [] },
    workspaceAgentProfile: { findUnique: async () => ({ defaultModel: null }) },
    platformSetting: { findUnique: async () => null },
    modelProvider: { findMany: async () => [] },
    modelDefinition: {
      findMany: async () => (state.configuredModel === 'no-catalog' ? [] : catalogRows),
    },
    accessAuditEvent: { create: async () => ({}) },
  },
}))

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => new Response('{}', { status: 404 })) as any

const { resolveAgentRunModelFor } = await import('../services/agent-run-model.service')
const { invalidateModelRegistry } = await import('../services/model-registry.service')
const { _resetAgentModelDefaultsCache } = await import('../lib/federated-upstream')
const { __clearAccessCache, accessModelCatalog } = await import('../services/access-policy.service')
const { _setRbacModeForTests } = await import('../lib/authz/mode')

// The registry snapshot is what `accessModelCatalog()` reads, so it has to be
// reloaded per test (and once up front so the first test sees the rows).
await invalidateModelRegistry()

beforeEach(async () => {
  state.role = 'owner'
  state.policyRows = []
  state.configuredModel = 'auto'
  _setRbacModeForTests('on')
  _resetAgentModelDefaultsCache()
  __clearAccessCache()
  await invalidateModelRegistry()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  _setRbacModeForTests(null)
  _resetAgentModelDefaultsCache()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('SHO-497 — the pick is what a direct chat runs on', () => {
  test('AC1: a named model is kept, not replaced by the agent configured model', async () => {
    // The agent itself is on Auto; the person picked Opus for this message.
    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-1', OPUS_ID)

    expect(run?.model).toBe(OPUS_ID)
    expect(run?.downgrade).toBeNull()
    expect(run?.autoTiers).toBeNull()
  })

  test('AC3: the pick survives an id the agent config could never hold', async () => {
    // A non-Auto agent model must not leak in either: the pick still wins.
    state.configuredModel = SONNET_ID

    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-1', HAIKU_ID)

    expect(run?.model).toBe(HAIKU_ID)
  })

  test('AC4: no pick (a channel run) still uses the agent configured model', async () => {
    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-1')

    expect(run?.model).toBe('auto')
    expect(run?.autoTiers).not.toBeNull()
  })

  test('AC4: a channel run on a pinned model keeps that model', async () => {
    state.configuredModel = SONNET_ID

    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-1')

    expect(run?.model).toBe(SONNET_ID)
  })

  test('AC3: a pick above the role grant is downgraded for this run, and says so', async () => {
    // A member whose role policy grants economy only.
    state.role = 'member'
    state.policyRows = [{
      subjectType: 'role',
      subjectId: 'member',
      abilities: null,
      modelTiers: ['economy'],
      modelIds: null,
    }]

    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-2', OPUS_ID)

    const economyIds = accessModelCatalog().filter((m) => m.tier === 'economy').map((m) => m.id)
    // The run falls back to their default (an economy model) and the reply is
    // told which pick caused it, so AC5 keeps holding for a pick.
    expect(economyIds).toContain(run!.model)
    expect(run?.downgrade?.from).toBe(OPUS_ID)
    expect(run?.downgrade?.fromLabel).toBe('Claude Opus 4.5')
    expect(run?.downgrade?.to).toBe(run!.model)
  })

  test('AC3: the same pick runs untouched in shadow mode (audit only)', async () => {
    state.role = 'member'
    state.policyRows = [{
      subjectType: 'role',
      subjectId: 'member',
      abilities: null,
      modelTiers: ['economy'],
      modelIds: null,
    }]
    _setRbacModeForTests('shadow')

    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-2', OPUS_ID)

    expect(run?.model).toBe(OPUS_ID)
    expect(run?.downgrade).toBeNull()
  })

  test('a pick on Auto still gets the person-narrowed tier map', async () => {
    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-1', 'auto')

    expect(run?.model).toBe('auto')
    expect(run?.autoTiers).not.toBeNull()
    expect(Object.values(run!.autoTiers!).every((entry) => typeof entry.id === 'string')).toBe(true)
  })

  test('an alias of a granted model runs as that model, not reset', async () => {
    // The registry resolves DB aliases, so a pick saved as an old slug runs on
    // the model it names — and the id the proxy understands is what is
    // forwarded.
    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-1', OPUS_LEGACY_SLUG)

    expect(run?.model).toBe(OPUS_ID)
    expect(run?.downgrade).toBeNull()
  })

  test('an alias of a model above the grant is downgraded, named by the alias', async () => {
    state.role = 'member'
    state.policyRows = [{
      subjectType: 'role',
      subjectId: 'member',
      abilities: null,
      modelTiers: ['economy'],
      modelIds: null,
    }]

    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-2', OPUS_LEGACY_SLUG)

    // The grant check ran on the canonical model, so the reply names the model
    // the person picked (`from` is its id, labelled), not the raw slug.
    expect(run?.downgrade?.from).toBe(OPUS_ID)
    expect(run?.downgrade?.fromLabel).toBe('Claude Opus 4.5')
    expect(run?.model).not.toBe(OPUS_LEGACY_SLUG)
  })

  test('a pick this catalog cannot judge is passed through (SHO-481)', async () => {
    // A cloud-connected desktop: the picker is the cloud's list, and a cloud
    // model id may not be mirrored locally yet. Replacing it with the person's
    // local default would silently run a different model than the one picked.
    const run = await resolveAgentRunModelFor('p-1', 'ws-1', 'user-1', 'cloud-only-model')

    expect(run?.model).toBe('cloud-only-model')
    expect(run?.downgrade).toBeNull()
  })
})
