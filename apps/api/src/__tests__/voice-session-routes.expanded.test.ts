// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.ELEVENLABS_API_KEY = 'el-test'
process.env.ELEVENLABS_VOICE_MODE_AGENT_ID = 'agent-shared'
process.env.AI_PROXY_URL = 'https://proxy.example/ai/v1'
process.env.AI_PROXY_TOKEN = 'proxy-token'
process.env.AI_PROXY_SECRET = 'test-proxy-secret'
process.env.API_PORT = '8123'

const chatMessages: any[] = []
let sessionAllowed = true
let streamTextCalls: any[] = []
let generateTextCalls: any[] = []
let generateTextResults: any[] = []
let liveSessionCalls: any[] = []
const resolveLanguageModelCalls: any[] = []
const autoTierCalls: any[] = []

mock.module('../middleware/auth', () => ({
  apiKeyOrSession: async (c: any, next: any) => {
    c.set('auth', {
      isAuthenticated: true,
      userId: 'user-1',
      via: 'session',
    })
    await next()
  },
  authorizeProject: mock(async (_c: any, projectId: string) => ({
    ok: true,
    projectId,
    workspaceId: 'workspace-1',
  })),
}))

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findUnique: mock(async () => ({ id: 'project-1', workspaceId: 'workspace-1' })),
    },
    chatSession: {
      findUnique: mock(async () => sessionAllowed
        ? {
            id: 'session-1',
            projectId: 'project-1',
            project: {
              id: 'project-1',
              workspaceId: 'workspace-1',
            },
          }
        : null),
    },
    member: {
      findFirst: mock(async () => ({ id: 'member-1' })),
      findMany: mock(async () => [{ role: 'member', projectId: null, isBillingAdmin: false }]),
    },
    user: { findUnique: mock(async () => ({ role: 'user' })) },
    chatMessage: {
      upsert: mock(async ({ where, create, update }: any) => {
        const row = { id: where.id, ...(chatMessages.find((m) => m.id === where.id) ? update : create) }
        chatMessages.push(row)
        return row
      }),
      create: mock(async ({ data }: any) => {
        const row = { id: `msg-${chatMessages.length + 1}`, ...data }
        chatMessages.push(row)
        return row
      }),
    },
    voiceProjectConfig: {
      findUnique: mock(async () => null),
      findFirst: mock(async () => null),
    },
  },
}))

class MockElevenLabsClient {
  agentId: string
  constructor(_cfg: any) {
    this.agentId = 'client'
  }
  async getSignedUrl(agentId: string) {
    return `wss://signed/${agentId}`
  }
}

mock.module('@shogo-ai/sdk/voice', () => ({ ElevenLabsClient: MockElevenLabsClient }))

// Translator model resolution flows through the shared resolver now. This
// suite only exercises the resolved (200) path, so return a sentinel model.
mock.module('../lib/resolve-language-model', () => ({
  DEFAULT_ASSISTANT_MODEL: 'hoshi-1.0',
  resolveLanguageModel: mock((id: string, opts?: any) => {
    resolveLanguageModelCalls.push({ id, opts })
    return {
      model: { provider: 'anthropic', model: 'test-model' },
      billingModelId: 'test-model',
      provider: 'anthropic',
    }
  }),
}))

const realAgentModelDefaults = await import('../lib/runtime/agent-model-defaults')
mock.module('../lib/runtime/agent-model-defaults', () => ({
  ...realAgentModelDefaults,
  resolveAutoTierModel: mock(async (workspaceId: string) => {
    autoTierCalls.push(workspaceId)
    return { id: 'cloud-auto-standard', provider: 'custom' }
  }),
}))

mock.module('../lib/live-webrtc', () => ({
  createLiveWebRtcSession: mock(async (args: any) => {
    liveSessionCalls.push(args)
    return Response.json({ session: { id: 'live-1' }, transport: { sdp: 'answer-sdp' } })
  }),
}))

mock.module('ai', () => ({
  generateText: mock(async (args: any) => {
    generateTextCalls.push(args)
    const next = generateTextResults.shift()
    if (next?.error) throw next.error
    return next ?? { text: 'done', toolCalls: [], response: { messages: [] } }
  }),
  convertToModelMessages: mock(async (messages: any[]) => messages.map((m) => ({
    role: m.role,
    content: m.parts?.map((p: any) => p.text).join('') ?? '',
  }))),
  streamText: mock((args: any) => {
    streamTextCalls.push(args)
    return {
      toUIMessageStreamResponse: ({ onFinish }: any) => {
        onFinish?.({
          messages: [
            ...args.messages.map((m: any, i: number) => ({ id: `input-${i}`, role: m.role, parts: [{ type: 'text', text: m.content }] })),
            { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'hello from shogo' }] },
          ],
        })
        return new Response('data: done\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    }
  }),
}))

mock.module('@shogo/agent-runtime/src/voice-mode/translator-persona', () => ({
  TRANSLATOR_SYSTEM_PROMPT: 'base prompt',
  TRANSLATOR_AI_SDK_TOOLS: { send_to_chat: {} },
  TRANSLATOR_LIVE_CONVERSATION_PROMPT: 'live prompt',
  TRANSLATOR_LIVE_DELEGATION_SUFFIX: ' delegation suffix',
}))

mock.module('../lib/voice-context', () => ({
  resolveVoiceContext: mock(async () => 'project context'),
  composeVoiceSystemPrompt: mock((base: string, context: string) => `${base}\n${context}`),
}))

mock.module('../lib/twilio', () => ({
  resolveShogoTwilioClient: () => ({ error: 'unconfigured' }),
  verifyTwilioSignature: () => true,
}))

mock.module('../lib/voice-cost', () => ({
  getUsdBalance: async () => 100,
  resolvePlanIdForWorkspace: async () => 'pro',
  calculateVoiceNumberCost: () => ({ rawUsd: 1, billedUsd: 1 }),
  calculateVoiceMinuteCost: () => ({ billedMinutes: 1, rawUsd: 1, billedUsd: 1, rawUsdPerMinute: 1, billedUsdPerMinute: 1 }),
}))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true }),
}))

