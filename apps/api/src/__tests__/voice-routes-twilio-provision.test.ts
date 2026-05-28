// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice routes — Twilio available-numbers + provision-number flows.
 *
 * Complements voice-routes.test.ts (webhooks + read-only) and
 * voice-routes-runtime-token.test.ts (auth surface) by covering:
 *
 *   GET  /voice/twilio/available-numbers/:projectId
 *   POST /voice/twilio/provision-number/:projectId
 *
 * Specifically the catch-blocks and error returns at L938-958, L1031-1042,
 * L1053-1065, L1084-1095, L1098-1110, L1126-1139, L1155-1168, L1170-1175
 * in src/routes/voice.ts which the existing voice-routes tests
 * left uncovered. Together these are ~115 uncov lines.
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? 'el-test'
process.env.ELEVENLABS_VOICE_MODE_AGENT_ID = process.env.ELEVENLABS_VOICE_MODE_AGENT_ID ?? 'agent_shared'
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? 'twilio-test'

const PROJECT = 'proj-1'
const WORKSPACE = 'ws-1'

let voiceCfg: any = null

const mockPrisma = {
  project: {
    findUnique: mock(async (args: any) => {
      const wantsMembers = args?.select && 'members' in args.select
      if (wantsMembers) {
        return {
          workspaceId: WORKSPACE,
          members: [{ userId: 'owner-1' }],
          workspace: { members: [{ userId: 'owner-1' }] },
        }
      }
      return { id: PROJECT, workspaceId: WORKSPACE }
    }),
  },
  user: { findUnique: mock(async () => null) },
  member: { findFirst: mock(async () => null) },
  voiceProjectConfig: {
    findUnique: mock(async () => voiceCfg),
    findFirst: mock(async () => voiceCfg),
    upsert: mock(async (args: any) => ({ ...(voiceCfg ?? {}), ...args.create, ...args.update })),
    update: mock(async (args: any) => {
      voiceCfg = { ...voiceCfg, ...args.data }
      return voiceCfg
    }),
  },
  voiceCallMeter: {
    create: mock(async (args: any) => ({ id: 'meter-new', ...args.data })),
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

// Toggleable EL client behaviour.
let elCreateAgentError: Error | null = null
let elCreatePhoneError: Error | null = null
class MockElevenLabsClient {
  constructor(_cfg: any) {}
  async getSignedUrl(_id: string) { return 'wss://mock/x' }
  async deletePhoneNumber(_id: string) { return undefined }
  async outboundCall(_args: any) { return { callSid: 'CA', conversationId: 'conv' } }
  async createAgent(_args: any) {
    if (elCreateAgentError) throw elCreateAgentError
    return 'agent_new'
  }
  async createPhoneNumberTwilio(_args: any) {
    if (elCreatePhoneError) throw elCreatePhoneError
    return { phoneNumberId: 'EL_PN_NEW' }
  }
}
mock.module('@shogo-ai/sdk/voice', () => ({ ElevenLabsClient: MockElevenLabsClient }))
mock.module('@shogo/agent-runtime/src/voice-mode/translator-persona', () => ({
  TRANSLATOR_SYSTEM_PROMPT: '',
  TRANSLATOR_AI_SDK_TOOLS: {},
  TRANSLATOR_CONTEXT_MARKER: '{{C}}',
  composeVoiceSystemPrompt: (b: string) => b,
}))

let twilioResolve: any = { error: 'unconfigured' }
mock.module('../lib/twilio', () => ({
  resolveShogoTwilioClient: () => twilioResolve,
  verifyTwilioSignature: () => true,
}))

mock.module('../lib/voice-cost', () => ({
  getUsdBalance: async () => usdBalance,
  resolvePlanIdForWorkspace: async () => 'plan_test',
  resolveVoiceRate: () => 0,
  calculateVoiceMinuteCost: () => ({ billedMinutes: 1, rawUsd: 0.1, billedUsd: 0.2, rawUsdPerMinute: 0.1, billedUsdPerMinute: 0.2 }),
  calculateVoiceNumberCost: () => ({ rawUsd: 1, billedUsd: 1.2 }),
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

mock.module('../lib/voice-context', () => ({
  resolveVoiceContext: async () => '',
  composeVoiceSystemPrompt: (b: string) => b,
}))

let usdBalance = 999

// Toggleable Twilio client behaviour.
let twSearchResult: any[] = [{ phoneNumber: '+15551112222', friendlyName: 'Mock' }]
let twSearchError: Error | null = null
let twPurchaseError: Error | null = null
let twReleaseError: Error | null = null
const twMockClient = {
  searchAvailable: async (_args: any) => {
    if (twSearchError) throw twSearchError
    return twSearchResult
  },
  purchaseNumber: async (args: any) => {
    if (twPurchaseError) throw twPurchaseError
    return { sid: 'PN_NEW', phoneNumber: args.phoneNumber }
  },
  releaseNumber: async (_sid: string) => {
    if (twReleaseError) throw twReleaseError
    return undefined
  },
}

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
  twSearchResult = [{ phoneNumber: '+15551112222', friendlyName: 'Mock' }]
  twSearchError = null
  twPurchaseError = null
  twReleaseError = null
  elCreateAgentError = null
  elCreatePhoneError = null
  usdBalance = 999
  twilioResolve = { error: 'unconfigured' }
  mockPrisma.voiceProjectConfig.findUnique.mockClear()
  mockPrisma.voiceProjectConfig.upsert.mockClear()
  mockPrisma.voiceProjectConfig.update.mockClear()
})

function withTwilio() {
  twilioResolve = { client: twMockClient, accountSid: 'AC_test' }
}

// Suppress console.error / console.warn during error-path tests.
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
// GET /voice/twilio/available-numbers/:projectId
// ============================================================================

describe('GET /voice/twilio/available-numbers/:projectId', () => {
  test('returns 503 when Twilio client is unconfigured', async () => {
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/available-numbers/${PROJECT}`, {
      headers: { 'x-runtime-token': TOKEN },
    })
    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.error).toBe('unconfigured')
  })

  test('returns 200 with numbers on happy path (default limit + filters)', async () => {
    withTwilio()
    twSearchResult = [
      { phoneNumber: '+15551112222', friendlyName: 'A' },
      { phoneNumber: '+15551113333', friendlyName: 'B' },
    ]
    const app = buildApp()
    const res = await app.request(
      `/api/voice/twilio/available-numbers/${PROJECT}?country=US&areaCode=415&contains=555&limit=15`,
      { headers: { 'x-runtime-token': TOKEN } },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.numbers).toHaveLength(2)
    expect(body.numbers[0].phoneNumber).toBe('+15551112222')
  })

  test('clamps limit to [1,30] and parses junk as default', async () => {
    withTwilio()
    const app = buildApp()
    // limit=junk → parseInt → NaN → defaults to 10
    const r1 = await app.request(
      `/api/voice/twilio/available-numbers/${PROJECT}?limit=junk`,
      { headers: { 'x-runtime-token': TOKEN } },
    )
    expect(r1.status).toBe(200)
    // limit=999 → clamped to 30
    const r2 = await app.request(
      `/api/voice/twilio/available-numbers/${PROJECT}?limit=999`,
      { headers: { 'x-runtime-token': TOKEN } },
    )
    expect(r2.status).toBe(200)
  })

  test('returns 502 when Twilio searchAvailable throws', async () => {
    withTwilio()
    const err: any = new Error('twilio down')
    err.body = '{"code":"network_error"}'
    twSearchError = err
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/available-numbers/${PROJECT}`, {
        headers: { 'x-runtime-token': TOKEN },
      })
      expect(res.status).toBe(502)
      const body = await res.json() as any
      expect(body.error).toBe('Twilio number search failed')
      expect(body.detail).toBe('twilio down')
      expect(body.twilioBody).toBe('{"code":"network_error"}')
    } finally { restore() }
  })
})

// ============================================================================
// POST /voice/twilio/provision-number/:projectId
// ============================================================================

describe('POST /voice/twilio/provision-number/:projectId', () => {
  test('idempotent re-provision returns existing config', async () => {
    voiceCfg = {
      projectId: PROJECT,
      twilioPhoneSid: 'PN_EXISTING',
      twilioPhoneNumber: '+15550001111',
      elevenlabsPhoneId: 'EL_EXISTING',
      purchasedAt: new Date('2026-01-01'),
    }
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
      method: 'POST',
      headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.alreadyProvisioned).toBe(true)
    expect(body.twilioPhoneSid).toBe('PN_EXISTING')
  })

  test('returns 503 when Twilio client is unconfigured', async () => {
    twilioResolve = { error: 'unconfigured' }
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
      method: 'POST',
      headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(503)
  })

  test('returns 402 when usage balance is too low', async () => {
    withTwilio()
    usdBalance = 0
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
      method: 'POST',
      headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(402)
    const body = await res.json() as any
    expect(body.error.code).toBe('usage_limit_reached')
    expect(body.error.requiredUsd).toBeGreaterThan(0)
  })

  test('returns 502 when EL agent provisioning fails', async () => {
    withTwilio()
    elCreateAgentError = new Error('EL down')
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
        method: 'POST',
        headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(502)
      const body = await res.json() as any
      expect(body.error).toBe('Failed to provision ElevenLabs agent')
    } finally { restore() }
  })

  test('returns 409 when Twilio search returns empty', async () => {
    withTwilio()
    twSearchResult = []
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
      method: 'POST',
      headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ areaCode: '415' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error.code).toBe('no_numbers_available')
    expect(body.error.message).toContain('areaCode=415')
  })

  test('returns 409 with generic message when no areaCode and search empty', async () => {
    withTwilio()
    twSearchResult = []
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
      method: 'POST',
      headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error.message).not.toContain('areaCode=')
  })

  test('returns 502 when Twilio search throws', async () => {
    withTwilio()
    const err: any = new Error('twilio search boom')
    err.body = '{"x":1}'
    twSearchError = err
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
        method: 'POST',
        headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(502)
      const body = await res.json() as any
      expect(body.error).toBe('Twilio number search failed')
    } finally { restore() }
  })

  test('returns 502 when Twilio purchase throws', async () => {
    withTwilio()
    twPurchaseError = new Error('purchase boom')
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
        method: 'POST',
        headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15551118888' }),
      })
      expect(res.status).toBe(502)
      const body = await res.json() as any
      expect(body.error).toBe('Twilio number purchase failed')
      expect(body.phoneNumber).toBe('+15551118888')
    } finally { restore() }
  })

  test('returns 502 + releases Twilio number when EL link fails', async () => {
    withTwilio()
    elCreatePhoneError = new Error('EL link boom')
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
        method: 'POST',
        headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(502)
      const body = await res.json() as any
      expect(body.error).toBe('Failed to link Twilio number to ElevenLabs agent')
    } finally { restore() }
  })

  test('returns 502 + logs compensating-release failure when EL link AND release both fail', async () => {
    withTwilio()
    elCreatePhoneError = new Error('EL link boom')
    twReleaseError = new Error('release boom')
    silence()
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/provision-number/${PROJECT}`, {
        method: 'POST',
        headers: { 'x-runtime-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15554443333' }),
      })
      expect(res.status).toBe(502)
    } finally { restore() }
  })
})
