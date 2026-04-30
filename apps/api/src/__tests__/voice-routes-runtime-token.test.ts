// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice routes x runtime-token integration tests
 *
 * Exercises the REAL `authMiddleware` + `voiceRoutes()` Hono router with
 * mocked Prisma / ElevenLabs / Twilio / billing deps, to assert that the
 * new `x-runtime-token` auth path:
 *
 *   1. Authenticates + authorizes a request whose query/param projectId
 *      matches the token scope (GET /voice/signed-url?projectId=X,
 *      GET /voice/config/:projectId, POST /voice/twilio/provision-number/:projectId).
 *   2. Rejects a request whose projectId does not match the token (403).
 *   3. Rejects shared-agent /voice/signed-url (no projectId) presented
 *      with a runtime token — it has no scope, so must 401.
 *
 * Run: bun test apps/api/src/__tests__/voice-routes-runtime-token.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

// ─── Shared env ───────────────────────────────────────────────────────────
process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token'
process.env.ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY ?? 'test-el-key'
process.env.ELEVENLABS_VOICE_MODE_AGENT_ID =
  process.env.ELEVENLABS_VOICE_MODE_AGENT_ID ?? 'agent_shared_shogo_mode'
process.env.TWILIO_AUTH_TOKEN =
  process.env.TWILIO_AUTH_TOKEN ?? 'test-twilio-auth-token'

// ─── Prisma mock ──────────────────────────────────────────────────────────
type ProjectFixture = {
  id: string
  workspaceId: string
  projectOwnerUserId?: string
  workspaceOwnerUserId?: string
}
const projectsById = new Map<string, ProjectFixture>()
const voiceConfigByProjectId = new Map<string, any>()

const mockPrisma = {
  project: {
    findUnique: mock(async (args: any) => {
      const p = projectsById.get(args.where.id)
      if (!p) return null
      // Match the shape requested by authMiddleware for runtime-token
      // auth: `select: { workspaceId, members, workspace.members }`.
      const wantsMembers =
        args.select && 'members' in args.select
      if (wantsMembers) {
        return {
          workspaceId: p.workspaceId,
          members: p.projectOwnerUserId
            ? [{ userId: p.projectOwnerUserId }]
            : [],
          workspace: {
            members: p.workspaceOwnerUserId
              ? [{ userId: p.workspaceOwnerUserId }]
              : [],
          },
        }
      }
      return { id: p.id, workspaceId: p.workspaceId }
    }),
  },
  user: {
    findUnique: mock(async () => null),
  },
  member: {
    findFirst: mock(async () => null),
  },
  voiceProjectConfig: {
    findUnique: mock(async (args: any) => {
      const row = voiceConfigByProjectId.get(args.where.projectId)
      return row ? { ...row } : null
    }),
    upsert: mock(async (args: any) => {
      const existing = voiceConfigByProjectId.get(args.where.projectId)
      const merged = { ...existing, ...args.update, ...args.create }
      voiceConfigByProjectId.set(args.where.projectId, merged)
      return merged
    }),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../auth', () => ({
  auth: { api: { getSession: mock(() => Promise.resolve(null)) } },
}))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(() => Promise.resolve(null)),
}))

// ─── Shogo SDK voice mock — we never talk to real ElevenLabs ──────────────
const getSignedUrlMock = mock(async (_agentId: string) => 'wss://mock.elevenlabs/signed?x=1')
const createAgentMock = mock(async (_opts: any) => 'agent_mocked_xyz')
const createPhoneNumberTwilioMock = mock(async (_opts: any) => ({
  phoneNumberId: 'PHN_mock',
}))
class MockElevenLabsClient {
  constructor(_cfg: any) {}
  getSignedUrl = getSignedUrlMock
  createAgent = createAgentMock
  createPhoneNumberTwilio = createPhoneNumberTwilioMock
}
mock.module('@shogo-ai/sdk/voice', () => ({
  ElevenLabsClient: MockElevenLabsClient,
}))

// Translator persona import is not exercised here — stub to no-op so
// voice.ts's module-eval doesn't need the full agent-runtime package.
mock.module('@shogo/agent-runtime/src/voice-mode/translator-persona', () => ({
  TRANSLATOR_SYSTEM_PROMPT: '',
  TRANSLATOR_AI_SDK_TOOLS: {},
  TRANSLATOR_CONTEXT_MARKER: '{{PROJECT_CONTEXT}}',
  composeVoiceSystemPrompt: (base: string, _ctx: string) => base,
}))

