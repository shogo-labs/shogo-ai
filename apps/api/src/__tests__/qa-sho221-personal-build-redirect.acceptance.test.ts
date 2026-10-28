// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-221 acceptance — a Personal workspace turns "build me an app" into
 * "building happens in your Team workspace, switch there".
 *
 * Each half of this has its own test and both can stay green while the pair is
 * broken: `routes/__tests__/workspace-chat-personal-team-workspaces.test.ts`
 * only inspects the body the API forwards, and the runtime's
 * `personal-companion-no-build.test.ts` only builds a prompt from a hand-made
 * context. QA round 1 on this card found exactly that gap — the API stamped
 * `teamWorkspaceNames` and the prompt builder rendered it, but the gateway
 * dropped it in between, so a real Personal turn never named the workspace.
 * This test feeds the route's REAL forwarded body through the runtime's REAL
 * parser and prompt builder and asserts what the turn actually reads.
 *
 * The gateway itself is not imported here: `packages/agent-runtime/src/gateway.ts`
 * pulls a module graph that `apps/api`'s test preload cannot resolve from source
 * (`TECH_STACK_REGISTRY`), so the gateway hop is covered where it can be —
 * `packages/agent-runtime/src/__tests__/personal-companion-no-build.test.ts`.
 *
 *   bun test src/__tests__/qa-sho221-personal-build-redirect.acceptance.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.SHOGO_CLOUD_SYNC

const store = {
  userId: 'user-1' as string | null,
  kind: 'personal' as 'personal' | 'team',
  forwarded: [] as Array<Record<string, any>>,
  memberRows: [] as Array<{ workspace: { name: string } | null }>,
}

// Spread the real catalog: a partial factory breaks every other named import
// the runtime pulls through this module.
const actualCatalog = await import('@shogo/model-catalog')
mock.module('@shogo/model-catalog', () => ({
  ...actualCatalog,
  getModelTier: (_modelId: string) => 'economy',
  resolveModelId: (mode: string) => mode || 'claude-haiku-4-5',
  calculateDollarCost: () => 0,
  resolveAgentModeDefault: (mode: string) => mode,
  inferProviderFromModel: (_id: string, fallback: string) => fallback,
}))

