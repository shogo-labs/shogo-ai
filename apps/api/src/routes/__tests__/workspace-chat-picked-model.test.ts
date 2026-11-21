// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-497, workspace-chat leg — the pick a person sends with a message is the
 * model the workspace turn starts on, and it is what their own message row
 * records.
 *
 * Before the fix the route asked `resolveAgentRunModelFor` about the *agent's*
 * configured model only, so every send replaced the body's `agentMode` with the
 * workspace agent's model and the composer adopted that stamp. These tests pin
 * the wiring on the real route (the rule itself is covered in
 * `agent-run-model-picked.test.ts`):
 *
 *   - the body's `agentMode` reaches the run-model step, and its answer is what
 *     is forwarded to the runtime;
 *   - the user row is written with the *pick*, not the model that ran;
 *   - a body with no pick still falls back to the agent's model;
 *   - a personal companion is exempt — its model is a platform-wide choice
 *     (AC4 keeps that behaviour).
 *
 *   bun test apps/api/src/routes/__tests__/workspace-chat-picked-model.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.SHOGO_CLOUD_SYNC

const OPUS_ID = '11111111-2222-3333-4444-555555555555'

const store = {
  userId: 'user-1' as string | null,
  kind: 'team' as 'personal' | 'team',
  forwarded: [] as Array<Record<string, any>>,
  runModelCalls: [] as Array<{ requested: string | null | undefined }>,
  userRows: [] as Array<{ sessionId: string; model?: string | null }>,
  /** What the run-model step answers (the fixed service's rule by default). */
  runModelAnswer: (_requested: string | null | undefined) => ({
    model: OPUS_ID,
    downgrade: null,
    autoTiers: null,
  }) as any,
}

mock.module('@shogo/model-catalog', () => ({
  getModelTier: (_modelId: string) => 'economy',
  resolveModelId: (mode: string) => mode || 'claude-haiku-4-5',
  MODEL_CATALOG: {},
  getModelEntry: (_id: string) => null,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelDollarCosts: (_m: string, _at?: Date) => ({ inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, cacheWritePerMillion: 0 }),
  getModelBillingModel: (id: string) => id,
  resolveAgentModeDefault: (mode: string) => mode,
  AUTO_MODEL_ID: 'auto',
  isAutoModel: (id: string) => id === 'auto',
  inferProviderFromModel: (_id: string, fallback: string) => fallback,
  getAgentModeOverrides: () => ({}),
  getAutoTierOverrides: () => ({}),
}))

mock.module('../../services/agent-run-model.service', () => ({
  AUTO_MODEL_ID: 'auto',
  resolveAgentRunModelFor: async (
    _projectId: string | null,
    _workspaceId: string | undefined,
    _userId: string | null | undefined,
    requested?: string | null,
  ) => {
    store.runModelCalls.push({ requested })
    return store.runModelAnswer(requested)
  },
  resolveAgentRunModel: async () => 'auto',
  resolveAgentRunModelLabel: async () => ({ id: 'auto', label: 'Auto' }),
}))

// The row writer is asserted directly: the pick is what a user row records.
mock.module('../../services/chat-user-message', () => ({
  persistUserMessageForTurn: async (
    sessionId: string,
    _body: Record<string, unknown>,
    options: { model?: string | null } = {},
  ) => {
    store.userRows.push({ sessionId, model: options.model ?? null })
    return { id: 'u-1', created: true }
  },
}))

mock.module('../../services/cost-analytics.service', () => ({
  recordAgentCostMetric: async () => {},
  getAgentCostBreakdown: async () => [],
  getCostRecommendations: async () => [],
  getBudgetAlerts: async () => [],
  checkBudgetAlerts: async () => [],
  getActiveThrottleModel: async () => null,
  getCostTrends: async () => [],
  deriveActiveThrottleModel: () => null,
  isCostPeriod: () => false,
  isBudgetPeriod: () => false,
  VALID_COST_PERIODS: ['7d', '30d', '90d', '1y'],
  VALID_BUDGET_PERIODS: ['daily', 'weekly', 'monthly'],
}))

