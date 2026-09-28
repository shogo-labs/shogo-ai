// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * POST /workspaces/:workspaceId/chat + /chat/stop — active-turn bookkeeping.
 *
 * Runs the real chat-turn-state service against an in-memory ChatSession
 * table. Covers workspace chats with and without an attached project: the
 * project-less case (a fresh personal companion) has no billing session,
 * but trackUsageFromStream still owns the stream, so the turn must stay
 * active until the stream completes rather than being cleared by the
 * route's early-exit guard.
 *
 *   bun test apps/api/src/routes/__tests__/workspace-chat-active-turn.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.SHOGO_CLOUD_SYNC

type SessionRow = {
  id: string
  contextId: string | null
  workspaceId: string | null
  projectWorkspaceId: string | null
  activeTurnId: string | null
  activeTurnStartedAt: Date | null
  activeTurnHeartbeatAt: Date | null
}

const sessions = new Map<string, SessionRow>()
const store = {
  attachedProjectIds: [] as string[],
  billingCalls: [] as Array<{ op: 'open' | 'close'; projectId: string }>,
  upgradeResult: null as string | null,
  upgradeCalls: [] as Array<[string, string]>,
  syncCalls: [] as Array<[string, string | undefined]>,
}

function matches(row: SessionRow, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Record<string, any>[]).some((branch) => matches(row, branch))
    if (key === 'project') return row.projectWorkspaceId !== null && row.projectWorkspaceId === value.workspaceId
    return (row as any)[key] === value
  })
}

function seedSession(id: string, overrides: Partial<SessionRow> = {}) {
  sessions.set(id, {
    id,
    contextId: null,
    workspaceId: 'ws-1',
    projectWorkspaceId: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    activeTurnHeartbeatAt: null,
    ...overrides,
  })
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
    },
    chatSession: {
      findUnique: async (args: any) => sessions.get(args?.where?.id) ?? null,
      update: async (args: any) => {
        const row = sessions.get(args.where.id)
        if (!row) throw new Error('Record to update not found')
        Object.assign(row, args.data)
        return row
      },
      updateMany: async (args: any) => {
        let count = 0
        for (const row of sessions.values()) {
          if (!matches(row, args.where)) continue
          Object.assign(row, args.data)
          count++
        }
        return { count }
      },
    },
    toolCallLog: {
      createMany: async (args: any) => ({ count: args?.data?.length ?? 0 }),
    },
    member: { findFirst: async () => ({ id: 'member-1' }) },
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
  openSession: async (projectId: string) => {
    store.billingCalls.push({ op: 'open', projectId })
  },
  closeSession: async (projectId: string) => {
    store.billingCalls.push({ op: 'close', projectId })
    return { billedUsd: 0 }
  },
  setQualitySignals: async () => {},
  hasSession: async () => false,
  hasActiveSession: async () => false,
  accumulateUsage: async () => false,
  accumulateImageUsage: async () => false,
}))

mock.module('../../services/git.service', () => ({
  isGitAvailable: () => false,
}))

mock.module('../../services/checkpoint.service', () => ({
  createCheckpoint: async () => ({ id: 'ck-1' }),
  createAutoCheckpoint: async () => ({ id: 'ck-1' }),
}))

mock.module('../../services/workspace-checkpoint.service', () => ({
  autoCheckpointWorkspaceProjects: async () => {},
}))

mock.module('../../services/workspace.service', () => ({
  getWorkspaceKind: async () => 'team',
  loadWorkspaceContext: async () => ({ hasAccess: true, kind: 'team' }),
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
  detachProject: async () => true,
  getAttachedProjects: async () =>
    store.attachedProjectIds.map((projectId) => ({ projectId, attachMode: 'readwrite' })),
  createWorkspaceSession: async () => ({ id: 's-1' }),
  listWorkspaceSessions: async () => [],
  getOrCreatePrimaryWorkspaceSession: async () => ({ id: 's-1' }),
  pinWorkspaceSessionToProject: async () => ({ pinned: false, changed: false }),
  unpinWorkspaceSession: async () => {},
  upgradeProjectSessionToWorkspace: async (workspaceId: string, sessionId: string) => {
    store.upgradeCalls.push([workspaceId, sessionId])
    return store.upgradeResult
  },
  WorkspaceSessionError: MockWorkspaceSessionError,
}))

mock.module('../../services/project-attachment.service', () => ({
  attachProjectToProject: async () => ({}),
  syncPinnedSessionAttachments: async (anchorProjectId: string, sessionId?: string) => {
    store.syncCalls.push([anchorProjectId, sessionId])
  },
}))

type FetchResponder = (url: string) => Response | Promise<Response>
let fetchResponder: FetchResponder | null = null
const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: any) => {
    if (!fetchResponder) throw new Error('No fetch responder configured')
    return fetchResponder(String(input))
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  sessions.clear()
  store.attachedProjectIds = []
  store.billingCalls = []
  store.upgradeResult = null
  store.upgradeCalls = []
  store.syncCalls = []
  fetchResponder = null
})

const { workspaceChatRoutes } = await import('../workspace-chat')

function buildApp() {
  const app = new Hono()
  app.route('/api', workspaceChatRoutes({
    resolveUserId: async () => 'user-1',
    runtimeManager: {} as any,
  }))
  return app
}

const encoder = new TextEncoder()

