// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-68 acceptance E2E — pod → hosted TTS (`/api/voice/tts`).
 *
 * Wires the two real halves together in one process, the way a generated pod
 * app hits them:
 *
 *   Pod app (real `createVoiceHandlers({})`, runtime-token proxy mode
 *            auto-detected from env — the app supplies no keys)
 *     → Shogo API app (real `authMiddleware` + real `voiceMediaRoutes()`)
 *       → ElevenLabs (mocked)
 *
 * Covers the card's acceptance criteria:
 *   1. pod-shaped env + no app keys → 200 audio, `x-tts-model-used` is the
 *      requested `eleven_v4` / `eleven_v4_turbo`, pooled key reaches EL
 *   2. unknown model → 400 with `allowed`, never audio; a model-related EL
 *      failure is the only thing that produces a substituted model, and it
 *      comes back with both model headers + `Warning: 199`
 *   4. explicit `apiKey` inside a pod wins (EL sees the app key, the Shogo
 *      API is never called, no "apiKey is ignored" warning)
 *
 * Plus the boundaries the card calls out: 401 from ElevenLabs is surfaced
 * (never retried on another model), over-cap text is 413, a missing
 * ELEVENLABS_API_KEY is a 503, and a runtime token for another project is 403.
 *
 * Run: bun test apps/api/src/__tests__/voice-tts-proxy.e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ─── Constants ────────────────────────────────────────────────────────────
const PROJECT_ID = 'proj_tts_e2e'
const OTHER_PROJECT_ID = 'proj_tts_other'
const WORKSPACE_ID = 'ws_tts_e2e'
const OWNER_USER_ID = 'user_tts_owner'
const POOLED_KEY = 'xi_pooled_test_key'
const BYO_KEY = 'xi_byo_app_key'
const PROJECT_VOICE_ID = 'voice_from_project_agent'
const INTERNAL_API = 'http://internal-shogo-api'

// ─── Shogo API mocks ──────────────────────────────────────────────────────
type ProjectRow = { id: string; workspaceId: string }
const projects = new Map<string, ProjectRow>([
  [PROJECT_ID, { id: PROJECT_ID, workspaceId: WORKSPACE_ID }],
  [OTHER_PROJECT_ID, { id: OTHER_PROJECT_ID, workspaceId: 'ws_other' }],
])

const mockPrisma = {
  project: {
    // Three call shapes: runtime-token owner lookup (select.members),
    // access resolution (id/workspaceId/visibility), existence check.
    findUnique: mock(async (args: any) => {
      const p = projects.get(args?.where?.id)
      if (!p) return null
      if (args?.select && 'members' in args.select) {
        return {
          workspaceId: p.workspaceId,
          members: [{ userId: OWNER_USER_ID }],
          workspace: { members: [{ userId: OWNER_USER_ID }] },
        }
      }
      return { id: p.id, workspaceId: p.workspaceId, visibility: 'private' }
    }),
  },
  projectAgent: {
    findUnique: mock(async () => ({ voiceId: PROJECT_VOICE_ID })),
    findFirst: mock(async () => null),
    findMany: mock(async () => []),
  },
  user: { findUnique: mock(async () => null) },
  member: { findFirst: mock(async () => null), findMany: mock(async () => []) },
  workspace: { findUnique: mock(async () => null) },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../auth', () => ({
  auth: { api: { getSession: mock(async () => null) } },
}))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async () => null),
}))

// ─── Import real code (AFTER the module mocks) ────────────────────────────
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { authMiddleware } = await import('../middleware/auth')
const { voiceMediaRoutes } = await import('../routes/voice-media')
// Source import so the test exercises the working tree, not a stale build.
const { createVoiceHandlers } = await import('../../../../packages/sdk/src/voice/server')

// ─── ElevenLabs stub ──────────────────────────────────────────────────────
type ElCall = { url: string; headers: Record<string, string>; body: any }
let elCalls: ElCall[] = []
let apiHits = 0
let apiApp: Hono
let elRespond: (call: ElCall) => Response

