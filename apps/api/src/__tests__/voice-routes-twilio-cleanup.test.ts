// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice routes — DELETE /voice/twilio/number/:projectId, Twilio status
 * callback metering failure, translator/chat 503/400/500 tails, transcript
 * persist failure, and shared-agent signed-url unconfigured branches.
 *
 * Complements voice-routes-twilio-provision.test.ts (provision happy +
 * provision-time errors) by covering teardown + post-provision metering +
 * translator + transcript catch-blocks. ~70 uncov lines in voice.ts.
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? 'el-test'
process.env.ELEVENLABS_VOICE_MODE_AGENT_ID = process.env.ELEVENLABS_VOICE_MODE_AGENT_ID ?? 'agent_shared'
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? 'twilio-test'

const PROJECT = 'proj-1'
const WORKSPACE = 'ws-1'
const USER = 'user-1'
const SESSION = 'sess-1'

let voiceCfg: any = null
let sessionRow: any = null
let memberRow: any = null
let upsertError: Error | null = null
let createMsgError: Error | null = null

const mockPrisma = {
  project: {
    findUnique: mock(async (args: any) => {
      const wantsMembers = args?.select && 'members' in args.select
      if (wantsMembers) {
        return {
          workspaceId: WORKSPACE,
          members: [{ userId: USER }],
          workspace: { members: [{ userId: USER }] },
        }
      }
      return { id: PROJECT, workspaceId: WORKSPACE }
    }),
  },
  user: { findUnique: mock(async () => null) },
  member: { findFirst: mock(async () => memberRow) },
  voiceProjectConfig: {
    findUnique: mock(async () => voiceCfg),
    findFirst: mock(async () => voiceCfg),
    upsert: mock(async (args: any) => ({ ...(voiceCfg ?? {}), ...args.create, ...args.update })),
    update: mock(async (args: any) => {
      voiceCfg = { ...voiceCfg, ...args.data }
      return voiceCfg
    }),
  },
  chatSession: {
    findUnique: mock(async () => sessionRow),
  },
  chatMessage: {
    findUnique: mock(async () => null),
    upsert: mock(async (args: any) => {
      if (upsertError) throw upsertError
      return { id: 'msg', ...(args.create || {}) }
    }),
    create: mock(async (args: any) => {
      if (createMsgError) throw createMsgError
      return { id: 'msg', ...(args.data || {}) }
    }),
  },
  voiceCallMeter: {
    create: mock(async (args: any) => ({ id: 'meter', ...args.data })),
    findMany: mock(async () => []),
    findFirst: mock(async () => null),
  },
  usageEvent: {
    findMany: mock(async () => []),
    create: mock(async (args: any) => ({ id: 'ue', ...args.data })),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../auth', () => ({
  auth: { api: { getSession: mock(() => Promise.resolve(null)) } },
}))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(() => Promise.resolve(null)),
}))

// EL client + toggleable behaviour
let elDeleteError: Error | null = null
class MockElevenLabsClient {
  constructor(_cfg: any) {}
  async getSignedUrl(_id: string) { return 'wss://mock/x' }
  async deletePhoneNumber(_id: string) {
    if (elDeleteError) throw elDeleteError
    return undefined
  }
  async outboundCall(_args: any) { return { callSid: 'CA', conversationId: 'conv' } }
  async createAgent(_args: any) { return 'agent_new' }
  async createPhoneNumberTwilio(_args: any) { return { phoneNumberId: 'EL_PN_NEW' } }
}
mock.module('@shogo-ai/sdk/voice', () => ({ ElevenLabsClient: MockElevenLabsClient }))
mock.module('@shogo/agent-runtime/src/voice-mode/translator-persona', () => ({
  TRANSLATOR_SYSTEM_PROMPT: '',
  TRANSLATOR_AI_SDK_TOOLS: {},
  TRANSLATOR_CONTEXT_MARKER: '{{C}}',
  composeVoiceSystemPrompt: (b: string) => b,
}))

