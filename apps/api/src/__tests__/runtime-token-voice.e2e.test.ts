// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pod → Shogo API runtime-token E2E
 *
 * Wires two in-process Hono apps together to exercise the full flow a
 * generated pod app goes through when a browser triggers voice:
 *
 *   Browser (fetch on pod origin)
 *     → Pod Hono (sdk/voice/server.ts `createVoiceHandlers` in proxy mode)
 *       → Shogo API Hono (real `voiceRoutes()` + real `authMiddleware`)
 *         → ElevenLabs (mocked)
 *
 * Happy path: pod has `RUNTIME_AUTH_SECRET` (= `deriveRuntimeToken(PROJECT_ID)`)
 * injected in env. Browser request carries no auth. Pod proxy forwards
 * `x-runtime-token` + `?projectId=`; API authenticates + authorizes; EL
 * returns a signed URL.
 *
 * Negative path: pod env carries the wrong projectId (simulating a
 * misconfigured / tampered pod). With v1 self-identifying tokens the
 * HMAC passes against the token's own scope, then `authorizeProject`
 * rejects the cross-project request with 403. Pod returns the
 * upstream error body transparently.
 *
 * Run: bun test apps/api/src/__tests__/runtime-token-voice.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

// ─── Env ──────────────────────────────────────────────────────────────────
process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token'
process.env.ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY ?? 'test-el-key'
process.env.ELEVENLABS_VOICE_MODE_AGENT_ID =
  process.env.ELEVENLABS_VOICE_MODE_AGENT_ID ?? 'agent_shared_shogo_mode'

// ─── Shogo API mocks ─────────────────────────────────────────────────────
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
  user: { findUnique: mock(async () => null) },
  member: { findFirst: mock(async () => null) },
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

const getSignedUrlMock = mock(async (agentId: string) =>
  `wss://mock.elevenlabs/signed?agent=${agentId}`,
)
const createAgentMock = mock(async (_opts: any) => 'agent_provisioned_fake')
class MockElevenLabsClient {
  constructor(_cfg: any) {}
  getSignedUrl = getSignedUrlMock
  createAgent = createAgentMock
}
mock.module('@shogo-ai/sdk/voice', () => ({
  ElevenLabsClient: MockElevenLabsClient,
}))
mock.module('@shogo/agent-runtime/src/voice-mode/translator-persona', () => ({
  TRANSLATOR_SYSTEM_PROMPT: '',
  TRANSLATOR_AI_SDK_TOOLS: {},
}))
mock.module('../lib/twilio', () => ({
  resolveShogoTwilioClient: () => ({ error: 'twilio not configured in test' }),
  verifyTwilioSignature: () => true,
}))
mock.module('../lib/voice-cost', () => ({
  resolveVoiceRate: () => 0,
  resolvePlanIdForWorkspace: async () => 'plan_test',
  getCreditBalance: async () => 1000,
  calculateVoiceMinuteCost: () => 0,
}))
mock.module('../services/billing.service', () => ({
  consumeCredits: async () => ({ ok: true }),
}))
mock.module('../lib/voice-meter', () => ({
  recordCallUsage: async () => ({ ok: true }),
  verifyElevenLabsSignature: () => true,
}))

// ─── Import real code (AFTER mocks) ──────────────────────────────────────
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { authMiddleware } = await import('../middleware/auth')
const { voiceRoutes } = await import('../routes/voice')
// Import the SDK's server handlers directly from source so the test
// exercises current code without depending on a prior `tsup` build.
const { createVoiceHandlers } = await import(
  '../../../../packages/sdk/src/voice/server'
)

// ─── Test constants ──────────────────────────────────────────────────────
const PROJECT_ID = 'proj_e2e_ok'
const WORKSPACE_ID = 'ws_e2e_ok'
const PROJECT_OWNER_USER_ID = 'user_owner_e2e_ok'
const WRONG_PROJECT_ID = 'proj_e2e_wrong'
const WRONG_PROJECT_OWNER_USER_ID = 'user_owner_e2e_wrong'

// ─── Wire: Shogo API app (upstream) ──────────────────────────────────────
function createShogoApiApp(): Hono {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.route('/api', voiceRoutes())
  return app
}

/**
 * Adapt a Hono app's in-process `request(path, init)` interface to the
 * standard `fetch(url, init)` signature expected by
 * `createVoiceHandlers`'s proxy. Strips the absolute URL down to the
 * path+search that Hono's router understands.
 */
function makeInProcessFetch(app: Hono): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : (input as any).url ?? String(input)
    const u = new URL(urlStr, 'http://internal')
    return app.request(`${u.pathname}${u.search}`, init)
  }) as unknown as typeof fetch
}

// ─── Wire: Pod app ───────────────────────────────────────────────────────
interface PodEnv {
  runtimeToken: string
  projectId: string
}

function createPodApp(env: PodEnv, apiApp: Hono): Hono {
  const voice = createVoiceHandlers({
    proxy: {
      runtimeToken: env.runtimeToken,
      projectId: env.projectId,
      apiUrl: 'http://internal-shogo-api',
      fetch: makeInProcessFetch(apiApp),
    },
  })
  const pod = new Hono()
  pod.get('/api/voice/signed-url', (c) => voice.signedUrl(c.req.raw))
  pod.get('/api/voice/audio-tags', (c) => voice.audioTags(c.req.raw))
  return pod
}