/** A runtime SSE response whose terminal frame is sent only when `finish()` runs. */
function controllableRuntimeStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      c.enqueue(encoder.encode('data: {"type":"text-delta","delta":"working"}\n'))
    },
  })
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    finish() {
      controller.enqueue(encoder.encode('data: {"type":"data-turn-complete","data":{"status":"completed"}}\n'))
      controller.close()
    },
  }
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

function sendChat(app: Hono, sessionId: string) {
  return app.fetch(new Request('http://x/api/workspaces/ws-1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': sessionId },
    body: JSON.stringify({ chatSessionId: sessionId }),
  }))
}

function sendStop(app: Hono, workspaceId: string, sessionId: string) {
  return app.fetch(new Request(`http://x/api/workspaces/${workspaceId}/chat/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatSessionId: sessionId }),
  }))
}

describe('workspace chat active turn', () => {
  for (const variant of [
    { name: 'without an attached project', attached: [] as string[] },
    { name: 'with an attached project', attached: ['p-1'] },
  ]) {
    test(`${variant.name}: stays active until the stream completes`, async () => {
      store.attachedProjectIds = variant.attached
      seedSession('s-1')
      const runtime = controllableRuntimeStream()
      fetchResponder = () => runtime.response
      const app = buildApp()

      const res = await sendChat(app, 's-1')
      expect(res.status).toBe(200)
      await tick()
      expect(sessions.get('s-1')!.activeTurnId).toEqual(expect.any(String))

      runtime.finish()
      await res.text()
      await tick()
      expect(sessions.get('s-1')!.activeTurnId).toBeNull()
      expect(store.billingCalls.filter((call) => call.op === 'close')).toHaveLength(variant.attached.length)
    })
  }

  test('a legacy project session is upgraded and re-attached before chatting', async () => {
    seedSession('s-legacy', { contextId: 'p-1' })
    store.upgradeResult = 'p-1'
    const runtime = controllableRuntimeStream()
    fetchResponder = () => runtime.response

    const res = await sendChat(buildApp(), 's-legacy')
    expect(res.status).toBe(200)
    expect(store.upgradeCalls).toEqual([['ws-1', 's-legacy']])
    expect(store.syncCalls).toEqual([['p-1', 's-legacy']])

    runtime.finish()
    await res.text()
  })

  test('an already-workspace session is not re-synced', async () => {
    seedSession('s-1')
    const runtime = controllableRuntimeStream()
    fetchResponder = () => runtime.response

    const res = await sendChat(buildApp(), 's-1')
    expect(res.status).toBe(200)
    expect(store.syncCalls).toEqual([])

    runtime.finish()
    await res.text()
  })

  test('a failed send does not clear another tab\'s live turn', async () => {
    const heartbeat = new Date()
    seedSession('s-1', { activeTurnId: 'other-tab-turn', activeTurnStartedAt: heartbeat, activeTurnHeartbeatAt: heartbeat })
    fetchResponder = () => new Response('bad request', { status: 400 })

    const res = await sendChat(buildApp(), 's-1')
    expect(res.status).toBe(400)
    await tick()
    expect(sessions.get('s-1')).toMatchObject({
      activeTurnId: 'other-tab-turn',
      activeTurnHeartbeatAt: heartbeat,
    })
  })

  test('a stop clears a workspace-scoped session in this workspace', async () => {
    seedSession('s-1', { activeTurnId: 'turn-1', activeTurnStartedAt: new Date() })
    fetchResponder = () => Response.json({ success: true })

    const res = await sendStop(buildApp(), 'ws-1', 's-1')
    expect(res.status).toBe(200)
    expect(sessions.get('s-1')!.activeTurnId).toBeNull()
  })

  test('a stop clears a project-pinned session whose project is in this workspace', async () => {
    seedSession('s-pinned', {
      contextId: 'p-1',
      workspaceId: null,
      projectWorkspaceId: 'ws-1',
      activeTurnId: 'turn-1',
      activeTurnStartedAt: new Date(),
    })
    fetchResponder = () => Response.json({ success: true })

    await sendStop(buildApp(), 'ws-1', 's-pinned')
    expect(sessions.get('s-pinned')!.activeTurnId).toBeNull()
  })

  test('a stop naming another workspace\'s session is a no-op', async () => {
    seedSession('s-foreign', { workspaceId: 'ws-other', activeTurnId: 'turn-foreign', activeTurnStartedAt: new Date() })
    seedSession('s-foreign-project', {
      contextId: 'p-other',
      workspaceId: null,
      projectWorkspaceId: 'ws-other',
      activeTurnId: 'turn-foreign-project',
      activeTurnStartedAt: new Date(),
    })
    fetchResponder = () => Response.json({ success: true })

    const app = buildApp()
    await sendStop(app, 'ws-1', 's-foreign')
    await sendStop(app, 'ws-1', 's-foreign-project')
    expect(sessions.get('s-foreign')!.activeTurnId).toBe('turn-foreign')
    expect(sessions.get('s-foreign-project')!.activeTurnId).toBe('turn-foreign-project')
  })

  test('a stop the runtime rejects leaves the turn active', async () => {
    seedSession('s-1', { activeTurnId: 'turn-1', activeTurnStartedAt: new Date() })
    fetchResponder = () => Response.json({ success: false }, { status: 500 })

    await sendStop(buildApp(), 'ws-1', 's-1')
    expect(sessions.get('s-1')!.activeTurnId).toBe('turn-1')
  })
})
