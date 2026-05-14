// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice routes — webhook + read-only endpoint coverage.
 *
 * Complements `voice-routes-runtime-token.test.ts` (which focuses on
 * runtime-token auth on the signed-url / config / provision paths) by
 * exercising the routes that take webhook signatures or that simply
 * read from `voiceProjectConfig` / `voiceCallMeter` / `usageEvent`:
 *
 *   - POST /voice/elevenlabs/webhook  (signature / payload / scoping)
 *   - POST /voice/twilio/status/:projectId
 *   - GET  /voice/config/:projectId
 *   - GET  /voice/usage/:projectId
 *   - GET  /voice/calls/:projectId
 *   - GET  /voice/calls/:projectId/:callId
 *   - DELETE /voice/twilio/number/:projectId
 *   - POST /projects/:projectId/agents/sync (validation surface)
 *
 *   bun test apps/api/src/__tests__/voice-routes.test.ts
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
let calls: any[] = []
let events: any[] = []

const mockPrisma = {
  project: {
    findUnique: mock(async (args: any) => {
      // authMiddleware (runtime-token path) requests the workspaceId +
      // members + workspace.members shape; everything else just wants
      // { id, workspaceId }.
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
    findMany: mock(async () => calls),
    findFirst: mock(async ({ where }: any) => {
      const callId = where?.OR?.[0]?.id ?? null
      return calls.find((c) => c.id === callId || c.conversationId === callId || c.callSid === callId) ?? null
    }),
  },
  usageEvent: {
    findMany: mock(async () => events),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../auth', () => ({
  auth: { api: { getSession: mock(() => Promise.resolve(null)) } },
}))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(() => Promise.resolve(null)),
}))

// ElevenLabs / Twilio / agent-runtime persona stubs.
class MockElevenLabsClient {
  constructor(_cfg: any) {}
  async getSignedUrl(_id: string) { return 'wss://mock/x' }
  async deletePhoneNumber(_id: string) { return undefined }
}
mock.module('@shogo-ai/sdk/voice', () => ({ ElevenLabsClient: MockElevenLabsClient }))
mock.module('@shogo/agent-runtime/src/voice-mode/translator-persona', () => ({
  TRANSLATOR_SYSTEM_PROMPT: '',
  TRANSLATOR_AI_SDK_TOOLS: {},
  TRANSLATOR_CONTEXT_MARKER: '{{C}}',
  composeVoiceSystemPrompt: (b: string) => b,
}))

let twilioResolve: any = { error: 'unconfigured' }
let twilioSigOk = true
mock.module('../lib/twilio', () => ({
  resolveShogoTwilioClient: () => twilioResolve,
  verifyTwilioSignature: () => twilioSigOk,
}))

mock.module('../lib/voice-cost', () => ({
  getUsdBalance: async () => 999,
  resolvePlanIdForWorkspace: async () => 'plan_test',
  resolveVoiceRate: () => 0,
  calculateVoiceMinuteCost: () => ({ billedMinutes: 1, rawUsd: 0.1, billedUsd: 0.2, rawUsdPerMinute: 0.1, billedUsdPerMinute: 0.2 }),
  calculateVoiceNumberCost: () => ({ rawUsd: 2, billedUsd: 2.4 }),
}))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true }),
}))

let elSigOk = true
const recordCallUsage = mock(async (_args: any) => ({ ok: true, billedMinutes: 1, billedUsd: 0.2, alreadyBilled: false }))
mock.module('../lib/voice-meter', () => ({
  recordCallUsage,
  verifyElevenLabsSignature: () => elSigOk,
}))

const syncProjectAgentsMock = mock(async (_args: any) => ({
  created: [], updated: [], deleted: [], errors: [], dryRun: false,
}))
mock.module('../services/projectAgentSync.service', () => ({
  syncProjectAgents: syncProjectAgentsMock,
}))

// Voice context resolver: keep deterministic.
mock.module('../lib/voice-context', () => ({
  resolveVoiceContext: async () => '',
  composeVoiceSystemPrompt: (b: string) => b,
}))