// Twilio / billing / voice-meter — provisioning route touches these
// right after `authorizeProject`. Stub them enough to reach a
// deterministic response code. The default twilio stub returns an
// error (most tests short-circuit early on 503); tests that need to
// reach `consumeUsage` install a success client into
// `twilioResolveState` before issuing the request.
type TwilioResolveResult =
  | { error: string }
  | {
      client: {
        searchAvailable: (opts: any) => Promise<any[]>
        purchaseNumber: (opts: any) => Promise<any>
        releaseNumber?: (sid: string) => Promise<any>
      }
      accountSid: string
    }
let twilioResolveState: TwilioResolveResult = {
  error: 'twilio not configured in test',
}
mock.module('../lib/twilio', () => ({
  resolveShogoTwilioClient: () => twilioResolveState,
  verifyTwilioSignature: () => true,
}))
mock.module('../lib/voice-cost', () => ({
  resolveVoiceRate: () => 0,
  resolvePlanIdForWorkspace: async () => 'plan_test',
  getUsdBalance: async () => 1000,
  calculateVoiceMinuteCost: () => ({
    billedMinutes: 1,
    rawUsd: 0.2,
    billedUsd: 0.24,
    rawUsdPerMinute: 0.2,
    billedUsdPerMinute: 0.24,
  }),
  calculateVoiceNumberCost: () => ({ rawUsd: 2, billedUsd: 2.4 }),
}))

// Capture consumeUsage args so the memberId contract can be asserted.
// The new billing API takes a single object arg (workspaceId, projectId,
// memberId, actionType, rawUsd, billedUsd, actionMetadata). Default
// return shape matches what voice.ts checks (`.success`).
const consumeUsageMock = mock(async (args: { memberId: string }) => {
  void args
  return { success: true }
})
mock.module('../services/billing.service', () => ({
  consumeUsage: consumeUsageMock,
}))
mock.module('../lib/voice-meter', () => ({
  recordCallUsage: async () => ({ ok: true }),
  verifyElevenLabsSignature: () => true,
}))

// ─── Import real code under test (AFTER mocks) ────────────────────────────
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { authMiddleware } = await import('../middleware/auth')
const { voiceRoutes } = await import('../routes/voice')

function createApp() {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.route('/api', voiceRoutes())
  return app
}

const PROJECT_A = 'proj_aaaaaaaa'
const WORKSPACE_A = 'ws_aaaaaaaa'
const USER_OWNER_A = 'user_owner_a'
const PROJECT_B = 'proj_bbbbbbbb'
const WORKSPACE_B = 'ws_bbbbbbbb'
const USER_OWNER_B = 'user_owner_b'

beforeEach(() => {
  projectsById.clear()
  voiceConfigByProjectId.clear()
  projectsById.set(PROJECT_A, {
    id: PROJECT_A,
    workspaceId: WORKSPACE_A,
    projectOwnerUserId: USER_OWNER_A,
  })
  projectsById.set(PROJECT_B, {
    id: PROJECT_B,
    workspaceId: WORKSPACE_B,
    projectOwnerUserId: USER_OWNER_B,
  })
  mockPrisma.user.findUnique.mockClear()
  mockPrisma.member.findFirst.mockClear()
  mockPrisma.project.findUnique.mockClear()
  mockPrisma.voiceProjectConfig.findUnique.mockClear()
  mockPrisma.voiceProjectConfig.upsert.mockClear()
  getSignedUrlMock.mockClear()
  createAgentMock.mockClear()
  createPhoneNumberTwilioMock.mockClear()
  consumeUsageMock.mockClear()
  twilioResolveState = { error: 'twilio not configured in test' }
})

// ─── Tests ────────────────────────────────────────────────────────────────

