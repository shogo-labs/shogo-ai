// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.ELEVENLABS_API_KEY = 'el-test'
process.env.ELEVENLABS_VOICE_MODE_AGENT_ID = 'agent-shared'
process.env.AI_PROXY_URL = 'https://proxy.example/ai/v1'
process.env.AI_PROXY_TOKEN = 'proxy-token'

const chatMessages: any[] = []
let sessionAllowed = true
let streamTextCalls: any[] = []

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
    },
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
  resolveLanguageModel: mock(() => ({
    model: { provider: 'anthropic', model: 'test-model' },
    billingModelId: 'test-model',
    provider: 'anthropic',
  })),
}))

mock.module('ai', () => ({
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