// Imports AFTER mocks.
const { authMiddleware } = await import('../middleware/auth')
const { voiceRoutes } = await import('../routes/voice')
const { deriveRuntimeToken } = await import('../lib/runtime-token')

function buildApp() {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.route('/api', voiceRoutes())
  return app
}

beforeEach(() => {
  voiceCfg = null
  calls = []
  events = []
  twilioResolve = { error: 'unconfigured' }
  twilioSigOk = true
  elSigOk = true
  mockPrisma.voiceProjectConfig.findUnique.mockClear()
  mockPrisma.voiceProjectConfig.findFirst.mockClear()
  mockPrisma.voiceProjectConfig.update.mockClear()
  mockPrisma.voiceCallMeter.findMany.mockClear()
  mockPrisma.voiceCallMeter.findFirst.mockClear()
  mockPrisma.usageEvent.findMany.mockClear()
  recordCallUsage.mockClear()
  syncProjectAgentsMock.mockClear()
})

let TOKEN: string
beforeAll(() => {
  TOKEN = deriveRuntimeToken(PROJECT)
})

// =========================================================================
// /voice/config/:projectId
// =========================================================================

describe('GET /voice/config/:projectId', () => {
  test('returns provisioned=false when no row exists', async () => {
    const app = buildApp()
    const res = await app.request(`/api/voice/config/${PROJECT}`, { headers: { 'x-runtime-token': TOKEN } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ provisioned: false })
  })

  test('returns the phone metadata when a row exists', async () => {
    voiceCfg = {
      projectId: PROJECT,
      twilioPhoneNumber: '+15551112222',
      twilioPhoneSid: 'PN_123',
      elevenlabsPhoneId: 'EL_PN',
      elevenlabsAgentId: 'agent_x',
      purchasedAt: new Date('2026-01-01'),
      monthlyRateDebitedFor: new Date('2026-05-01'),
    }
    const app = buildApp()
    const res = await app.request(`/api/voice/config/${PROJECT}`, { headers: { 'x-runtime-token': TOKEN } })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.provisioned).toBe(true)
    expect(body.phoneNumber).toBe('+15551112222')
    expect(body.elevenlabsAgentId).toBe('agent_x')
  })

  test('401 when caller is unauthenticated', async () => {
    const app = buildApp()
    const res = await app.request(`/api/voice/config/${PROJECT}`)
    expect(res.status).toBe(401)
  })
})

// =========================================================================
// /voice/usage/:projectId
// =========================================================================

describe('GET /voice/usage/:projectId', () => {
  test('aggregates inbound, outbound, and number-setup billed amounts', async () => {
    events = [
      { id: 'e1', actionType: 'voice_minutes_inbound', billedUsd: 0.2, rawUsd: 0.1, createdAt: new Date(), actionMetadata: { billedMinutes: 2 } },
      { id: 'e2', actionType: 'voice_minutes_outbound', billedUsd: 0.5, rawUsd: 0.25, createdAt: new Date(), actionMetadata: { billedMinutes: 3 } },
      { id: 'e3', actionType: 'voice_number_setup', billedUsd: 5, rawUsd: 4, createdAt: new Date(), actionMetadata: null },
    ]
    const app = buildApp()
    const res = await app.request(`/api/voice/usage/${PROJECT}`, { headers: { 'x-runtime-token': TOKEN } })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.totals.minutesInbound).toBe(2)
    expect(body.totals.minutesOutbound).toBe(3)
    expect(body.totals.billedUsdInbound).toBeCloseTo(0.2)
    expect(body.totals.billedUsdOutbound).toBeCloseTo(0.5)
    expect(body.totals.billedUsdNumbers).toBe(5)
    expect(body.totals.inboundCalls).toBe(1)
    expect(body.totals.outboundCalls).toBe(1)
  })

  test('parses from/to query params (ignores malformed values)', async () => {
    const app = buildApp()
    const res = await app.request(
      `/api/voice/usage/${PROJECT}?from=2026-01-01&to=not-a-date`,
      { headers: { 'x-runtime-token': TOKEN } },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.range.from).toBe(new Date('2026-01-01').toISOString())
    expect(body.range.to).toBeNull()
  })

  test('parses string actionMetadata (legacy rows)', async () => {
    events = [
      { id: 'e1', actionType: 'voice_minutes_inbound', billedUsd: 0.2, rawUsd: 0.1, createdAt: new Date(), actionMetadata: JSON.stringify({ billedMinutes: 4 }) },
      { id: 'e2', actionType: 'voice_minutes_inbound', billedUsd: 0.1, rawUsd: 0.05, createdAt: new Date(), actionMetadata: 'not json' },
    ]
    const app = buildApp()
    const res = await app.request(`/api/voice/usage/${PROJECT}`, { headers: { 'x-runtime-token': TOKEN } })
    const body = await res.json() as any
    expect(body.totals.minutesInbound).toBe(4)
  })
})