mock.module('../services/cost-analytics.service', () => ({
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

mock.module('../lib/prisma', () => ({
  InstanceKind: { desktop: 'desktop', cli_worker: 'cli_worker' },
  prisma: {
    project: {
      findUnique: async () => ({ id: 'p-1', name: 'Project', workspaceId: 'ws-1', settings: null }),
      update: async () => ({}),
      create: async () => {
        throw new Error('SHO-221: a Personal turn must never create a project')
      },
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
      findMany: async () => store.memberRows,
    },
    mobilePushSubscription: { findMany: async () => [] },
  },
}))

mock.module('../services/billing-runtime', () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: () => ({ code: 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async () => ({ success: true }),
  hasBalance: async () => true,
}))

mock.module('../lib/proxy-billing-session-runtime', () => ({
  openSession: async () => {},
  closeSession: async () => ({ billedUsd: 0 }),
  setQualitySignals: async () => {},
  hasSession: async () => false,
  hasActiveSession: async () => false,
  accumulateUsage: async () => false,
  accumulateImageUsage: async () => false,
  recordTurnUsage: async () => ({ billedUsd: 0, rawUsd: 0, totalTokens: 0 }),
}))

mock.module('../services/git.service', () => ({ isGitAvailable: () => false }))

mock.module('../services/checkpoint.service', () => ({
  createCheckpoint: async () => ({ id: 'ck-1' }),
  createAutoCheckpoint: async () => ({ id: 'ck-1' }),
}))

mock.module('../services/workspace-checkpoint.service', () => ({
  autoCheckpointWorkspaceProjects: async () => {},
}))

mock.module('../services/workspace.service', () => ({
  getWorkspaceKind: async () => store.kind,
  loadWorkspaceContext: async () => ({ hasAccess: true, kind: store.kind }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

mock.module('../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async () => ({ url: 'http://ws-runtime.local', mode: 'pod' }),
  }
})

mock.module('../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: () => 'mock-workspace-runtime-token',
}))

mock.module('../lib/project-user-context', () => ({
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

mock.module('../services/workspace-session.service', () => ({
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

mock.module('../services/project-attachment.service', () => ({
  attachProjectToProject: async () => ({}),
  getAnchorLocalFolders: async () => [] as string[],
  syncPinnedSessionAttachments: async () => {},
}))

const { workspaceChatRoutes } = await import('../routes/workspace-chat')
const { parseAccountContext, buildAccountContextPrompt } = await import(
  '../../../../packages/agent-runtime/src/account-context'
)
const { disabledToolNamesForProfile } = await import(
  '../../../../packages/agent-runtime/src/capability-profiles'
)

const PROJECT_TOOLS = [
  'project_create',
  'project_call',
  'project_configure',
  'project_list',
  'connect_project',
  'copy_to_project',
]

const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    store.forwarded.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response('data: {"type":"data-turn-complete","data":{"status":"completed"}}\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  store.userId = 'user-1'
  store.kind = 'personal'
  store.forwarded = []
  store.memberRows = [{ workspace: { name: 'Acme' } }, { workspace: { name: 'Side project' } }]
})

function buildApp() {
  const app = new Hono()
  app.route('/api', workspaceChatRoutes({
    resolveUserId: async () => store.userId,
    runtimeManager: {} as any,
  }))
  return app
}

/** Alan's actual turn: a Personal workspace, "build me an app". */
async function askForAnApp(extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const app = buildApp()
  const res = await app.fetch(new Request('http://x/api/workspaces/ws-1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': 's-1' },
    body: JSON.stringify({
      chatSessionId: 's-1',
      message: 'build me an app to manage my YouTube playlists',
      ...extra,
    }),
  }))
  expect(res.status).toBe(200)
  await res.text()
  expect(store.forwarded).toHaveLength(1)
  return store.forwarded[0]
}

/** What the runtime reads off that body when it assembles the turn. */
function accountBlock(forwarded: Record<string, any>): string {
  return buildAccountContextPrompt(parseAccountContext(forwarded)) ?? ''
}

describe('SHO-221 — asking for an app in a Personal workspace', () => {
  test('the turn the runtime receives names the Team workspace to switch to', async () => {
    const block = accountBlock(await askForAnApp())

    expect(block).toContain('**Acme**')
    expect(block).toContain('**Side project**')
    // It has to say where the software work happens, and that this is not it.
    expect(block).toContain('Team workspace')
    expect(block).toContain('switch to')
    expect(block).toContain('not in this Personal workspace')
  })

  test('a client-sent workspace name never reaches the prompt', async () => {
    const block = accountBlock(await askForAnApp({ teamWorkspaceNames: ['Evil Corp'] }))

    expect(block).toContain('**Acme**')
    expect(block).not.toContain('Evil Corp')
  })

  test('the personal agent has no project tool, so no hidden build can start', () => {
    // The capability-level guarantee: the tools are absent, not refused.
    const disabled = disabledToolNamesForProfile('personal')
    for (const tool of PROJECT_TOOLS) {
      expect(disabled.has(tool)).toBe(true)
    }
  })

  test('a user with no Team workspace yet is told how to make one, not left guessing', async () => {
    store.memberRows = []
    const block = accountBlock(await askForAnApp())

    expect(block).toContain('no Team workspace yet')
    expect(block.toLowerCase()).toContain('workspace switcher')
  })

  test('a Team-workspace chat is untouched: no redirect line, and every project tool present', async () => {
    store.kind = 'team'
    store.memberRows = []
    const forwarded = await askForAnApp({ teamWorkspaceNames: ['Evil Corp'] })

    expect(forwarded).not.toHaveProperty('teamWorkspaceNames')
    const block = accountBlock(forwarded)
    expect(block).not.toContain('no Team workspace yet')
    expect(block).not.toContain('Evil Corp')

    const disabled = disabledToolNamesForProfile('team')
    for (const tool of PROJECT_TOOLS) {
      expect(disabled.has(tool)).toBe(false)
    }
  })
})