describe('GET /api/voice/signed-url?projectId=X with x-runtime-token', () => {
  test('matching project → 200 { signedUrl, agentId }', async () => {
    const app = createApp()
    const token = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/signed-url?projectId=${PROJECT_A}`,
      { method: 'GET', headers: { 'x-runtime-token': token } },
    )
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.signedUrl).toBe('wss://mock.elevenlabs/signed?x=1')
    expect(typeof body.agentId).toBe('string')
    expect(getSignedUrlMock).toHaveBeenCalled()
    // Runtime-token path must not hit user/member lookups.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.member.findFirst).not.toHaveBeenCalled()
  })

  test('token for project A presented with projectId=B → 403 (scope mismatch)', async () => {
    // v1 semantics: the tokenA authenticates as project A (scope comes
    // from the token itself). `authorizeProject` then runs against the
    // request's target (B from `?projectId=B`) and returns 403. Pre-v1
    // this surfaced as 401 at the HMAC check; 403 is the more honest
    // code — see runtime-token.md §9.
    const app = createApp()
    const tokenA = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/signed-url?projectId=${PROJECT_B}`,
      { method: 'GET', headers: { 'x-runtime-token': tokenA } },
    )
    expect(res.status).toBe(403)
  })

  test('shared-agent path (no projectId) with runtime-token → 403 (explicit rejection)', async () => {
    // Per runtime-token.md §5: shared-agent voice endpoints are NOT
    // reachable via runtime-token. Pre-v1 this was enforced implicitly
    // (no projectId on the request meant the middleware never minted
    // runtime-auth → 401 from requireAuth). v1 tokens self-identify,
    // so the middleware now authenticates the caller; the shared-agent
    // branch of the handler rejects `via === 'runtimeToken'` explicitly
    // (pattern matches the translator gate in §7).
    const app = createApp()
    const token = deriveRuntimeToken(PROJECT_A)
    const res = await app.request('/api/voice/signed-url', {
      method: 'GET',
      headers: { 'x-runtime-token': token },
    })
    expect(res.status).toBe(403)
    const body: any = await res.json()
    expect(body.error.code).toBe('forbidden')
  })

  test('no auth header at all → 401', async () => {
    const app = createApp()
    const res = await app.request(
      `/api/voice/signed-url?projectId=${PROJECT_A}`,
      { method: 'GET' },
    )
    expect(res.status).toBe(401)
  })
})

describe('GET /api/voice/config/:projectId with x-runtime-token', () => {
  // HISTORICAL NOTE: app-level `authMiddleware` can't see Hono route
  // params from wildcard-mounted middleware, so the SDK used to append
  // `?projectId=` to every URL as a workaround. The v1 runtime token
  // embeds projectId in the bearer itself, making that workaround
  // unnecessary; these tests keep the `?projectId=` to continue
  // exercising the rollout-compat path (belt and suspenders).

  test('matching project, no config row → 200 { provisioned: false }', async () => {
    const app = createApp()
    const token = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/config/${PROJECT_A}?projectId=${PROJECT_A}`,
      { headers: { 'x-runtime-token': token } },
    )
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.provisioned).toBe(false)
  })

  test('matching project with existing config → 200 with real fields', async () => {
    voiceConfigByProjectId.set(PROJECT_A, {
      projectId: PROJECT_A,
      twilioPhoneNumber: '+15551234567',
      twilioPhoneSid: 'PN_test',
      elevenlabsPhoneId: 'PHN_test',
      elevenlabsAgentId: 'agent_test',
      purchasedAt: new Date('2026-01-01'),
      monthlyRateDebitedFor: new Date('2026-04-01'),
    })
    const app = createApp()
    const token = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/config/${PROJECT_A}?projectId=${PROJECT_A}`,
      { headers: { 'x-runtime-token': token } },
    )
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.provisioned).toBe(true)
    expect(body.phoneNumber).toBe('+15551234567')
    expect(body.elevenlabsAgentId).toBe('agent_test')
  })

  test('token for A + path/query for B → 403 (scope mismatch caught downstream)', async () => {
    // With v1 self-identifying tokens: the token for A authenticates
    // the caller as A regardless of path/query hints. `authorizeProject`
    // is then invoked against the request's target project (B from the
    // path) and rejects the cross-project access with 403.
    // Pre-v1 this surfaced as 401 at the HMAC check — both outcomes
    // block access, but 403 is the more honest code
    // (see runtime-token.md §9).
    const app = createApp()
    const tokenA = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/config/${PROJECT_B}?projectId=${PROJECT_B}`,
      { headers: { 'x-runtime-token': tokenA } },
    )
    expect(res.status).toBe(403)
  })

  test('token scope mismatch: path projectId=B, query projectId=A → 403 forbidden', async () => {
    // Token authenticates (query matches), but `authorizeProject` is
    // called against the path param (B) and must reject because the
    // token only grants scope to A.
    const app = createApp()
    const tokenA = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/config/${PROJECT_B}?projectId=${PROJECT_A}`,
      { headers: { 'x-runtime-token': tokenA } },
    )
    expect(res.status).toBe(403)
    const body: any = await res.json()
    expect(body.error.code).toBe('forbidden')
  })
})

