// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `POST /api/chat/turn` — public streaming chat route tests.
 *
 * Exercises the real `authMiddleware` + `chatRoutes()` Hono router with
 * mocked Prisma / Anthropic / `streamText` / `resolveVoiceContext`. The
 * goal is to lock the public auth + validation contract:
 *
 *   1. 401 unauthenticated.
 *   2. 403 runtime-token caller (chat is per-end-user, not pod-scoped).
 *   3. 400 missing `projectId` / malformed body / no messages.
 *   4. 403 caller is not a member of the project's workspace.
 *   5. 200 happy path: persona prompt is composed with the resolved
 *      project context block, `streamText` is called, and the response
 *      headers carry the conversationId echo.
 *
 * Run: bun test apps/api/src/__tests__/chat-turn-route.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

// ─── Shared env ───────────────────────────────────────────────────────────
process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token'
process.env.ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key'

// ─── Prisma mock ──────────────────────────────────────────────────────────
type ProjectFixture = {
  id: string
  workspaceId: string
  ownerUserId?: string
}
const projectsById = new Map<string, ProjectFixture>()
const memberByUserAndWorkspace = new Map<string, { id: string }>()

function memberKey(userId: string, workspaceId: string): string {
  return `${userId}::${workspaceId}`
}

type ProjectAgentRow = {
  id: string
  projectId: string
  workspaceId: string
  name: string
  systemPrompt: string | null
  toolsAllowlist: string[] | null
  tools:
    | Array<{
        name: string
        description?: string
        inputSchema?: Record<string, unknown>
      }>
    | null
  characterName: string | null
  displayName: string | null
  voiceId: string | null
  firstMessage: string | null
  elevenlabsAgentId: string | null
  model: string | null
}
const projectAgentsByProject = new Map<string, ProjectAgentRow[]>()

const mockPrisma = {
  project: {
    findUnique: mock(async (args: any) => {
      const p = projectsById.get(args.where.id)
      if (!p) return null
      // `authMiddleware`'s runtime-token branch selects
      // `{ workspaceId, members, workspace.members }` to resolve the
      // project-owner userId. `authorizeProject` selects
      // `{ id, workspaceId }`. We need both shapes since one runtime-
      // token test depends on the middleware authenticating
      // successfully so the route can then reject `via:'runtimeToken'`.
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
  member: {
    findFirst: mock(async (args: any) => {
      const userId = args.where?.userId
      const workspaceId = args.where?.workspaceId
      const m = memberByUserAndWorkspace.get(memberKey(userId, workspaceId))
      return m ?? null
    }),
  },
  user: {
    findUnique: mock(async () => null),
  },
  projectAgent: {
    findUnique: mock(async (args: any) => {
      const { projectId, name } = args.where.projectId_name
      const rows = projectAgentsByProject.get(projectId) ?? []
      return rows.find((r) => r.name === name) ?? null
    }),
    findMany: mock(async (args: any) => {
      const rows = projectAgentsByProject.get(args.where.projectId) ?? []
      // Mimic the real findMany select shape used by listProjectAgentNames.
      if (args.select && args.select.name === true) {
        return rows.map((r) => ({ name: r.name }))
      }
      return rows
    }),
  },
}
mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

// `auth` (Better Auth) — returns whatever the test installed via
// `currentSession`. Default: no session (so unauthenticated by default).
let currentSession:
  | null
  | { user: { id: string; email?: string; name?: string } } = null
mock.module('../auth', () => ({
  auth: {
    api: {
      getSession: mock(async () => currentSession),
    },
  },
}))

mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async () => null),
}))

// `resolveVoiceContext` — returns a stub block we can assert against.
const resolveVoiceContextMock = mock(
  async (_args: { projectId: string }) => '## About this project\nName: TestApp',
)
mock.module('../lib/voice-context', () => ({
  resolveVoiceContext: resolveVoiceContextMock,
  // The chat route doesn't reach for `composeVoiceSystemPrompt`, but
  // some other modules might pull it via this barrel — keep it intact.
  composeVoiceSystemPrompt: (base: string, ctx: string) =>
    `${base}\n\n${ctx}`.trim(),
}))

