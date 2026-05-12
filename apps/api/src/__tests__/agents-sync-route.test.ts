// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `POST /api/projects/:projectId/agents/sync` — end-to-end smoke test
 * exercising the real Hono router + `authMiddleware` against a mocked
 * Prisma + ElevenLabs stack. The reconciliation engine itself has its
 * own focused tests in `project-agent-sync.test.ts`; this file pins
 * the wire contract:
 *
 *   1. 401 unauthenticated.
 *   2. 403 caller is not a workspace member.
 *   3. 200 happy path: returns `{ created, updated, deleted, errors }`.
 *   4. dryRun=true returns `dryRun: true` and writes nothing.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token'
process.env.ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY ?? 'test-el-key'

const projectsById = new Map<string, any>()
const memberByUserAndWorkspace = new Map<string, { id: string }>()
type Row = {
  id: string
  projectId: string
  workspaceId: string
  name: string
  systemPrompt: string | null
  toolsAllowlist: unknown
  tools: unknown
  characterName: string | null
  displayName: string | null
  voiceId: string | null
  firstMessage: string | null
  elevenlabsAgentId: string | null
  model: string | null
}
let agentRows: Row[] = []
let agentNextId = 1

const memberKey = (uid: string, ws: string) => `${uid}::${ws}`

const mockPrisma = {
  project: {
    findUnique: mock(async (args: any) => {
      const p = projectsById.get(args.where.id)
      if (!p) return null
      const wantsMembers = args.select && 'members' in args.select
      if (wantsMembers) {
        return {
          workspaceId: p.workspaceId,
          members: p.ownerUserId ? [{ userId: p.ownerUserId }] : [],
          workspace: {
            members: p.ownerUserId ? [{ userId: p.ownerUserId }] : [],
          },
        }
      }
      return { id: p.id, workspaceId: p.workspaceId }
    }),
  },
  user: { findUnique: mock(async () => null) },
  member: {
    findFirst: mock(async (args: any) => {
      const userId = args.where?.userId
      const workspaceId = args.where?.workspaceId
      return memberByUserAndWorkspace.get(memberKey(userId, workspaceId)) ?? null
    }),
  },
  projectAgent: {
    findMany: mock(async (args: any) =>
      agentRows.filter((r) => r.projectId === args.where.projectId),
    ),
    create: mock(async (args: any) => {
      const row: Row = {
        id: `pa_${agentNextId++}`,
        projectId: args.data.projectId,
        workspaceId: args.data.workspaceId,
        name: args.data.name,
        systemPrompt: args.data.systemPrompt ?? null,
        toolsAllowlist: args.data.toolsAllowlist ?? null,
        tools: args.data.tools ?? null,
        characterName: args.data.characterName ?? null,
        displayName: args.data.displayName ?? null,
        voiceId: args.data.voiceId ?? null,
        firstMessage: args.data.firstMessage ?? null,
        elevenlabsAgentId: args.data.elevenlabsAgentId ?? null,
        model: args.data.model ?? null,
      }
      agentRows.push(row)
      return row
    }),
    update: mock(async (args: any) => {
      const row = agentRows.find((r) => r.id === args.where.id)
      if (row) Object.assign(row, args.data)
      return row
    }),
    delete: mock(async (args: any) => {
      agentRows = agentRows.filter((r) => r.id !== args.where.id)
    }),
  },
}
mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

let currentSession:
  | null
  | { user: { id: string; email?: string; name?: string } } = null
mock.module('../auth', () => ({
  auth: {
    api: { getSession: mock(async () => currentSession) },
  },
}))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async () => null),
}))

const createAgentMock = mock(async () => 'agent_created')
class MockClient {
  constructor(_cfg: any) {}
  createAgent = createAgentMock
  patchAgent = mock(async () => undefined)
  deleteAgent = mock(async () => undefined)
  getSignedUrl = mock(async () => 'wss://x')
}
mock.module('@shogo-ai/sdk/voice', () => ({
  ElevenLabsClient: MockClient,
}))
mock.module('@shogo/agent-runtime/src/voice-mode/translator-persona', () => ({
  TRANSLATOR_SYSTEM_PROMPT: '',
  TRANSLATOR_AI_SDK_TOOLS: {},
  TRANSLATOR_CONTEXT_MARKER: '{{PROJECT_CONTEXT}}',
  composeVoiceSystemPrompt: (b: string) => b,
}))
mock.module('../lib/twilio', () => ({
  resolveShogoTwilioClient: () => ({ error: 'not configured' }),
  verifyTwilioSignature: () => true,
}))
mock.module('../lib/voice-cost', () => ({
  resolveVoiceRate: () => 0,
  resolvePlanIdForWorkspace: async () => 'plan_test',
  getUsdBalance: async () => 1000,
  calculateVoiceMinuteCost: () => ({}),
  calculateVoiceNumberCost: () => ({}),
}))
mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true }),
}))
mock.module('../lib/voice-meter', () => ({
  recordCallUsage: async () => ({ ok: true }),
  verifyElevenLabsSignature: () => true,
}))

const { authMiddleware } = await import('../middleware/auth')
const { voiceRoutes } = await import('../routes/voice')

function createApp() {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.route('/api', voiceRoutes())
  return app
}

const PROJECT = 'proj_sync_a'
const WORKSPACE = 'ws_sync_a'
const USER = 'user_sync_a'

beforeEach(() => {
  projectsById.clear()
  memberByUserAndWorkspace.clear()
  agentRows = []
  agentNextId = 1
  projectsById.set(PROJECT, {
    id: PROJECT,
    workspaceId: WORKSPACE,
    ownerUserId: USER,
  })
  memberByUserAndWorkspace.set(memberKey(USER, WORKSPACE), { id: 'mem' })
  currentSession = { user: { id: USER } }
  createAgentMock.mockClear()
})

describe('POST /api/projects/:projectId/agents/sync', () => {
  test('401 when unauthenticated', async () => {
    currentSession = null
    const app = createApp()
    const res = await app.request(`/api/projects/${PROJECT}/agents/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: {} }),
    })
    expect(res.status).toBe(401)
  })

  test('403 when caller is not a workspace member', async () => {
    memberByUserAndWorkspace.clear()
    const app = createApp()
    const res = await app.request(`/api/projects/${PROJECT}/agents/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: {} }),
    })
    expect(res.status).toBe(403)
  })

  test('200 happy path: creates rows + provisions EL for voice agents', async () => {
    const app = createApp()
    const res = await app.request(`/api/projects/${PROJECT}/agents/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agents: {
          architect: { systemPrompt: 'arch' },
          narrator: { systemPrompt: 'nar', voiceId: 'v1', firstMessage: 'hi' },
        },
      }),
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.created.sort()).toEqual(['architect', 'narrator'])
    expect(body.dryRun).toBe(false)
    expect(createAgentMock).toHaveBeenCalledTimes(1)
    expect(agentRows.length).toBe(2)
  })

  test('dryRun=true returns the diff but writes nothing', async () => {
    const app = createApp()
    const res = await app.request(`/api/projects/${PROJECT}/agents/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agents: { architect: { systemPrompt: 'arch' } },
        dryRun: true,
      }),
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.dryRun).toBe(true)
    expect(body.created).toEqual(['architect'])
    expect(agentRows).toEqual([])
    expect(createAgentMock).not.toHaveBeenCalled()
  })

  test('400 on invalid JSON body', async () => {
    const app = createApp()
    const res = await app.request(`/api/projects/${PROJECT}/agents/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
  })
})