let twilioResolve: any = { error: 'unconfigured' }
let twReleaseError: Error | null = null
const twMockClient = {
  searchAvailable: async () => [{ phoneNumber: '+15551112222' }],
  purchaseNumber: async (a: any) => ({ sid: 'PN', phoneNumber: a.phoneNumber }),
  releaseNumber: async (_sid: string) => {
    if (twReleaseError) throw twReleaseError
    return undefined
  },
}
mock.module('../lib/twilio', () => ({
  resolveShogoTwilioClient: () => twilioResolve,
  verifyTwilioSignature: () => true,
}))

mock.module('../lib/voice-cost', () => ({
  getUsdBalance: async () => 999,
  resolvePlanIdForWorkspace: async () => 'plan_test',
  resolveVoiceRate: () => 0,
  calculateVoiceMinuteCost: () => ({ billedMinutes: 1, rawUsd: 0.1, billedUsd: 0.2, rawUsdPerMinute: 0.1, billedUsdPerMinute: 0.2 }),
  calculateVoiceNumberCost: () => ({ rawUsd: 1, billedUsd: 1.2 }),
}))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true }),
}))

let recordCallUsageError: Error | null = null
mock.module('../lib/voice-meter', () => ({
  recordCallUsage: async () => {
    if (recordCallUsageError) throw recordCallUsageError
    return { billedMinutes: 2, billedUsd: 0.4, alreadyBilled: false }
  },
  verifyElevenLabsSignature: () => true,
}))

mock.module('../services/projectAgentSync.service', () => ({
  syncProjectAgents: async () => ({ created: [], updated: [], deleted: [], errors: [], dryRun: false }),
}))

let voiceContextError: Error | null = null
mock.module('../lib/voice-context', () => ({
  resolveVoiceContext: async () => {
    if (voiceContextError) throw voiceContextError
    return ''
  },
  composeVoiceSystemPrompt: (b: string) => b,
}))