// `@ai-sdk/anthropic` — return a sentinel "model" object that
// `streamText` will accept (we mock streamText itself, so the model
// shape doesn't have to be real).
mock.module('@ai-sdk/anthropic', () => ({
  createAnthropic: () => () => ({ __mockModel: true }),
}))

// `ai` — stub `streamText` so we can assert the system prompt without
// hitting a real model. `convertToModelMessages` is an identity
// passthrough; `tool` / `jsonSchema` are stubbed to no-op so the
// route's tools branch can run.
const streamTextMock = mock((args: { system: string; messages: unknown[] }) => {
  // The route only reads `.toUIMessageStreamResponse` off the result.
  // Return a sentinel that produces a Response with a tiny SSE body
  // and the headers it was handed.
  return {
    __args: args,
    toUIMessageStreamResponse: (opts?: { headers?: Record<string, string> }) =>
      new Response('data: {"type":"text","text":"hi"}\n\n', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          ...(opts?.headers ?? {}),
        },
      }),
  }
})
mock.module('ai', () => ({
  streamText: streamTextMock,
  convertToModelMessages: async (msgs: unknown[]) => msgs,
  tool: (def: unknown) => def,
  jsonSchema: (schema: unknown) => schema,
}))

// ─── Import real code under test (AFTER mocks) ────────────────────────────
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { authMiddleware } = await import('../middleware/auth')
const { chatRoutes } = await import('../routes/chat')

function createApp() {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.route('/api', chatRoutes())
  return app
}

const PROJECT_A = 'proj_chat_a'
const WORKSPACE_A = 'ws_chat_a'
const USER_A = 'user_chat_a'

beforeEach(() => {
  projectsById.clear()
  memberByUserAndWorkspace.clear()
  projectAgentsByProject.clear()
  projectsById.set(PROJECT_A, {
    id: PROJECT_A,
    workspaceId: WORKSPACE_A,
    ownerUserId: USER_A,
  })
  memberByUserAndWorkspace.set(memberKey(USER_A, WORKSPACE_A), { id: 'mem_a' })
  currentSession = { user: { id: USER_A } }
  resolveVoiceContextMock.mockClear()
  streamTextMock.mockClear()
  mockPrisma.project.findUnique.mockClear()
  mockPrisma.member.findFirst.mockClear()
  mockPrisma.user.findUnique.mockClear()
  mockPrisma.projectAgent.findUnique.mockClear()
  mockPrisma.projectAgent.findMany.mockClear()
})