// =========================================================================
// /voice/calls/:projectId  and  /voice/calls/:projectId/:callId
// =========================================================================

describe('GET /voice/calls/:projectId', () => {
  test('lists calls and respects limit + includeTranscript', async () => {
    calls = [
      {
        id: 'c1', conversationId: 'conv-1', callSid: 'CA-1', direction: 'inbound',
        durationSeconds: 60, billedMinutes: 1,
        startedAt: new Date(), endedAt: new Date(), createdAt: new Date(),
        usageEventId: 'u1',
        transcript: [{ role: 'user', text: 'hi' }],
        transcriptSummary: 'a quick chat',
      },
    ]
    const app = buildApp()
    const res = await app.request(
      `/api/voice/calls/${PROJECT}?includeTranscript=1&limit=10`,
      { headers: { 'x-runtime-token': TOKEN } },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.calls.length).toBe(1)
    expect(body.calls[0].hasTranscript).toBe(true)
    expect(Array.isArray(body.calls[0].transcript)).toBe(true)
  })

  test('omits transcript when includeTranscript flag is absent', async () => {
    calls = [{
      id: 'c1', conversationId: null, callSid: null, direction: 'outbound',
      durationSeconds: 0, billedMinutes: 0,
      startedAt: null, endedAt: null, createdAt: new Date(),
      usageEventId: null, transcript: null, transcriptSummary: null,
    }]
    const app = buildApp()
    const res = await app.request(`/api/voice/calls/${PROJECT}`, { headers: { 'x-runtime-token': TOKEN } })
    const body = await res.json() as any
    expect(body.calls[0].transcript).toBeUndefined()
    expect(body.calls[0].hasTranscript).toBe(false)
  })
})

describe('GET /voice/calls/:projectId/:callId', () => {
  test('returns 404 when no call matches', async () => {
    const app = buildApp()
    const res = await app.request(`/api/voice/calls/${PROJECT}/unknown`, { headers: { 'x-runtime-token': TOKEN } })
    expect(res.status).toBe(404)
  })

  test('looks up by id / conversationId / callSid', async () => {
    calls = [{
      id: 'c1', conversationId: 'conv-1', callSid: 'CA-1', direction: 'inbound',
      durationSeconds: 30, billedMinutes: 1,
      startedAt: new Date(), endedAt: new Date(), createdAt: new Date(),
      usageEventId: 'u1', transcript: ['x'], transcriptSummary: 's',
    }]
    const app = buildApp()
    const res = await app.request(`/api/voice/calls/${PROJECT}/conv-1`, { headers: { 'x-runtime-token': TOKEN } })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.id).toBe('c1')
    expect(body.transcript).toEqual(['x'])
  })
})

// =========================================================================
// /voice/elevenlabs/webhook
// =========================================================================

