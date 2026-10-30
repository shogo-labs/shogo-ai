// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-264: a project's stored model must be capped to what its workspace's plan
 * can actually run before the runtime caches it into `config.json`.
 *
 * Measured on prod (24h to 2026-10-30): 31 `main-chat-failed` rows, 100% of them
 * zero-token turns on `claude-sonnet-5` in workspaces without advanced model
 * access (113 runs / 26 workspaces over 6 days). The runtime resolves turns that
 * carry no `agentMode` from `config.json`, so the stored premium pick reached the
 * AI proxy, came back `403 model_tier_restricted`, classified non-retryable
 * `auth`, and the user saw "The model provider rejected the request" with nothing
 * generated.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

let accessible = true
const accessibilityCalls: Array<{ workspaceId: string; modelId: string }> = []

mock.module('../lib/model-access', () => ({
  isModelAccessibleForWorkspace: async (workspaceId: string, modelId: string) => {
    accessibilityCalls.push({ workspaceId, modelId })
    return accessible
  },
}))

mock.module('../generated/project.hooks', () => ({
  projectHooks: { beforeCreate: async () => ({ ok: true }), afterCreate: async () => {} },
}))

mock.module('../services/tool-usage.service', () => ({
  readProjectToolUsage: async () => ({ totalCalls: 0, tools: [] }),
}))

const projects = new Map<string, any>()
const agentConfigs = new Map<string, any>()

const prismaStub = {
  workspace: { findUnique: async () => ({ kind: 'team' }) },
  project: {
    findUnique: async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
  },
  agentConfig: {
    findUnique: async ({ where }: { where: { projectId: string } }) => agentConfigs.get(where.projectId) ?? null,
  },
}

mock.module('../lib/prisma', () =>
  require('./helpers/prisma-mock-exports').withPrismaExports({ prisma: prismaStub }),
)

const { capAgentModelToPlan, readProjectConfig } = await import('../services/project-lifecycle.service')

const AGENT = {
  heartbeatEnabled: false,
  heartbeatInterval: 1800,
  modelProvider: 'anthropic',
  modelName: 'claude-sonnet-5',
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTimezone: null,
  nextHeartbeatAt: null,
  lastHeartbeatAt: null,
}

beforeEach(() => {
  projects.clear()
  agentConfigs.clear()
  accessibilityCalls.length = 0
  accessible = true
})

describe('capAgentModelToPlan', () => {
  it('downgrades a premium model the plan cannot run to auto', async () => {
    accessible = false
    const capped = await capAgentModelToPlan('ws_free', { ...AGENT })
    expect(capped?.modelName).toBe('auto')
    expect(capped?.modelProvider).toBe('auto')
    expect(accessibilityCalls).toEqual([{ workspaceId: 'ws_free', modelId: 'claude-sonnet-5' }])
  })

  it('keeps an accessible model untouched', async () => {
    const capped = await capAgentModelToPlan('ws_pro', { ...AGENT })
    expect(capped?.modelName).toBe('claude-sonnet-5')
    expect(capped?.modelProvider).toBe('anthropic')
  })

  it('never probes entitlement for auto', async () => {
    const capped = await capAgentModelToPlan('ws_free', { ...AGENT, modelName: 'auto' })
    expect(capped?.modelName).toBe('auto')
    expect(accessibilityCalls).toHaveLength(0)
  })

  it('passes a missing agent row straight through', async () => {
    expect(await capAgentModelToPlan('ws_free', null)).toBeNull()
    expect(accessibilityCalls).toHaveLength(0)
  })

  it('leaves the other agent fields alone', async () => {
    accessible = false
    const capped = await capAgentModelToPlan('ws_free', { ...AGENT })
    expect(capped?.heartbeatInterval).toBe(1800)
    expect(capped?.quietHoursStart).toBeNull()
  })
})

describe('readProjectConfig', () => {
  it('serves the runtime a capped model instead of a 403-bound one', async () => {
    accessible = false
    projects.set('proj_1', {
      id: 'proj_1',
      workspaceId: 'ws_free',
      name: 'Free project',
      description: null,
      settings: {},
      slackEnabled: false,
      workingMode: 'managed',
    })
    agentConfigs.set('proj_1', { projectId: 'proj_1', ...AGENT })

    const config = await readProjectConfig('proj_1')
    expect(config.agent?.modelName).toBe('auto')
    expect(config.agent?.modelProvider).toBe('auto')
  })
})