const validBody = {
  messages: [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  ],
  projectId: PROJECT_A,
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('POST /api/chat/turn — auth gate', () => {
  test('401 when unauthenticated', async () => {
    currentSession = null
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(401)
  })

  test('403 when caller is a runtime-token (project-scoped, not user-scoped)', async () => {
    // Runtime tokens authenticate via `x-runtime-token` and carry
    // `via: 'runtimeToken'` on the auth context. The chat route
    // rejects those explicitly — same pattern as the translator
    // route, see runtime-token.md §7.
    const token = deriveRuntimeToken(PROJECT_A)
    const app = createApp()
    const res = await app.request(`/api/chat/turn?projectId=${PROJECT_A}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-token': token,
      },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(403)
    const body: any = await res.json()
    expect(body.error.code).toBe('forbidden')
    // The 403 must NOT have reached the model.
    expect(streamTextMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/chat/turn — body validation', () => {
  test('400 when body is not valid JSON', async () => {
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(body.error.code).toBe('bad_request')
  })

  test('400 when messages is empty', async () => {
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [], projectId: PROJECT_A }),
    })
    expect(res.status).toBe(400)
  })

  test('400 when projectId is missing', async () => {
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: validBody.messages }),
    })
    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(body.error.message).toMatch(/projectId/)
  })

  test('400 on malformed tool descriptor', async () => {
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validBody,
        tools: [
          // name with a space — fails the identifier regex
          { name: 'bad name', description: 'x', inputSchema: {} },
        ],
      }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/chat/turn — project authorization', () => {
  test('403 when caller is not a workspace member', async () => {
    memberByUserAndWorkspace.clear()
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(403)
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  test('404 when project does not exist', async () => {
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validBody,
        projectId: 'proj_does_not_exist',
      }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/chat/turn — happy path', () => {
  test('streams a response, embeds resolved context in system prompt, echoes ids on headers', async () => {
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validBody,
        conversationId: 'conv_echo_test',
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.headers.get('x-shogo-conversation-id')).toBe('conv_echo_test')
    expect(res.headers.get('x-shogo-project-id')).toBe(PROJECT_A)

    // The stub returned by resolveVoiceContext must be embedded in
    // the system prompt.
    expect(resolveVoiceContextMock).toHaveBeenCalled()
    expect(streamTextMock).toHaveBeenCalled()
    const args = streamTextMock.mock.calls[0]![0] as {
      system: string
      tools?: unknown
    }
    expect(args.system).toContain('## About this project')
    expect(args.system).toContain('Name: TestApp')
    // Default chat persona is used (NOT the Shogo translator persona).
    expect(args.system).not.toMatch(/Shogo product partner/i)
    expect(args.system).toMatch(/Shogo assistant for this project/)
    // No tools were registered.
    expect(args.tools).toBeUndefined()
  })

  test('falls back to bare persona when resolveVoiceContext throws', async () => {
    resolveVoiceContextMock.mockImplementationOnce(async () => {
      throw new Error('pod cold-start timeout')
    })
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)
    const args = streamTextMock.mock.calls[0]![0] as { system: string }
    // Marker should NOT survive in the final prompt; the fallback
    // path passes an empty context block which gets substituted in.
    expect(args.system).not.toContain('{{PROJECT_CONTEXT}}')
    expect(args.system).toMatch(/Shogo assistant for this project/)
  })

  test('uses named agent\u2019s systemPrompt + model when agentName matches a row', async () => {
    projectAgentsByProject.set(PROJECT_A, [
      {
        id: 'pa_arch',
        projectId: PROJECT_A,
        workspaceId: WORKSPACE_A,
        name: 'architect',
        systemPrompt: 'You are the architect agent.',
        toolsAllowlist: null,
        tools: null,
        characterName: 'Archie',
        displayName: 'Architect',
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: 'claude-sonnet-4-5',
      },
    ])
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, agentName: 'architect' }),
    })
    expect(res.status).toBe(200)
    const args = streamTextMock.mock.calls[0]![0] as { system: string }
    expect(args.system).toContain('You are the architect agent.')
    expect(args.system).not.toMatch(/Shogo assistant for this project/)
  })

  test('reads agentName from the URL when the body omits it; URL wins on conflict', async () => {
    projectAgentsByProject.set(PROJECT_A, [
      {
        id: 'pa_arch',
        projectId: PROJECT_A,
        workspaceId: WORKSPACE_A,
        name: 'architect',
        systemPrompt: 'URL-resolved architect.',
        toolsAllowlist: null,
        tools: null,
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
      {
        id: 'pa_other',
        projectId: PROJECT_A,
        workspaceId: WORKSPACE_A,
        name: 'planner',
        systemPrompt: 'Body-resolved planner.',
        toolsAllowlist: null,
        tools: null,
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
    ])
    const app = createApp()
    const res = await app.request('/api/chat/turn?agentName=architect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, agentName: 'planner' }),
    })
    expect(res.status).toBe(200)
    const args = streamTextMock.mock.calls[0]![0] as { system: string }
    expect(args.system).toContain('URL-resolved architect.')
  })

  test('returns 404 with knownAgents when agentName does not match any row', async () => {
    projectAgentsByProject.set(PROJECT_A, [
      {
        id: 'pa_arch',
        projectId: PROJECT_A,
        workspaceId: WORKSPACE_A,
        name: 'architect',
        systemPrompt: null,
        toolsAllowlist: null,
        tools: null,
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
    ])
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, agentName: 'doesnotexist' }),
    })
    expect(res.status).toBe(404)
    const body: any = await res.json()
    expect(body.error.code).toBe('agent_not_found')
    expect(body.error.knownAgents).toEqual(['architect'])
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  test('drops client-requested tools that are not on the agent\u2019s allowlist', async () => {
    projectAgentsByProject.set(PROJECT_A, [
      {
        id: 'pa_arch',
        projectId: PROJECT_A,
        workspaceId: WORKSPACE_A,
        name: 'architect',
        systemPrompt: 'arch',
        toolsAllowlist: ['lookup_user'],
        tools: null,
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
    ])
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validBody,
        agentName: 'architect',
        tools: [
          { name: 'lookup_user', description: 'allowed', inputSchema: {} },
          { name: 'send_email', description: 'forbidden', inputSchema: {} },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const args = streamTextMock.mock.calls[0]![0] as {
      tools?: Record<string, unknown>
    }
    expect(args.tools).toBeDefined()
    expect(Object.keys(args.tools!)).toEqual(['lookup_user'])
  })

  test('forwards caller-supplied tool descriptors to streamText', async () => {
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validBody,
        tools: [
          {
            name: 'lookup_user',
            description: 'Look up a user by id',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const args = streamTextMock.mock.calls[0]![0] as {
      tools?: Record<string, unknown>
    }
    expect(args.tools).toBeDefined()
    expect(Object.keys(args.tools!)).toEqual(['lookup_user'])
  })

  test('manifest schema wins over client-supplied schema (description + inputSchema)', async () => {
    projectAgentsByProject.set(PROJECT_A, [
      {
        id: 'pa_arch',
        projectId: PROJECT_A,
        workspaceId: WORKSPACE_A,
        name: 'architect',
        systemPrompt: 'arch',
        toolsAllowlist: null,
        tools: [
          {
            name: 'lookup_user',
            description: 'Manifest-declared lookup',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', minLength: 1 } },
              required: ['id'],
            },
          },
        ],
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
    ])
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validBody,
        agentName: 'architect',
        tools: [
          {
            name: 'lookup_user',
            description: 'Client says something else',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const args = streamTextMock.mock.calls[0]![0] as {
      tools?: Record<string, any>
    }
    expect(Object.keys(args.tools!)).toEqual(['lookup_user'])
    // The AI SDK's `tool()` returns a record with the original
    // `description`. We assert the manifest's description wins.
    expect(args.tools!.lookup_user.description).toBe('Manifest-declared lookup')
  })

  test('drops manifest tools the client did not register', async () => {
    projectAgentsByProject.set(PROJECT_A, [
      {
        id: 'pa_arch',
        projectId: PROJECT_A,
        workspaceId: WORKSPACE_A,
        name: 'architect',
        systemPrompt: 'arch',
        toolsAllowlist: null,
        tools: [
          {
            name: 'lookup_user',
            description: 'm1',
            inputSchema: { type: 'object' },
          },
          {
            name: 'send_email',
            description: 'm2',
            inputSchema: { type: 'object' },
          },
        ],
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
    ])
    const app = createApp()
    const res = await app.request('/api/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validBody,
        agentName: 'architect',
        // Client only registered handlers for `lookup_user`.
        tools: [
          { name: 'lookup_user', description: 'x', inputSchema: { type: 'object' } },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const args = streamTextMock.mock.calls[0]![0] as {
      tools?: Record<string, unknown>
    }
    expect(Object.keys(args.tools!)).toEqual(['lookup_user'])
  })
})