mock.module('../lib/voice-meter', () => ({
  recordCallUsage: async () => ({ ok: true }),
  verifyElevenLabsSignature: () => true,
}))

mock.module('../services/projectAgentSync.service', () => ({
  syncProjectAgents: async () => ({ created: [], updated: [], deleted: [], errors: [], dryRun: false }),
}))

let voiceRoutes: typeof import('../routes/voice').voiceRoutes

beforeEach(async () => {
  chatMessages.length = 0
  streamTextCalls = []
  generateTextCalls = []
  generateTextResults = []
  liveSessionCalls = []
  resolveLanguageModelCalls.length = 0
  autoTierCalls.length = 0
  delete process.env.SHOGO_EZ_MODE_LIVE_BACKEND_MODEL
  sessionAllowed = true
  const mod = await import('../routes/voice')
  voiceRoutes = mod.voiceRoutes
})

function buildApp() {
  const app = new Hono()
  app.route('/api', voiceRoutes())
  return app
}

async function json(res: Response) {
  return res.json() as Promise<any>
}

describe('voice session routes', () => {
  test('mints a shared signed URL with per-session prompt context', async () => {
    const res = await buildApp().request('http://api.test/api/voice/signed-url?chatSessionId=session-1')
    const body = await json(res)

    expect(res.status).toBe(200)
    expect(body).toEqual({
      signedUrl: 'wss://signed/agent-shared',
      agentPromptOverride: 'base prompt\nproject context',
    })
  })

  test('rejects shared signed URL when chat session is not authorized', async () => {
    sessionAllowed = false

    const res = await buildApp().request('http://api.test/api/voice/signed-url?chatSessionId=session-1')
    const body = await json(res)

    expect(res.status).toBe(404)
    expect(body.error).toBe('Chat session not found')
  })

  test('translator chat persists trailing user messages and assistant finish messages', async () => {
    const res = await buildApp().request('http://api.test/api/voice/translator/chat/session-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'again' }] },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('data: done')
    expect(streamTextCalls[0].system).toBe('base prompt\nproject context')
    expect(chatMessages.map((m) => m.id)).toContain('u1')
    expect(chatMessages.map((m) => m.id)).toContain('u2')
    expect(chatMessages.map((m) => m.id)).toContain('assistant-1')
  })

  test('translator chat validates auth, JSON, and message payloads', async () => {
    const app = buildApp()

    const invalidJson = await app.request('http://api.test/api/voice/translator/chat/session-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(invalidJson.status).toBe(400)

    const missingMessages = await app.request('http://api.test/api/voice/translator/chat/session-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    expect(missingMessages.status).toBe(400)

    sessionAllowed = false
    const forbidden = await app.request('http://api.test/api/voice/translator/chat/session-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    })
    expect(forbidden.status).toBe(404)
  })

  test('transcript endpoint persists voice and agent-activity entries', async () => {
    const voiceUser = await buildApp().request('http://api.test/api/voice/transcript/session-1', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ id: 'voice-1', kind: 'voice-user', text: 'spoken', ts: Date.parse('2026-01-01T00:00:00Z') }),
    })
    expect(voiceUser.status).toBe(201)

    const activity = await buildApp().request('http://api.test/api/voice/transcript/session-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'agent-activity', text: 'edited a file' }),
    })
    expect(activity.status).toBe(201)

    expect(chatMessages.find((m) => m.id === 'voice-1')).toMatchObject({
      role: 'user',
      content: 'spoken',
      agent: 'voice',
    })
    expect(chatMessages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'edited a file',
      agent: 'voice',
    })
  })

  test('transcript endpoint validates body shape and size', async () => {
    const app = buildApp()

    expect((await app.request('http://api.test/api/voice/transcript/session-1', {
      method: 'POST',
      body: '',
    })).status).toBe(400)
    expect((await app.request('http://api.test/api/voice/transcript/session-1', {
      method: 'POST',
      body: JSON.stringify({ kind: 'bad', text: 'x' }),
    })).status).toBe(400)
    expect((await app.request('http://api.test/api/voice/transcript/session-1', {
      method: 'POST',
      body: JSON.stringify({ kind: 'voice-agent', text: 42 }),
    })).status).toBe(400)
    expect((await app.request('http://api.test/api/voice/transcript/session-1', {
      method: 'POST',
      body: JSON.stringify({ kind: 'voice-agent', text: 'x'.repeat(64_001) }),
    })).status).toBe(413)
  })
})

