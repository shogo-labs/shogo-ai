// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-221 acceptance — a Personal workspace turns "build me an app" into
 * "building happens in your Team workspace, switch there".
 *
 * Each half has its own test and both can stay green while the pair is broken:
 * `routes/__tests__/workspace-chat-personal-team-workspaces.test.ts` only
 * inspects the body the API forwards, and the runtime's
 * `personal-companion-no-build.test.ts` only inspects a prompt built from a
 * hand-made context. QA round 1 on this card found exactly that gap — the API
 * stamped `teamWorkspaceNames`, the prompt builder rendered it, and
 * `AgentGateway.setAccountContext` dropped it in between, so a real Personal
 * turn never named the workspace. This test feeds the route's REAL forwarded
 * body through the REAL gateway and asserts what the turn would actually see.
 *
 *   bun test apps/api/src/__tests__/qa-sho221-personal-build-redirect.acceptance.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
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
const { AgentGateway, PERSONAL_COMPANION_GUIDE } = await import(
  '../../../../packages/agent-runtime/src/gateway'
)
const { parseAccountContext } = await import('../../../../packages/agent-runtime/src/account-context')
const { createTools, filterDisabledCapabilityTools } = await import(
  '../../../../packages/agent-runtime/src/gateway-tools'
)
const { disabledToolNamesForProfile } = await import(
  '../../../../packages/agent-runtime/src/capability-profiles'
)

/** `copy_to_project` only registers on a metal workspace runtime, so the six are
 *  asserted through the profile's disabled set and the five through the registry. */
const PROJECT_TOOLS = [
  'project_create',
  'project_call',
  'project_configure',
  'project_list',
  'connect_project',
  'copy_to_project',
]
const REGISTERED_PROJECT_TOOLS = PROJECT_TOOLS.filter(t => t !== 'copy_to_project')

const WORKSPACE_ROOT = '/tmp/qa-sho221-personal-build-redirect'

function makeWorkspace(name: string): string {
  const ws = join(WORKSPACE_ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800,
    heartbeatEnabled: false,
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\n\npersonal companion\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n')
  return ws
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    heartbeatToolsEnabled: true,
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    ...overrides,
  } as any
}

/** The prompt a Personal turn is assembled from, given the body the API really forwarded. */
function personalPromptFor(forwarded: Record<string, any>, name = 'personal'): string {
  const gw = new AgentGateway(makeWorkspace(name), 'p1')
  gw.setAccountContext(parseAccountContext(forwarded))
  return (gw as any).loadBootstrapContext(undefined, config({ capabilityProfile: 'personal' }))
}

function toolNamesFor(profile: 'personal' | 'team'): Set<string> {
  const cfg = config({ capabilityProfile: profile })
  const ctx = {
    workspaceDir: makeWorkspace(`tools-${profile}`),
    channels: new Map(),
    config: cfg,
    projectId: 'test',
    workspaceId: 'workspace-1',
  } as any
  return new Set(filterDisabledCapabilityTools(createTools(ctx), cfg).map((t: any) => t.name))
}

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
  if (existsSync(WORKSPACE_ROOT)) rmSync(WORKSPACE_ROOT, { recursive: true, force: true })
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
async function askForAnApp(): Promise<Record<string, any>> {
  const app = buildApp()
  const res = await app.fetch(new Request('http://x/api/workspaces/ws-1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': 's-1' },
    body: JSON.stringify({
      chatSessionId: 's-1',
      message: 'build me an app to manage my YouTube playlists',
    }),
  }))
  expect(res.status).toBe(200)
  await res.text()
  expect(store.forwarded).toHaveLength(1)
  return store.forwarded[0]
}

describe('SHO-221 — asking for an app in a Personal workspace', () => {
  test('the turn the runtime receives names the Team workspace the user should switch to', async () => {
    const forwarded = await askForAnApp()
    const prompt = personalPromptFor(forwarded)

    // The line the companion can read off, naming the real memberships.
    expect(prompt).toContain('**Acme**')
    expect(prompt).toContain('**Side project**')
    // And how to get there.
    expect(prompt.toLowerCase()).toContain('workspace switcher')
  })

  test('the turn carries the redirect, and no builder instruction to fall back on', async () => {
    const prompt = personalPromptFor(await askForAnApp())

    expect(prompt).toContain('Personal Companion')
    expect(prompt).toContain('Team workspace')
    // The old seeded AGENTS.md/HEARTBEAT.md in existing workspaces still say
    // "delegate to a builder project"; the guide has to beat them.
    expect(prompt).toMatch(/overrides? any older instruction/i)
    expect(prompt).not.toContain('project_create')
    expect(prompt).not.toContain('project_call')
  })

  test('the personal agent has no project tool to call, so no hidden build can start', async () => {
    // Capability-level guarantee: the tools aren't refused, they're absent.
    const names = toolNamesFor('personal')
    for (const tool of REGISTERED_PROJECT_TOOLS) {
      expect(names.has(tool)).toBe(false)
    }
    for (const tool of PROJECT_TOOLS) {
      expect(disabledToolNamesForProfile('personal').has(tool)).toBe(true)
    }
    // The rest of the companion still works.
    expect(names.has('goal_create')).toBe(true)
    expect(names.has('write_file')).toBe(true)
  })

  test('a user with no Team workspace yet is told how to make one, not left guessing', async () => {
    store.memberRows = []
    const prompt = personalPromptFor(await askForAnApp(), 'personal-empty')

    expect(prompt).toContain('no Team workspace yet')
    expect(prompt.toLowerCase()).toContain('workspace switcher')
  })

  test('a Team-workspace chat is untouched: no redirect, and every project tool present', async () => {
    store.kind = 'team'
    store.memberRows = []
    const forwarded = await askForAnApp()
    expect(forwarded).not.toHaveProperty('teamWorkspaceNames')

    const gw = new AgentGateway(makeWorkspace('team'), 'p1')
    gw.setAccountContext(parseAccountContext(forwarded))
    const prompt: string = (gw as any).loadBootstrapContext(undefined, config({ capabilityProfile: 'team' }))
    expect(prompt).not.toContain(PERSONAL_COMPANION_GUIDE)
    expect(prompt).not.toContain('no Team workspace yet')

    const names = toolNamesFor('team')
    for (const tool of REGISTERED_PROJECT_TOOLS) {
      expect(names.has(tool)).toBe(true)
    }
    for (const tool of PROJECT_TOOLS) {
      expect(disabledToolNamesForProfile('team').has(tool)).toBe(false)
    }
  })
})
