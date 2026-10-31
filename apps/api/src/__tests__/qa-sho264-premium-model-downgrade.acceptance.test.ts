// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-264 acceptance — a premium model a plan cannot run must never reach the
 * AI proxy from a turn that carries no explicit `agentMode`.
 *
 * The measured failure (prod, 24h to 2026-10-30): 31 `main-chat-failed` rows,
 * all zero-token, all `claude-sonnet-5`, in workspaces without advanced model
 * access. A stored `AgentConfig.modelName` outlived a plan downgrade, the
 * runtime read it back out of `config.json`, the proxy answered
 * `403 model_tier_restricted`, and `retry-classifier` called that non-retryable
 * `auth` so the turn ended having generated nothing.
 *
 * The dev's unit test pins `capAgentModelToPlan` and `readProjectConfig` in
 * isolation. This one pins the two seams the failure actually crossed:
 *   1. `resolveAgentRunModel` — the per-run resolution the chat routes and the
 *      profile card ask for (both the project path and the workspace-agent
 *      path), and
 *   2. the API snapshot → `config.json` merge the runtime performs
 *      (`mergeAgentModelIntoConfig`), proving the concrete premium id is gone
 *      before a main-chat turn can resolve it.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { mergeAgentModelIntoConfig } from '@shogo/agent-runtime/src/agent-model-config'

// ─── Entitlement ─────────────────────────────────────────────────────────────
// One switch stands in for the plan everywhere `isModelAccessibleForWorkspace`
// is consulted.
let advancedAccess = true
const accessibilityCalls: Array<{ workspaceId: string; modelId: string }> = []

mock.module('../lib/model-access', () => ({
  isModelAccessibleForWorkspace: async (workspaceId: string, modelId: string) => {
    accessibilityCalls.push({ workspaceId, modelId })
    return advancedAccess
  },
}))

// ─── Store ───────────────────────────────────────────────────────────────────
// `bun:test`'s `mock.module()` is process-global and last-call-wins, so both
// services under test share this one prisma stub: `readProjectConfig` reads
// whole project + agent rows, `resolveAgentRunModel` reads only `modelName`.
let workspaceDefaultModel: string | null = null
const storedProjectModel = new Map<string, string | null>()
const projects = new Map<string, any>()
const agentConfigs = new Map<string, any>()

mock.module('../lib/prisma', () => ({
  prisma: {
    agentConfig: {
      findUnique: async ({ where }: { where: { projectId: string } }) =>
        agentConfigs.get(where.projectId) ??
        (storedProjectModel.has(where.projectId) ? { modelName: storedProjectModel.get(where.projectId) } : null),
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
    },
  },
}))

// ─── agent-run-model.service deps ────────────────────────────────────────────
mock.module('../services/workspace-agent.service', () => ({
  getAgentDefaultModel: async () => workspaceDefaultModel,
}))

mock.module('../services/workspace-models.service', () => ({
  isModelVisibleForWorkspace: async () => true,
}))

mock.module('../services/model-registry.service', () => ({
  getMergedModelEntrySync: (id: string) => (id ? { id, displayName: id } : undefined),
  resolveModelLabel: async (id: string) => id,
}))

// ─── readProjectConfig deps ──────────────────────────────────────────────────
mock.module('../generated/project.hooks', () => ({
  projectHooks: { beforeCreate: async () => ({ ok: true }), afterCreate: async () => {} },
}))
mock.module('../services/tool-usage.service', () => ({
  readProjectToolUsage: async () => ({ totalCalls: 0, tools: [] }),
}))

const { resolveAgentRunModel } = await import('../services/agent-run-model.service')
const { readProjectConfig } = await import('../services/project-lifecycle.service')

const PREMIUM = 'claude-sonnet-5'

const AGENT_ROW = {
  heartbeatEnabled: false,
  heartbeatInterval: 1800,
  modelProvider: 'anthropic',
  modelName: PREMIUM,
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTimezone: null,
  nextHeartbeatAt: null,
  lastHeartbeatAt: null,
}

function seedProject(id: string, workspaceId: string) {
  projects.set(id, {
    id,
    workspaceId,
    name: id,
    description: null,
    settings: {},
    slackEnabled: false,
    workingMode: 'managed',
  })
  agentConfigs.set(id, { projectId: id, ...AGENT_ROW })
}

beforeEach(() => {
  advancedAccess = true
  workspaceDefaultModel = null
  accessibilityCalls.length = 0
  storedProjectModel.clear()
  projects.clear()
  agentConfigs.clear()
})

describe('resolveAgentRunModel — a downgraded workspace never resolves the premium id', () => {
  it('falls back to auto when the stored project model is out of plan', async () => {
    advancedAccess = false
    storedProjectModel.set('proj_1', PREMIUM)

    expect(await resolveAgentRunModel('proj_1', 'ws_free')).toBe('auto')
    expect(accessibilityCalls).toEqual([{ workspaceId: 'ws_free', modelId: PREMIUM }])
  })

  it('keeps the stored project model while the plan can run it', async () => {
    storedProjectModel.set('proj_1', PREMIUM)
    expect(await resolveAgentRunModel('proj_1', 'ws_pro')).toBe(PREMIUM)
  })

  it('caps the workspace agent default on the same rule', async () => {
    advancedAccess = false
    workspaceDefaultModel = PREMIUM

    expect(await resolveAgentRunModel(null, 'ws_free')).toBe('auto')
  })

  it('keeps the workspace agent default while the plan can run it', async () => {
    workspaceDefaultModel = PREMIUM
    expect(await resolveAgentRunModel(null, 'ws_pro')).toBe(PREMIUM)
  })
})

describe('the API snapshot the runtime caches cannot carry the 403-bound model', () => {
  it('serves auto, and auto survives the merge into config.json', async () => {
    advancedAccess = false
    seedProject('proj_1', 'ws_free')

    const config = await readProjectConfig('proj_1')
    // What the internal-runtime route returns to the runtime:
    expect(config.agent?.modelName).toBe('auto')

    // And what the runtime writes into config.json for turns with no agentMode:
    const merged = mergeAgentModelIntoConfig({ model: { provider: 'anthropic', name: 'auto' } }, config.agent)
    expect(merged.config.model.name).toBe('auto')
    expect(JSON.stringify(merged.config)).not.toContain(PREMIUM)
  })

  it('leaves an entitled workspace on the model the person picked', async () => {
    seedProject('proj_1', 'ws_pro')

    const config = await readProjectConfig('proj_1')
    expect(config.agent?.modelName).toBe(PREMIUM)

    const merged = mergeAgentModelIntoConfig({ model: { provider: 'anthropic', name: 'auto' } }, config.agent)
    expect(merged.config.model.name).toBe(PREMIUM)
  })
})
