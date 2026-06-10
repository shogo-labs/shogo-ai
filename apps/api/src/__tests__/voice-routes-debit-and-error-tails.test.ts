// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice routes — debit-failure consoles and remaining catch tails.
 *
 *  - L1205-1208: provision-number setup debit failure console.error
 *  - L1231-1234: provision-number monthly debit failure console.error
 *  - L741-748:  translator/chat outer catch (streamText throws)
 *  - L580-584:  shared-agent signed-url getSignedUrl catch
 *  - L299-310:  project-signed-url getSignedUrl catch
 *  - L435-443:  upsertShogoTextMessage create branch (no id passed)
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token'
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? 'el-test'
process.env.ELEVENLABS_VOICE_MODE_AGENT_ID =
  process.env.ELEVENLABS_VOICE_MODE_AGENT_ID ?? 'agent_shared'
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? 'twilio-test'
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-test'

const PROJECT = 'proj-1'
const WORKSPACE = 'ws-1'
const USER = 'user-1'
const SESSION = 'sess-1'

let voiceCfg: any = null
let sessionRow: any = null
let memberRow: any = { id: 'mem-1' }

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
  chatSession: { findUnique: mock(async () => sessionRow) },
  chatMessage: {
    findUnique: mock(async () => null),
    upsert: mock(async (args: any) => ({ id: 'msg', ...(args.create || {}) })),
    create: mock(async (args: any) => ({ id: 'msg', ...(args.data || {}) })),
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

let elGetSignedUrlError: Error | null = null
class MockElevenLabsClient {
  constructor(_cfg: any) {}
  async getSignedUrl(_id: string) {
    if (elGetSignedUrlError) throw elGetSignedUrlError
    return 'wss://mock/x'
  }
  async deletePhoneNumber(_id: string) { return undefined }
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

let resolveVoiceAgentResult: any = null
mock.module('../services/projectAgent.service', () => ({
  resolveVoiceAgentForSignedUrl: async () => resolveVoiceAgentResult,
  listProjectAgentNames: async () => [],
}))

let twilioResolve: any = { client: {
  searchAvailable: async () => [{ phoneNumber: '+15551112222' }],
  purchaseNumber: async (a: any) => ({ sid: 'PN_NEW', phoneNumber: a.phoneNumber }),
  releaseNumber: async () => undefined,
}, accountSid: 'AC_test' }
mock.module('../lib/twilio', () => ({
  resolveShogoTwilioClient: () => twilioResolve,
  verifyTwilioSignature: () => true,
}))

mock.module('../lib/voice-cost', () => ({
  getUsdBalance: async () => 999,
  resolvePlanIdForWorkspace: async () => 'plan_test',
  resolveVoiceRate: () => 0,
  calculateVoiceMinuteCost: () => ({
    billedMinutes: 1, rawUsd: 0.1, billedUsd: 0.2,
    rawUsdPerMinute: 0.1, billedUsdPerMinute: 0.2,
  }),
  calculateVoiceNumberCost: () => ({ rawUsd: 1, billedUsd: 1.2 }),
}))

// Counter-based consumeUsage mock so individual tests can express
// "the Nth call returns {success: false}".
let consumeOutcomes: Array<{ success: boolean; error?: string }> = []
mock.module('../services/billing.service', () => ({
  consumeUsage: async () => {
    const next = consumeOutcomes.shift()
    return next ?? { success: true }
  },
}))

mock.module('../lib/voice-meter', () => ({
  recordCallUsage: async () => ({ billedMinutes: 2, billedUsd: 0.4, alreadyBilled: false }),
  verifyElevenLabsSignature: () => true,
}))

mock.module('../services/projectAgentSync.service', () => ({
  syncProjectAgents: async () => ({ created: [], updated: [], deleted: [], errors: [], dryRun: false }),
}))

mock.module('../lib/voice-context', () => ({
  resolveVoiceContext: async () => '',
  composeVoiceSystemPrompt: (b: string) => b,
}))

let streamTextError: Error | null = null
mock.module('ai', () => ({
  streamText: () => {
    if (streamTextError) throw streamTextError
    return {
      toUIMessageStreamResponse: () => new Response('data: x\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }
  },
  convertToModelMessages: (m: any) => m,
}))
// Translator model resolution flows through the shared resolver now. Mirror
// its env-driven null behavior so the route's 503 (no transport) vs 200
// (resolves) contract still holds.
mock.module('../lib/resolve-language-model', () => ({
  DEFAULT_ASSISTANT_MODEL: 'hoshi-1.0',
  resolveLanguageModel: () => {
    const hasProxy = Boolean(process.env.AI_PROXY_URL && process.env.AI_PROXY_TOKEN)
    const hasKey = Boolean(process.env.ANTHROPIC_API_KEY)
    if (!hasProxy && !hasKey) return null
    return { model: { provider: 'anthropic' }, billingModelId: 'test-model', provider: 'anthropic' }
  },
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
beforeAll(() => { TOKEN = deriveRuntimeToken(PROJECT) })

beforeEach(() => {
  voiceCfg = null
  sessionRow = null
  memberRow = { id: 'mem-1' }
  elGetSignedUrlError = null
  resolveVoiceAgentResult = null
  streamTextError = null
  consumeOutcomes = []
  twilioResolve = { client: {
    searchAvailable: async () => [{ phoneNumber: '+15551112222' }],
    purchaseNumber: async (a: any) => ({ sid: 'PN_NEW', phoneNumber: a.phoneNumber }),
    releaseNumber: async () => undefined,
  }, accountSid: 'AC_test' }
  mockPrisma.voiceProjectConfig.findUnique.mockClear()
  mockPrisma.voiceProjectConfig.upsert.mockClear()
  mockPrisma.voiceProjectConfig.update.mockClear()
  mockPrisma.chatMessage.create.mockClear()
  mockPrisma.chatMessage.upsert.mockClear()
  mockPrisma.chatSession.findUnique.mockClear()
})

function withUserSession() {
  const authMod: any = require('../auth')
  authMod.auth.api.getSession = async () => ({
    user: { id: USER, email: 'a@b.c', name: 'A' },
    session: { id: 's1' },
  })
}

const _origError = console.error
const _origWarn = console.warn
function silence() { console.error = () => {}; console.warn = () => {} }
function restore() { console.error = _origError; console.warn = _origWarn }

// ============================================================================
// provision-number debit failure consoles
// ============================================================================

describe('provision-number debit-failure consoles', () => {
  test('logs setup-debit failure but persists config (L1205-1208)', async () => {
    voiceCfg = null
    // First consumeUsage call (setup) → fails. Second (monthly) → ok.
    consumeOutcomes = [
      { success: false, error: 'wallet_unavailable' },
      { success: true },
    ]
    let captured = ''
    console.error = (...args: any[]) => { captured += args.map(String).join(' ') + '\n' }
    console.warn = () => {}
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
        method: 'POST',
        headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      expect(captured).toContain('setup debit failed')
      expect(captured).toContain('wallet_unavailable')
    } finally { restore() }
  })

  test('logs monthly-debit failure but persists config (L1231-1234)', async () => {
    voiceCfg = null
    consumeOutcomes = [
      { success: true },
      { success: false, error: 'monthly_wallet_unavailable' },
    ]
    let captured = ''
    console.error = (...args: any[]) => { captured += args.map(String).join(' ') + '\n' }
    console.warn = () => {}
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
        method: 'POST',
        headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      expect(captured).toContain('monthly debit failed')
      expect(captured).toContain('monthly_wallet_unavailable')
    } finally { restore() }
  })
})

// ============================================================================
// translator/chat outer catch (L741-748)
// ============================================================================

describe('POST /voice/translator/chat/:chatSessionId — streamText throw', () => {
  test('returns 500 with sanitized error when streamText throws', async () => {
    withUserSession()
    sessionRow = { id: SESSION, project: { id: PROJECT, workspaceId: WORKSPACE } }
    memberRow = { id: 'mem-1' }
    streamTextError = new Error('streamText boom')
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/translator/chat/${SESSION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        }),
      })
      expect(res.status).toBe(500)
      const body = await res.json() as any
      expect(body.error).toBe('Translator chat failed')
      expect(body.detail).toBe('streamText boom')
    } finally { restore() }
  })
})

// ============================================================================
// /voice/signed-url shared-agent path — getSignedUrl catch (L580-584)
// ============================================================================

describe('GET /voice/signed-url shared-agent — getSignedUrl throw', () => {
  test('returns 502 when shared-agent getSignedUrl throws', async () => {
    withUserSession()
    sessionRow = { id: SESSION, project: { id: PROJECT, workspaceId: WORKSPACE } }
    elGetSignedUrlError = new Error('shared signed-url boom')
    silence()
    try {
      const app = buildApp()
      // Shared-agent path: no projectId query, must have chatSessionId+session auth.
      const res = await app.request(
        `/api/voice/signed-url?chatSessionId=${SESSION}`,
        { method: 'GET' },
      )
      expect(res.status).toBe(502)
      const body = await res.json() as any
      expect(body.error).toBe('Failed to mint signed URL')
      expect(body.detail).toBe('shared signed-url boom')
    } finally { restore() }
  })
})

// ============================================================================
// /voice/signed-url project path — projectSignedUrlHandler catch (L299-310)
// ============================================================================

describe('GET /voice/signed-url?projectId=... — projectSignedUrlHandler catch', () => {
  test('returns 502 when project-signed-url getSignedUrl throws', async () => {
    resolveVoiceAgentResult = { agentId: 'agent_proj', agentName: 'proj-agent' }
    elGetSignedUrlError = new Error('project signed-url boom')
    silence()
    try {
      const app = buildApp()
      const res = await app.request(
        `/api/voice/signed-url?projectId=${PROJECT}`,
        {
          method: 'GET',
          headers: { 'x-runtime-token': TOKEN },
        },
      )
      expect(res.status).toBe(502)
      const body = await res.json() as any
      expect(body.error).toBe('Failed to mint signed URL')
      expect(body.detail).toBe('project signed-url boom')
    } finally { restore() }
  })

  test('happy path: returns signedUrl + agentId when resolveVoiceAgentForSignedUrl succeeds', async () => {
    resolveVoiceAgentResult = { agentId: 'agent_proj_ok', agentName: 'proj-agent' }
    const app = buildApp()
    const res = await app.request(
      `/api/voice/signed-url?projectId=${PROJECT}&agentName=proj-agent`,
      {
        method: 'GET',
        headers: { 'x-runtime-token': TOKEN },
      },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.signedUrl).toBe('wss://mock/x')
    expect(body.agentId).toBe('agent_proj_ok')
    expect(body.agentName).toBe('proj-agent')
  })

  test('returns 404 when resolveVoiceAgentForSignedUrl returns null', async () => {
    resolveVoiceAgentResult = null
    const app = buildApp()
    const res = await app.request(
      `/api/voice/signed-url?projectId=${PROJECT}&agentName=missing-agent`,
      {
        method: 'GET',
        headers: { 'x-runtime-token': TOKEN },
      },
    )
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error).toContain("missing-agent")
    expect(body.knownAgents).toEqual([])
  })
})

// ============================================================================
// /voice/transcript — upsertShogoTextMessage create branch (L435-443)
// ============================================================================

describe('POST /voice/transcript/:chatSessionId — create branch (no id)', () => {
  test('persists via chatMessage.create when body has no id', async () => {
    withUserSession()
    sessionRow = { id: SESSION, project: { id: PROJECT, workspaceId: WORKSPACE } }
    memberRow = { id: 'mem-1' }
    const app = buildApp()
    const res = await app.request(`/api/voice/transcript/${SESSION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'voice-user',
        text: 'hello-world',
        // no id → triggers create branch
        ts: Date.now(),
      }),
    })
    expect([200, 201]).toContain(res.status)
    expect(mockPrisma.chatMessage.create).toHaveBeenCalled()
  })
})