describe('GPT-Live session routes', () => {
  function post(path: string, body: unknown) {
    return buildApp().request(`http://api.test/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  test('live session uses client delegation and the conversation prompt', async () => {
    const res = await post('/voice/live/session/session-1', { sdp: 'offer-sdp' })

    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ sessionId: 'live-1', sdp: 'answer-sdp' })
    const call = liveSessionCalls[0]
    expect(call.sdp).toBe('offer-sdp')
    expect(call.session.delegation).toEqual({ type: 'client' })
    expect(call.session.instructions).toBe('live prompt\nproject context')
    expect(call.tokenPayload).toMatchObject({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
    })
  })

  test('live session rejects a missing sdp and unauthorized sessions', async () => {
    expect((await post('/voice/live/session/session-1', {})).status).toBe(400)
    sessionAllowed = false
    expect((await post('/voice/live/session/session-1', { sdp: 'x' })).status).toBe(404)
    expect(liveSessionCalls).toHaveLength(0)
  })

  test('delegate resolves Auto and meters through a user-scoped in-process proxy token', async () => {
    const res = await post('/voice/live/delegate/session-1', {
      transcript: [
        { role: 'user', text: 'make the header blue' },
        { role: 'assistant', text: 'Sure.' },
        { role: 'user', text: '   ' },
      ],
    })

    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ text: 'done', toolCalls: [], steps: [] })
    expect(autoTierCalls).toEqual(['workspace-1'])
    const resolved = resolveLanguageModelCalls.at(-1)
    expect(resolved.id).toBe('cloud-auto-standard')
    expect(resolved.opts.proxy.url).toBe('http://localhost:8123/api/ai/v1')
    expect(resolved.opts.proxy.token).not.toBe('proxy-token')
    const payload = JSON.parse(atob(resolved.opts.proxy.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    expect(payload).toMatchObject({ projectId: 'project-1', workspaceId: 'workspace-1', userId: 'user-1' })

    const call = generateTextCalls[0]
    expect(call.system).toBe('base prompt\nproject context delegation suffix')
    expect(call.messages).toEqual([
      { role: 'user', content: 'make the header blue' },
      { role: 'assistant', content: 'Sure.' },
    ])
    expect(call.tools).toEqual({ send_to_chat: {} })
  })

  test('delegate honors an explicit backend model override', async () => {
    process.env.SHOGO_EZ_MODE_LIVE_BACKEND_MODEL = 'claude-haiku-4-5'
    await post('/voice/live/delegate/session-1', { transcript: [{ role: 'user', text: 'hi' }] })

    expect(autoTierCalls).toHaveLength(0)
    expect(resolveLanguageModelCalls.at(-1).id).toBe('claude-haiku-4-5')
  })

  test('delegate returns tool calls and continues with client tool results', async () => {
    const assistantStep = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'send_to_chat', input: { text: 'blue header' } }],
    }
    generateTextResults.push({
      text: '',
      toolCalls: [{ toolCallId: 'call-1', toolName: 'send_to_chat', input: { text: 'blue header' } }],
      response: { messages: [assistantStep] },
    })
    const transcript = [{ role: 'user', text: 'make the header blue' }]

    const first = await json(await post('/voice/live/delegate/session-1', { transcript }))
    expect(first.toolCalls).toEqual([
      { toolCallId: 'call-1', toolName: 'send_to_chat', input: { text: 'blue header' } },
    ])
    expect(first.steps).toEqual([assistantStep])

    const second = await json(await post('/voice/live/delegate/session-1', {
      transcript,
      steps: first.steps,
      toolResults: [{ toolCallId: 'call-1', toolName: 'send_to_chat', output: 'queued' }],
    }))
    const toolMessage = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'send_to_chat',
        output: { type: 'text', value: 'queued' },
      }],
    }
    expect(generateTextCalls[1].messages).toEqual([
      { role: 'user', content: 'make the header blue' },
      assistantStep,
      toolMessage,
    ])
    expect(second).toEqual({ text: 'done', toolCalls: [], steps: [assistantStep, toolMessage] })
  })

  test('delegate validates the body and surfaces model failures as 502', async () => {
    expect((await post('/voice/live/delegate/session-1', '{')).status).toBe(400)
    expect((await post('/voice/live/delegate/session-1', { transcript: [] })).status).toBe(400)

    generateTextResults.push({ error: new Error('upstream down') })
    const failed = await post('/voice/live/delegate/session-1', { transcript: [{ role: 'user', text: 'hi' }] })
    expect(failed.status).toBe(502)

    sessionAllowed = false
    expect((await post('/voice/live/delegate/session-1', { transcript: [{ role: 'user', text: 'hi' }] })).status).toBe(404)
  })
})
