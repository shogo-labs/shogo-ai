// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-221 — a Personal-workspace chat is stamped with the caller's Team
 * workspace names, so the companion can say which workspace to switch to when
 * the user asks for an app. A Team-workspace chat never carries the field, and
 * a client-sent value is always overwritten.
 *
 *   bun test apps/api/src/routes/__tests__/workspace-chat-personal-team-workspaces.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.SHOGO_CLOUD_SYNC

const store = {
  userId: 'user-1' as string | null,
  kind: 'personal' as 'personal' | 'team',
  forwarded: [] as Array<Record<string, any>>,
  memberCalls: [] as Array<Record<string, any>>,
  memberRows: [] as Array<{ workspace: { name: string } | null }>,
  memberThrows: false,
}

mock.module('@shogo/model-catalog', () => ({
  getModelTier: (_modelId: string) => 'economy',
  resolveModelId: (mode: string) => mode || 'claude-haiku-4-5',
  MODEL_CATALOG: {},
  getModelEntry: (_id: string) => null,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelBillingModel: (id: string) => id,
  resolveAgentModeDefault: (mode: string) => mode,
  AUTO_MODEL_ID: 'auto',
  isAutoModel: (id: string) => id === 'auto',
  inferProviderFromModel: (_id: string, fallback: string) => fallback,
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
    chatMessage: { create: async (args: any) => ({ id: 'msg-1', ...args.data }) },
    chatSession: {
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    toolCallLog: { createMany: async () => ({ count: 0 }) },
    member: {
      findFirst: async () => ({ id: 'member-1' }),
      findMany: async (args: any) => {
        store.memberCalls.push(args)
        if (store.memberThrows) throw new Error('db down')
        return store.memberRows
      },
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
  store.kind = 'personal'
  store.forwarded = []
  store.memberCalls = []
  store.memberRows = [{ workspace: { name: 'Acme' } }, { workspace: { name: 'Side project' } }]
  store.memberThrows = false
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
    body: JSON.stringify({ chatSessionId: 's-1', message: 'build me an app', ...extra }),
  }))
}

describe('POST /workspaces/:workspaceId/chat — team workspace names', () => {
  test('a personal chat forwards the caller\'s team workspace names', async () => {
    const res = await sendChat(buildApp())
    expect(res.status).toBe(200)
    await res.text()
    expect(store.forwarded).toHaveLength(1)
    expect(store.forwarded[0].teamWorkspaceNames).toEqual(['Acme', 'Side project'])
    // Scoped to this caller's team workspaces only.
    expect(store.memberCalls[0].where).toMatchObject({ userId: 'user-1', projectId: null, workspace: { kind: 'team' } })
  })

  test('a client-sent value is overwritten, never trusted', async () => {
    const res = await sendChat(buildApp(), { teamWorkspaceNames: ['Evil Corp'] })
    expect(res.status).toBe(200)
    await res.text()
    expect(store.forwarded[0].teamWorkspaceNames).toEqual(['Acme', 'Side project'])
  })

  test('a personal chat with no team workspace forwards an empty list', async () => {
    store.memberRows = []
    const res = await sendChat(buildApp())
    await res.text()
    expect(store.forwarded[0].teamWorkspaceNames).toEqual([])
  })

  test('a failed lookup leaves the field off rather than failing the turn', async () => {
    store.memberThrows = true
    const res = await sendChat(buildApp())
    expect(res.status).toBe(200)
    await res.text()
    expect(store.forwarded[0]).not.toHaveProperty('teamWorkspaceNames')
  })

  test('a team-workspace chat never gets the field', async () => {
    store.kind = 'team'
    const res = await sendChat(buildApp(), { teamWorkspaceNames: ['Evil Corp'] })
    expect(res.status).toBe(200)
    await res.text()
    expect(store.forwarded[0]).not.toHaveProperty('teamWorkspaceNames')
    expect(store.memberCalls).toHaveLength(0)
  })
})