describe('POST /voice/elevenlabs/webhook', () => {
  test('503 when ELEVENLABS_WEBHOOK_SECRET unset', async () => {
    const saved = process.env.ELEVENLABS_WEBHOOK_SECRET
    delete process.env.ELEVENLABS_WEBHOOK_SECRET
    try {
      const app = buildApp()
      const res = await app.request('/api/voice/elevenlabs/webhook', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      expect(res.status).toBe(503)
    } finally {
      if (saved !== undefined) process.env.ELEVENLABS_WEBHOOK_SECRET = saved
    }
  })

  test('401 when signature does not verify', async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = 'sek'
    elSigOk = false
    const app = buildApp()
    const res = await app.request('/api/voice/elevenlabs/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'elevenlabs-signature': 'bad' }, body: '{}',
    })
    expect(res.status).toBe(401)
  })

  test('400 when payload is not JSON', async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = 'sek'
    elSigOk = true
    const app = buildApp()
    const res = await app.request('/api/voice/elevenlabs/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'elevenlabs-signature': 'sig' }, body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  test('ignores webhooks that lack a conversation_id and call_sid', async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = 'sek'
    elSigOk = true
    const app = buildApp()
    const res = await app.request('/api/voice/elevenlabs/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'elevenlabs-signature': 'sig' },
      body: JSON.stringify({ data: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ignored).toBeDefined()
  })

  test('ignores webhooks for unscoped agents (no matching project)', async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = 'sek'
    elSigOk = true
    voiceCfg = null
    const app = buildApp()
    const res = await app.request('/api/voice/elevenlabs/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'elevenlabs-signature': 'sig' },
      body: JSON.stringify({ data: { conversation_id: 'c1', agent_id: 'ag_x', metadata: { call_duration_secs: 60 } } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ignored).toBe('no_project_scope')
  })

  test('records call usage on a scoped, well-formed webhook', async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = 'sek'
    elSigOk = true
    voiceCfg = { projectId: PROJECT, workspaceId: WORKSPACE, elevenlabsAgentId: 'ag_x' }
    const app = buildApp()
    const res = await app.request('/api/voice/elevenlabs/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'elevenlabs-signature': 'sig' },
      body: JSON.stringify({
        data: {
          conversation_id: 'c1',
          agent_id: 'ag_x',
          metadata: { call_duration_secs: 60, phone_call: { direction: 'outbound', external_number: '+15551110000' } },
          analysis: { transcript_summary: 'hi' },
          transcript: [{ role: 'user', text: 'hi' }],
        },
      }),
    })
    expect(res.status).toBe(200)
    expect(recordCallUsage).toHaveBeenCalled()
    const body = await res.json() as any
    expect(body.ok).toBe(true)
  })

  test('returns 500 when recordCallUsage throws', async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = 'sek'
    elSigOk = true
    voiceCfg = { projectId: PROJECT, workspaceId: WORKSPACE, elevenlabsAgentId: 'ag_x' }
    recordCallUsage.mockImplementationOnce(async () => { throw new Error('billing exploded') })
    const app = buildApp()
    const res = await app.request('/api/voice/elevenlabs/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'elevenlabs-signature': 'sig' },
      body: JSON.stringify({ data: { conversation_id: 'c1', agent_id: 'ag_x', metadata: {} } }),
    })
    expect(res.status).toBe(500)
  })
})

// =========================================================================
// /voice/twilio/status/:projectId
// =========================================================================