// streamText: return a simple Response-like object for the translator route.
mock.module('ai', () => ({
  streamText: () => ({
    toUIMessageStreamResponse: () => new Response('data: x\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  }),
  convertToModelMessages: (m: any) => m,
}))

mock.module('@ai-sdk/anthropic', () => ({
  createAnthropic: () => () => ({}),
}))

const { authMiddleware } = await import('../middleware/auth')
const { voiceRoutes } = await import('../routes/voice')
const { deriveRuntimeToken } = await import('../lib/runtime-token')

function buildApp() {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.route('/api', voiceRoutes())
  return app
}

let TOKEN: string
beforeAll(() => {
  TOKEN = deriveRuntimeToken(PROJECT)
})

beforeEach(() => {
  voiceCfg = null
  sessionRow = null
  memberRow = null
  upsertError = null
  createMsgError = null
  twilioResolve = { error: 'unconfigured' }
  twReleaseError = null
  elDeleteError = null
  recordCallUsageError = null
  voiceContextError = null
  mockPrisma.voiceProjectConfig.findUnique.mockClear()
  mockPrisma.voiceProjectConfig.update.mockClear()
  mockPrisma.chatMessage.upsert.mockClear()
  mockPrisma.chatMessage.create.mockClear()
  mockPrisma.chatSession.findUnique.mockClear()
})

function withTwilio() {
  twilioResolve = { client: twMockClient, accountSid: 'AC_test' }
}

// Auth helpers — runtime-token for project-scoped routes; better-auth session
// stub for user-scoped routes (chat session + transcript + signed-url).
function userSessionAuth() {
  return { Cookie: '' } // session is mocked separately
}

// Mock the better-auth session for user-scoped tests.
function withUserSession() {
  const authMod: any = require('../auth')
  authMod.auth.api.getSession = async () => ({
    user: { id: USER, email: 'a@b.c', name: 'A' },
    session: { id: 's1' },
  })
}
function withoutUserSession() {
  const authMod: any = require('../auth')
  authMod.auth.api.getSession = async () => null
}

const _origError = console.error
const _origWarn = console.warn
function silence() {
  console.error = () => {}
  console.warn = () => {}
}
function restore() {
  console.error = _origError
  console.warn = _origWarn
}

// ============================================================================
// DELETE /voice/twilio/number/:projectId
// ============================================================================

describe('DELETE /voice/twilio/number/:projectId', () => {
  test('returns {released:false, reason:no_number} when project has no provisioned number', async () => {
    voiceCfg = { projectId: PROJECT, twilioPhoneSid: null }
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/number/${PROJECT}`, {
      method: 'DELETE',
      headers: { 'x-runtime-token': TOKEN },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toEqual({ released: false, reason: 'no_number' })
  })

  test('happy path: releases Twilio + EL, clears config fields, no warnings', async () => {
    withTwilio()
    voiceCfg = {
      projectId: PROJECT, workspaceId: WORKSPACE,
      twilioPhoneSid: 'PN_OLD', twilioPhoneNumber: '+15550001111',
      elevenlabsPhoneId: 'EL_OLD', purchasedAt: new Date(),
    }
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/number/${PROJECT}`, {
      method: 'DELETE',
      headers: { 'x-runtime-token': TOKEN },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.released).toBe(true)
    expect(body.warnings).toBeUndefined()
    expect(mockPrisma.voiceProjectConfig.update).toHaveBeenCalled()
  })

  test('records warning when Twilio releaseNumber throws', async () => {
    withTwilio()
    twReleaseError = new Error('twilio release boom')
    voiceCfg = {
      projectId: PROJECT, workspaceId: WORKSPACE,
      twilioPhoneSid: 'PN_OLD', twilioPhoneNumber: '+15550001111',
      elevenlabsPhoneId: 'EL_OLD',
    }
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/number/${PROJECT}`, {
        method: 'DELETE',
        headers: { 'x-runtime-token': TOKEN },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.released).toBe(true)
      expect(body.warnings).toBeDefined()
      expect(body.warnings[0]).toContain('twilio:')
      expect(body.warnings[0]).toContain('twilio release boom')
    } finally { restore() }
  })

  test('records warning when EL deletePhoneNumber throws', async () => {
    withTwilio()
    elDeleteError = new Error('el delete boom')
    voiceCfg = {
      projectId: PROJECT, workspaceId: WORKSPACE,
      twilioPhoneSid: 'PN_OLD', twilioPhoneNumber: '+15550001111',
      elevenlabsPhoneId: 'EL_OLD',
    }
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/number/${PROJECT}`, {
        method: 'DELETE',
        headers: { 'x-runtime-token': TOKEN },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.warnings.some((w: string) => w.startsWith('elevenlabs:'))).toBe(true)
    } finally { restore() }
  })

  test('records warning when Twilio client is unconfigured (no client released)', async () => {
    // twilioResolve stays as { error: 'unconfigured' }
    voiceCfg = {
      projectId: PROJECT, workspaceId: WORKSPACE,
      twilioPhoneSid: 'PN_OLD', twilioPhoneNumber: '+15550001111',
      elevenlabsPhoneId: null,
    }
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/number/${PROJECT}`, {
      method: 'DELETE',
      headers: { 'x-runtime-token': TOKEN },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.warnings[0]).toContain('twilio: unconfigured')
  })
})

// ============================================================================
// POST /voice/twilio/status/:projectId — metering catch
// ============================================================================

describe('POST /voice/twilio/status/:projectId — metering failure', () => {
  test('returns 500 metering_failed when recordCallUsage throws', async () => {
    voiceCfg = { projectId: PROJECT, workspaceId: WORKSPACE, twilioPhoneSid: 'PN' }
    recordCallUsageError = new Error('billing down')
    silence()
    try {
      const form = new URLSearchParams({
        CallSid: 'CA1',
        CallStatus: 'completed',
        CallDuration: '120',
        Direction: 'outbound-api',
        From: '+1',
        To: '+2',
        AccountSid: 'AC_test',
      })
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/status/${PROJECT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'x' },
        body: form.toString(),
      })
      expect(res.status).toBe(500)
      const body = await res.json() as any
      expect(body.error).toBe('metering_failed')
      expect(body.detail).toBe('billing down')
    } finally { restore() }
  })

  test('ignores callback with no CallSid (returns ok:true ignored)', async () => {
    voiceCfg = { projectId: PROJECT, workspaceId: WORKSPACE, twilioPhoneSid: 'PN' }
    const form = new URLSearchParams({ CallStatus: 'completed', CallDuration: '0', Direction: 'inbound', AccountSid: 'AC_test' })
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/status/${PROJECT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'x' },
      body: form.toString(),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ignored).toBe('no CallSid')
  })

  test('ignores callback when project not configured', async () => {
    voiceCfg = null
    const form = new URLSearchParams({ CallSid: 'CA2', CallStatus: 'completed', CallDuration: '0', Direction: 'inbound', AccountSid: 'AC_test' })
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/status/${PROJECT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'x' },
      body: form.toString(),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ignored).toBe('project_not_configured')
  })
})

// ============================================================================
// POST /voice/translator/chat/:chatSessionId
// ============================================================================

describe('POST /voice/translator/chat/:chatSessionId', () => {
  test('returns 503 when no translator model configured (env unset)', async () => {
    withUserSession()
    sessionRow = { id: SESSION, project: { id: PROJECT, workspaceId: WORKSPACE } }
    memberRow = { id: 'mem-1' }
    const prevProxyUrl = process.env.AI_PROXY_URL
    const prevProxyToken = process.env.AI_PROXY_TOKEN
    const prevAnthropic = process.env.ANTHROPIC_API_KEY
    delete process.env.AI_PROXY_URL
    delete process.env.AI_PROXY_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/translator/chat/${SESSION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      })
      expect(res.status).toBe(503)
      const body = await res.json() as any
      expect(body.error).toContain('Translator model is not configured')
    } finally {
      if (prevProxyUrl) process.env.AI_PROXY_URL = prevProxyUrl
      if (prevProxyToken) process.env.AI_PROXY_TOKEN = prevProxyToken
      if (prevAnthropic) process.env.ANTHROPIC_API_KEY = prevAnthropic
    }
  })

  test('returns 400 when body is invalid JSON', async () => {
    withUserSession()
    sessionRow = { id: SESSION, project: { id: PROJECT, workspaceId: WORKSPACE } }
    memberRow = { id: 'mem-1' }
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    const app = buildApp()
    const res = await app.request(`/api/voice/translator/chat/${SESSION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toBe('Invalid JSON body')
  })

  test('returns 404 when chat session not found', async () => {
    withUserSession()
    sessionRow = null
    const app = buildApp()
    const res = await app.request(`/api/voice/translator/chat/${SESSION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    expect(res.status).toBe(404)
  })

  test('returns 403 when user is not a workspace member', async () => {
    withUserSession()
    sessionRow = { id: SESSION, project: { id: PROJECT, workspaceId: WORKSPACE } }
    memberRow = null
    const app = buildApp()
    const res = await app.request(`/api/voice/translator/chat/${SESSION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    expect(res.status).toBe(403)
  })

  test('happy path: streams translator response (resolveVoiceContext succeeds)', async () => {
    withUserSession()
    sessionRow = { id: SESSION, project: { id: PROJECT, workspaceId: WORKSPACE } }
    memberRow = { id: 'mem-1' }
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    const app = buildApp()
    const res = await app.request(`/api/voice/translator/chat/${SESSION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    })
    expect(res.status).toBe(200)
  })

  test('resolveVoiceContext failure logs warning but does not block', async () => {
    withUserSession()
    sessionRow = { id: SESSION, project: { id: PROJECT, workspaceId: WORKSPACE } }
    memberRow = { id: 'mem-1' }
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    voiceContextError = new Error('context boom')
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/translator/chat/${SESSION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        }),
      })
      expect(res.status).toBe(200)
    } finally { restore() }
  })
})

// ============================================================================
// POST /voice/transcript/:chatSessionId — persist catch
// ============================================================================

describe('POST /voice/transcript/:chatSessionId — persist failure', () => {
  test('returns 500 when prisma.chatMessage.upsert/create throws', async () => {
    withUserSession()
    sessionRow = { id: SESSION, project: { id: PROJECT, workspaceId: WORKSPACE } }
    memberRow = { id: 'mem-1' }
    upsertError = new Error("db down")
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/transcript/${SESSION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'voice-user',
          text: 'hi',
          id: 'tx-1',
          ts: Date.now(),
        }),
      })
      expect(res.status).toBe(500)
      const body = await res.json() as any
      expect(String(body.error || '')).toMatch(/persist|fail/i)
    } finally { restore() }
  })
})