const audioBytes = new Uint8Array([0xff, 0xf3, 0x40, 0x00, 0x11, 0x22])

const okAudio = () =>
  new Response(audioBytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } })

function installFetch() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    if (url.startsWith(INTERNAL_API)) {
      apiHits++
      const u = new URL(url)
      return apiApp.request(`${u.pathname}${u.search}`, init)
    }
    if (url.startsWith('https://api.elevenlabs.io')) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(init?.headers ?? {})) {
        headers[String(k).toLowerCase()] = String(v)
      }
      const call: ElCall = {
        url,
        headers,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      }
      elCalls.push(call)
      return elRespond(call)
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as unknown as typeof fetch
}

// ─── Wiring ───────────────────────────────────────────────────────────────
function createShogoApiApp(): Hono {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.route('/api', voiceMediaRoutes())
  return app
}

/** Pod app: no keys, no proxy config — env auto-detection only. */
function createPodApp(config: Parameters<typeof createVoiceHandlers>[0] = {}): Hono {
  const voice = createVoiceHandlers(config)
  const pod = new Hono()
  pod.post('/api/voice/tts', (c) => voice.tts(c.req.raw))
  return pod
}

const postTts = (app: Hono, body: unknown, path = '/api/voice/tts') =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const postApiTts = (body: unknown, token = deriveRuntimeToken(PROJECT_ID)) =>
  apiApp.request(`/api/voice/tts?projectId=${PROJECT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-runtime-token': token },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  process.env.AI_PROXY_SECRET = 'test-signing-secret-sho-68'
  process.env.RUNTIME_AUTH_SECRET = deriveRuntimeToken(PROJECT_ID)
  process.env.PROJECT_ID = PROJECT_ID
  process.env.SHOGO_API_URL = INTERNAL_API
  process.env.ELEVENLABS_API_KEY = POOLED_KEY

  elCalls = []
  apiHits = 0
  elRespond = okAudio
  apiApp = createShogoApiApp()

  mockPrisma.project.findUnique.mockClear()
  mockPrisma.projectAgent.findUnique.mockClear()
  installFetch()
})

afterEach(() => {
  installFetch()
})

// ─── Tests ────────────────────────────────────────────────────────────────

describe('SHO-68 E2E: pod → hosted TTS', () => {
  test('AC1: pod-shaped env, no app keys → 200 audio and the requested eleven_v4', async () => {
    const pod = createPodApp()

    const res = await postTts(pod, { text: 'Narration check.', modelId: 'eleven_v4' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_v4')
    expect(res.headers.get('x-tts-model-requested')).toBe('eleven_v4')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(audioBytes)

    // The proxy really went through the Shogo API, not straight to EL.
    expect(apiHits).toBe(1)
    expect(elCalls).toHaveLength(1)
    expect(elCalls[0].url).toContain('/v1/text-to-speech/')
    // Pooled server key — the pod app supplied nothing.
    expect(elCalls[0].headers['xi-api-key']).toBe(POOLED_KEY)
    expect(elCalls[0].body.model_id).toBe('eleven_v4')
    expect(elCalls[0].body.text).toBe('Narration check.')
    // Project's default voice, resolved by the hosted route (voice id is a
    // path segment on the ElevenLabs API, not a body field).
    expect(elCalls[0].url).toContain(`/v1/text-to-speech/${PROJECT_VOICE_ID}`)
  })

  test('AC1: eleven_v4_turbo is honoured end to end', async () => {
    const pod = createPodApp()

    const res = await postTts(pod, { text: 'Turbo check.', modelId: 'eleven_v4_turbo' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_v4_turbo')
    expect(elCalls[0].body.model_id).toBe('eleven_v4_turbo')
  })

  test('hosted default is eleven_v4_turbo when the pod omits modelId', async () => {
    const pod = createPodApp()

    const res = await postTts(pod, { text: 'Default model check.' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_v4_turbo')
    expect(elCalls[0].body.model_id).toBe('eleven_v4_turbo')
  })

  test('AC2: unknown model → 400 with the allowed list, no audio, no EL call', async () => {
    const pod = createPodApp()

    const res = await postTts(pod, { text: 'Nope.', modelId: 'eleven_nope' })

    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(body.error).toBe('unknown_model')
    expect(body.allowed).toContain('eleven_v4')
    expect(body.allowed).toContain('eleven_v4_turbo')
    expect(elCalls).toHaveLength(0)
  })

  test('AC2: over-cap text → 413 with the model limit', async () => {
    const pod = createPodApp()

    const res = await postTts(pod, { text: 'x'.repeat(10_001), modelId: 'eleven_v4' })

    expect(res.status).toBe(413)
    const body: any = await res.json()
    expect(body.error).toBe('text_too_long')
    expect(body.maxChars).toBe(10_000)
    expect(elCalls).toHaveLength(0)
  })

  test('AC2: a model-related EL failure substitutes with Warning + both model headers', async () => {
    elRespond = (call) =>
      call.body?.model_id === 'eleven_v4'
        ? new Response(JSON.stringify({ detail: 'model not available for this plan' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        : okAudio()

    const res = await postApiTts({ text: 'Fallback check.', modelId: 'eleven_v4' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_flash_v2_5')
    expect(res.headers.get('x-tts-model-requested')).toBe('eleven_v4')
    expect(res.headers.get('warning')).toContain('199')
    // Tried the requested model first, then the last-resort fallback (SHO-73:
    // flash v2.5, not the convai v4-turbo target — a BYO plan may have no v4).
    expect(elCalls.map((c) => c.body.model_id)).toEqual(['eleven_v4', 'eleven_flash_v2_5'])
  })

  test('a 401 from ElevenLabs is surfaced, never retried on another model', async () => {
    elRespond = () =>
      new Response(JSON.stringify({ detail: { message: 'invalid api key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })

    const res = await postApiTts({ text: 'Auth check.', modelId: 'eleven_v4' })

    expect(res.status).toBe(502)
    const body: any = await res.json()
    expect(body.elBody).toContain('invalid api key')
    expect(elCalls.map((c) => c.body.model_id)).toEqual(['eleven_v4'])
  })

  test('no ELEVENLABS_API_KEY → 503 voice_unavailable through the proxy', async () => {
    delete process.env.ELEVENLABS_API_KEY
    const pod = createPodApp()

    const res = await postTts(pod, { text: 'No key check.', modelId: 'eleven_v4' })

    expect(res.status).toBe(503)
    const body: any = await res.json()
    expect(body.error).toBe('voice_unavailable')
    expect(elCalls).toHaveLength(0)
  })

  test('AC4: an explicit apiKey wins inside a pod — EL sees it, the API is never called', async () => {
    const warnings: string[] = []
    const pod = createPodApp({
      apiKey: BYO_KEY,
      logger: (level: string, message: string) => warnings.push(`${level}: ${message}`),
    })

    // BYO mode is the per-companion preview handler: it needs an explicit voice.
    const res = await postTts(pod, {
      text: 'BYO check.',
      voiceId: 'voice_byo_preview',
      modelId: 'eleven_v4',
    })

    expect(res.status).toBe(200)
    expect(elCalls).toHaveLength(1)
    expect(elCalls[0].url).toContain('/v1/text-to-speech/voice_byo_preview')
    expect(elCalls[0].headers['xi-api-key']).toBe(BYO_KEY)
    expect(elCalls[0].body.model_id).toBe('eleven_v4')
    expect(apiHits).toBe(0)
    expect(warnings.join('\n')).not.toContain('ignored')
  })

  test('a runtime token scoped to another project → 403', async () => {
    const pod = createPodApp({
      proxy: {
        runtimeToken: deriveRuntimeToken(OTHER_PROJECT_ID),
        projectId: PROJECT_ID,
        apiUrl: INTERNAL_API,
      },
    })

    const res = await postTts(pod, { text: 'Scope check.', modelId: 'eleven_v4' })

    expect(res.status).toBe(403)
    expect(elCalls).toHaveLength(0)
  })
})