mock.module('../../lib/prisma', () => ({
  InstanceKind: { desktop: 'desktop', cli_worker: 'cli_worker' },
  prisma: {
    project: {
      findUnique: async () => ({ id: 'p-1', name: 'Project', workspaceId: 'ws-1', settings: null }),
      update: async () => ({}),
    },
    projectFolder: { findMany: async () => [] },
    chatMessage: {
      create: async (args: any) => ({ id: 'msg-1', ...args.data }),
      findUnique: async () => null,
    },
    chatSession: {
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    toolCallLog: { createMany: async () => ({ count: 0 }) },
    chatTurnFrame: { create: async () => ({}) },
    member: {
      findFirst: async () => ({ id: 'member-1', role: 'owner' }),
      findMany: async () => [],
    },
    mobilePushSubscription: { findMany: async () => [] },
  },
}))

mock.module('../../services/billing-runtime', () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: () => ({ code: 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async () => ({ success: true }),
  hasBalance: async () => true,
  hasPaidSubscription: async () => true,
  getAlwaysOnAllowanceForWorkspace: async () => null,
}))

mock.module('../../lib/proxy-billing-session-runtime', () => ({
  openSession: async () => {},
  closeSession: async () => ({ billedUsd: 0 }),
  setQualitySignals: async () => {},
  hasSession: async () => false,
  hasActiveSession: async () => false,
  accumulateUsage: async () => false,
  accumulateImageUsage: async () => false,
  recordTurnUsage: async () => ({ billedUsd: 0, rawUsd: 0, totalTokens: 0 }),
}))

mock.module('../../services/git.service', () => ({ isGitAvailable: () => false }))

mock.module('../../services/checkpoint.service', () => ({
  createCheckpoint: async () => ({ id: 'ck-1' }),
  createAutoCheckpoint: async () => ({ id: 'ck-1' }),
}))

mock.module('../../services/workspace-checkpoint.service', () => ({
  autoCheckpointWorkspaceProjects: async () => {},
}))

mock.module('../../services/workspace.service', () => ({
  getWorkspaceKind: async () => store.kind,
  loadWorkspaceContext: async () => ({ hasAccess: true, kind: store.kind }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

mock.module('../../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async () => ({ url: 'http://ws-runtime.local', mode: 'pod' }),
  }
})

mock.module('../../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: () => 'mock-workspace-runtime-token',
}))

mock.module('../../lib/project-user-context', () => ({
  setProjectUser: () => {},
  getProjectUser: () => null,
  getProjectOwnerUserId: async () => 'user-1',
  getWorkspaceOwnerUserId: async () => 'user-1',
}))

class MockWorkspaceSessionError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

mock.module('../../services/workspace-session.service', () => ({
  attachProject: async () => ({ attachMode: 'readwrite' }),
  assertWorkspaceSessionInWorkspace: async () => {},
  assertWorkspaceSessionAccess: async () => {},
  detachProject: async () => true,
  getAttachedProjects: async () => [],
  createWorkspaceSession: async () => ({ id: 's-1' }),
  listWorkspaceSessions: async () => [],
  getOrCreateDefaultWorkspaceSession: async () => ({ id: 's-1' }),
  pinWorkspaceSessionToProject: async () => ({ pinned: false, changed: false }),
  unpinWorkspaceSession: async () => {},
  upgradeProjectSessionToWorkspace: async () => null,
  WorkspaceSessionError: MockWorkspaceSessionError,
}))

mock.module('../../services/project-attachment.service', () => ({
  attachProjectToProject: async () => ({}),
  getAnchorLocalFolders: async () => [] as string[],
  syncPinnedSessionAttachments: async () => {},
}))

const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    store.forwarded.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(
      'data: {"type":"data-turn-complete","data":{"status":"completed"}}\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  store.userId = 'user-1'
  store.kind = 'team'
  store.forwarded = []
  store.runModelCalls = []
  store.userRows = []
  store.runModelAnswer = (requested) => ({ model: requested ?? 'auto', downgrade: null, autoTiers: null })
})

const { workspaceChatRoutes } = await import('../workspace-chat')

function buildApp() {
  const app = new Hono()
  app.route('/api', workspaceChatRoutes({
    resolveUserId: async () => store.userId,
    runtimeManager: {} as any,
  }))
  return app
}

function sendChat(app: Hono, extra: Record<string, unknown> = {}) {
  return app.fetch(new Request('http://x/api/workspaces/ws-1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': 's-1' },
    body: JSON.stringify({ chatSessionId: 's-1', message: 'hi', ...extra }),
  }))
}

describe('POST /workspaces/:workspaceId/chat — the picked model (SHO-497)', () => {
  test('AC1: the pick is what runs, and the user row records the pick', async () => {
    const app = buildApp()
    const res = await sendChat(app, { agentMode: OPUS_ID, messageId: 'u-1' })

    expect(res.status).toBe(200)
    await res.text()

    // The run-model step is asked about the pick …
    expect(store.runModelCalls).toEqual([{ requested: OPUS_ID }])
    // … and its answer is what the runtime is told to run.
    expect(store.forwarded).toHaveLength(1)
    expect(store.forwarded[0].agentMode).toBe(OPUS_ID)
    expect(store.forwarded[0].modelProvider).toBeUndefined()
    expect(store.userRows).toEqual([{ sessionId: 's-1', model: OPUS_ID }])
  })

  test('AC3: a downgraded run forwards the run model but still records the pick', async () => {
    store.runModelAnswer = () => ({
      model: 'auto',
      downgrade: { from: OPUS_ID, to: 'auto', fromLabel: 'Claude Opus 4.5' },
      autoTiers: null,
    })
    const app = buildApp()
    const res = await sendChat(app, { agentMode: OPUS_ID, messageId: 'u-1' })

    expect(res.status).toBe(200)
    await res.text()

    expect(store.forwarded[0].agentMode).toBe('auto')
    expect(store.forwarded[0].modelDowngrade).toEqual({
      from: OPUS_ID,
      to: 'auto',
      fromLabel: 'Claude Opus 4.5',
    })
    // The composer reads user rows, so the downgrade cannot rewrite the picker.
    expect(store.userRows).toEqual([{ sessionId: 's-1', model: OPUS_ID }])
  })

  test('AC4: no pick falls back to the agent model and records nothing', async () => {
    store.runModelAnswer = () => ({ model: 'auto', downgrade: null, autoTiers: null })
    const app = buildApp()
    const res = await sendChat(app, { messageId: 'u-1' })

    expect(res.status).toBe(200)
    await res.text()

    expect(store.runModelCalls).toEqual([{ requested: undefined }])
    expect(store.forwarded[0].agentMode).toBe('auto')
    expect(store.userRows).toEqual([{ sessionId: 's-1', model: null }])
  })

  test('a personal companion keeps its platform model (the picker is hidden there)', async () => {
    store.kind = 'personal'
    const app = buildApp()
    const res = await sendChat(app, { agentMode: OPUS_ID })

    expect(res.status).toBe(200)
    await res.text()

    expect(store.runModelCalls).toHaveLength(0)
    expect(store.forwarded[0].agentMode).not.toBe(OPUS_ID)
  })
})