describe('POST /api/voice/twilio/provision-number/:projectId with x-runtime-token', () => {
  test('matching project → passes auth; fails on missing twilio env (503)', async () => {
    const app = createApp()
    const token = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/twilio/provision-number/${PROJECT_A}?projectId=${PROJECT_A}`,
      {
        method: 'POST',
        headers: { 'x-runtime-token': token, 'content-type': 'application/json' },
        body: '{}',
      },
    )
    // If auth + authorize succeed we reach `resolveShogoTwilioClient()`
    // which is mocked to return { error }, yielding 503. The critical
    // assertion: NOT 401/403 (auth/authz passed).
    expect([200, 503]).toContain(res.status)
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })

  test('token scope mismatch (path=B, query=A) → 403 forbidden', async () => {
    const app = createApp()
    const tokenA = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/twilio/provision-number/${PROJECT_B}?projectId=${PROJECT_A}`,
      {
        method: 'POST',
        headers: { 'x-runtime-token': tokenA, 'content-type': 'application/json' },
        body: '{}',
      },
    )
    expect(res.status).toBe(403)
    const body: any = await res.json()
    expect(body.error.code).toBe('forbidden')
  })

  /**
   * Gotcha 3 in apps/api/src/lib/runtime-token.md: runtime-token callers
   * carry a real project-owner userId, so billable actions attribute to
   * the owner in `UsageEvent.memberId` (via `auditMemberId` → `consumeUsage`).
   * Before the real-userId resolution, this wrote the synthetic
   * `runtime:<projectId>` string into analytics — this test locks the new
   * contract in place.
   */
  test('billed actions attribute `memberId` to the real project owner', async () => {
    // Wire the twilio stub into full success so the provision path
    // reaches `consumeUsage`. Keep it scoped to this test — the
    // `beforeEach` resets `twilioResolveState` to the default error
    // stub so other tests stay deterministic.
    twilioResolveState = {
      client: {
        searchAvailable: async () => [
          { phoneNumber: '+15551234567', friendlyName: 'Test Number' },
        ],
        purchaseNumber: async (_opts: any) => ({
          sid: 'PN_mock_test',
          phoneNumber: '+15551234567',
        }),
        releaseNumber: async () => ({ released: true }),
      },
      accountSid: 'AC_mock_test',
    }

    const app = createApp()
    const token = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/twilio/provision-number/${PROJECT_A}?projectId=${PROJECT_A}`,
      {
        method: 'POST',
        headers: { 'x-runtime-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ country: 'US' }),
      },
    )

    // We only care that provisioning reached `consumeUsage` with the
    // right memberId. Whether the 200 happens depends on downstream
    // Prisma shape — accept any non-auth status here.
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)

    // consumeUsage must have been called and memberId must be the
    // real project-owner userId, NOT a synthetic `runtime:<projectId>`
    // string, NOT `voice-system`.
    expect(consumeUsageMock).toHaveBeenCalled()
    const firstCall = consumeUsageMock.mock.calls[0]!
    const memberIdArg = firstCall[0].memberId
    expect(typeof memberIdArg).toBe('string')
    expect(memberIdArg).toBe(USER_OWNER_A)
    expect(memberIdArg.startsWith('runtime:')).toBe(false)
    expect(memberIdArg).not.toBe('voice-system')

    // And the debit must be in USD shape, not credit shape.
    expect(typeof firstCall[0].rawUsd).toBe('number')
    expect(typeof firstCall[0].billedUsd).toBe('number')
    expect(firstCall[0].billedUsd).toBeGreaterThanOrEqual(firstCall[0].rawUsd)
  })
})

/**
 * Gotcha 7 in apps/api/src/lib/runtime-token.md: translator endpoints are
 * per-end-user and must NOT honor runtime-token auth. `authorizeChatSession`
 * explicitly rejects `auth.via === 'runtimeToken'` so the misleading
 * "not accessible to this user" 403 that would otherwise arise from the
 * membership lookup is replaced by a clearer, scope-aware 403.
 *
 * The `via`-based check is load-bearing: per §3 the middleware now stamps
 * a real project-owner userId for runtime callers, so a userId
 * string-prefix check would silently accept them. This test would still
 * pass if we reverted to a prefix check — the explicit `via` assertion
 * is the invariant we care about.
 *
 * The test uses a `?projectId=` query param so `authMiddleware` DOES stamp
 * `via: 'runtimeToken'` on the request (that's the worst case — token
 * validated + project-scoped + STILL rejected for this route).
 */
describe('POST /api/voice/translator/chat/:chatSessionId — runtime-token rejection', () => {
  test('valid runtime token for the owning project → 403 (not user-scoped)', async () => {
    const app = createApp()
    const token = deriveRuntimeToken(PROJECT_A)
    const res = await app.request(
      `/api/voice/translator/chat/cs_test123?projectId=${PROJECT_A}`,
      {
        method: 'POST',
        headers: { 'x-runtime-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
      },
    )
    expect(res.status).toBe(403)
    const body: any = await res.json()
    expect(String(body.error ?? '')).toMatch(/runtime token|project-scoped|user session/i)
    // The via-based rejection happens before any chat-session / member
    // lookup, so neither chatSession nor member queries should fire.
    expect(mockPrisma.member.findFirst).not.toHaveBeenCalled()
  })
})