// ─── Reset ───────────────────────────────────────────────────────────────
beforeEach(() => {
  projectsById.clear()
  voiceConfigByProjectId.clear()
  projectsById.set(PROJECT_ID, {
    id: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    projectOwnerUserId: PROJECT_OWNER_USER_ID,
  })
  projectsById.set(WRONG_PROJECT_ID, {
    id: WRONG_PROJECT_ID,
    workspaceId: 'ws_other',
    projectOwnerUserId: WRONG_PROJECT_OWNER_USER_ID,
  })
  mockPrisma.user.findUnique.mockClear()
  mockPrisma.member.findFirst.mockClear()
  mockPrisma.project.findUnique.mockClear()
  mockPrisma.voiceProjectConfig.findUnique.mockClear()
  mockPrisma.voiceProjectConfig.upsert.mockClear()
  getSignedUrlMock.mockClear()
  createAgentMock.mockClear()
})

// ─── Tests ───────────────────────────────────────────────────────────────

describe('E2E: pod → Shogo API runtime-token flow', () => {
  test('happy path: browser → pod → api → EL returns signedUrl', async () => {
    const apiApp = createShogoApiApp()
    const podApp = createPodApp(
      {
        runtimeToken: deriveRuntimeToken(PROJECT_ID),
        projectId: PROJECT_ID,
      },
      apiApp,
    )

    // "Browser" hits the pod with same-origin, no auth header.
    const res = await podApp.request('/api/voice/signed-url', {
      method: 'GET',
    })

    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.signedUrl).toBe('wss://mock.elevenlabs/signed?agent=agent_provisioned_fake')
    expect(body.agentId).toBe('agent_provisioned_fake')

    // API received the request with runtime-token context — sanity: EL
    // was asked for a signed URL, and a per-project agent row exists.
    expect(getSignedUrlMock).toHaveBeenCalledTimes(1)
    expect(createAgentMock).toHaveBeenCalledTimes(1)
    // Runtime-token path must not touch user/member tables.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.member.findFirst).not.toHaveBeenCalled()
  })

  test('second browser request is idempotent (reuses existing EL agent)', async () => {
    const apiApp = createShogoApiApp()
    const podApp = createPodApp(
      {
        runtimeToken: deriveRuntimeToken(PROJECT_ID),
        projectId: PROJECT_ID,
      },
      apiApp,
    )

    // Seed the voice config so `ensureProjectElevenLabsAgent` returns
    // early instead of provisioning a new agent.
    voiceConfigByProjectId.set(PROJECT_ID, {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      elevenlabsAgentId: 'agent_existing',
    })

    const res = await podApp.request('/api/voice/signed-url')
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.agentId).toBe('agent_existing')
    expect(createAgentMock).not.toHaveBeenCalled()
  })

  test('negative: pod configured with stale runtimeToken → upstream 403 (scope mismatch)', async () => {
    const apiApp = createShogoApiApp()
    // Pod boots with a token derived for a DIFFERENT project than its
    // PROJECT_ID — e.g. a warm-pool pod reassigned but env not refreshed.
    // v1 tokens self-identify, so the middleware now authenticates the
    // caller as WRONG_PROJECT_ID (the token's true scope) rather than
    // rejecting at the HMAC check. `authorizeProject` then enforces the
    // target project from `?projectId=PROJECT_ID` against the
    // authenticated scope → 403. Same security outcome as before, just
    // a more honest status code (see runtime-token.md §9).
    const podApp = createPodApp(
      {
        runtimeToken: deriveRuntimeToken(WRONG_PROJECT_ID),
        projectId: PROJECT_ID,
      },
      apiApp,
    )

    const res = await podApp.request('/api/voice/signed-url')
    expect(res.status).toBe(403)
    // EL was never called — fast rejection at the authorization layer.
    expect(getSignedUrlMock).not.toHaveBeenCalled()
  })

  test('negative: direct API call with token for project A but ?projectId=B → 403', async () => {
    const apiApp = createShogoApiApp()
    // Token for WRONG_PROJECT_ID, routed at /api/voice/signed-url?projectId=PROJECT_ID.
    // With v1 tokens, authentication succeeds as WRONG_PROJECT_ID; the
    // scope mismatch is caught by `authorizeProject`.
    const wrongToken = deriveRuntimeToken(WRONG_PROJECT_ID)
    const res = await apiApp.request(
      `/api/voice/signed-url?projectId=${PROJECT_ID}`,
      { headers: { 'x-runtime-token': wrongToken } },
    )
    expect(res.status).toBe(403)
  })

  test('negative: structurally malformed runtime token → 401 at the auth layer', async () => {
    const apiApp = createShogoApiApp()
    // Not a v1 token, not a bare-hex token — just garbage. Middleware
    // can't recover any scope and falls through to session auth (none)
    // → 401. This is the remaining 401-path for runtime tokens.
    const res = await apiApp.request(
      `/api/voice/signed-url?projectId=${PROJECT_ID}`,
      { headers: { 'x-runtime-token': 'not-a-valid-runtime-token' } },
    )
    expect(res.status).toBe(401)
  })

  test('audioTags proxy handler returns static catalog even without network', async () => {
    const apiApp = createShogoApiApp()
    const podApp = createPodApp(
      {
        runtimeToken: deriveRuntimeToken(PROJECT_ID),
        projectId: PROJECT_ID,
      },
      apiApp,
    )

    const res = await podApp.request('/api/voice/audio-tags')
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(Array.isArray(body.tags) || typeof body.tags === 'object').toBe(true)
  })
})