describe('POST /voice/twilio/status/:projectId', () => {
  test('503 when TWILIO_AUTH_TOKEN is unset', async () => {
    const saved = process.env.TWILIO_AUTH_TOKEN
    delete process.env.TWILIO_AUTH_TOKEN
    try {
      const app = buildApp()
      const res = await app.request(`/api/voice/twilio/status/${PROJECT}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'CallSid=CA',
      })
      expect(res.status).toBe(503)
    } finally {
      process.env.TWILIO_AUTH_TOKEN = saved
    }
  })

  test('401 when twilio signature fails to verify', async () => {
    twilioSigOk = false
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/status/${PROJECT}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bad' },
      body: 'CallSid=CA-1&CallStatus=completed',
    })
    expect(res.status).toBe(401)
  })

  test('non-terminal status is ignored', async () => {
    twilioSigOk = true
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/status/${PROJECT}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'sig' },
      body: 'CallSid=CA-1&CallStatus=ringing',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ignored).toBe('status=ringing')
  })

  test('terminal status without a matching config is ignored', async () => {
    twilioSigOk = true
    voiceCfg = null
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/status/${PROJECT}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'sig' },
      body: 'CallSid=CA-1&CallStatus=completed&CallDuration=60&Direction=outbound-api',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ignored).toBe('project_not_configured')
  })

  test('terminal status with a project_configured record records usage', async () => {
    twilioSigOk = true
    voiceCfg = { projectId: PROJECT, workspaceId: WORKSPACE }
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/status/${PROJECT}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'sig' },
      body: 'CallSid=CA-1&CallStatus=completed&CallDuration=60&Direction=inbound&From=%2B15551110000&To=%2B15552220000',
    })
    expect(res.status).toBe(200)
    expect(recordCallUsage).toHaveBeenCalled()
  })

  test('missing CallSid is ignored after sig passes', async () => {
    twilioSigOk = true
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/status/${PROJECT}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'sig' },
      body: 'CallStatus=completed',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ignored).toBe('no CallSid')
  })
})

// =========================================================================
// DELETE /voice/twilio/number/:projectId
// =========================================================================

describe('DELETE /voice/twilio/number/:projectId', () => {
  test('returns released=false when no twilioPhoneSid is set', async () => {
    voiceCfg = { projectId: PROJECT }
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/number/${PROJECT}`, {
      method: 'DELETE', headers: { 'x-runtime-token': TOKEN },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.released).toBe(false)
    expect(body.reason).toBe('no_number')
  })

  test('reports warnings when twilio is unconfigured but still clears the row', async () => {
    voiceCfg = { projectId: PROJECT, twilioPhoneSid: 'PN_1', elevenlabsPhoneId: 'EL_1' }
    twilioResolve = { error: 'twilio missing' }
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/number/${PROJECT}`, {
      method: 'DELETE', headers: { 'x-runtime-token': TOKEN },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.released).toBe(true)
    expect(Array.isArray(body.warnings)).toBe(true)
    expect(mockPrisma.voiceProjectConfig.update).toHaveBeenCalled()
  })

  test('releases through the twilio client when available', async () => {
    voiceCfg = { projectId: PROJECT, twilioPhoneSid: 'PN_2' }
    const releaseSpy = mock(async (_sid: string) => undefined)
    twilioResolve = {
      client: {
        releaseNumber: releaseSpy,
        searchAvailable: async () => [],
        purchaseNumber: async () => ({}),
      },
      accountSid: 'AC',
    }
    const app = buildApp()
    const res = await app.request(`/api/voice/twilio/number/${PROJECT}`, {
      method: 'DELETE', headers: { 'x-runtime-token': TOKEN },
    })
    expect(res.status).toBe(200)
    expect(releaseSpy).toHaveBeenCalled()
  })
})

// =========================================================================
// POST /projects/:projectId/agents/sync — validation surface
// =========================================================================

describe('POST /projects/:projectId/agents/sync', () => {
  test('400 on invalid JSON body', async () => {
    const app = buildApp()
    const res = await app.request(`/api/projects/${PROJECT}/agents/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-runtime-token': TOKEN },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  test('happy path delegates to syncProjectAgents', async () => {
    const app = buildApp()
    const res = await app.request(`/api/projects/${PROJECT}/agents/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-runtime-token': TOKEN },
      body: JSON.stringify({ agents: { architect: {} }, prune: true, dryRun: true }),
    })
    expect(res.status).toBe(200)
    expect(syncProjectAgentsMock).toHaveBeenCalled()
  })

  test('500 when the service throws', async () => {
    syncProjectAgentsMock.mockImplementationOnce(async () => { throw new Error('boom') })
    const app = buildApp()
    const res = await app.request(`/api/projects/${PROJECT}/agents/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-runtime-token': TOKEN },
      body: JSON.stringify({ agents: {} }),
    })
    expect(res.status).toBe(500)
  })
})
