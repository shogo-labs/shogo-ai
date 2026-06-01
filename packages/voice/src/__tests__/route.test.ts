// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `@shogo-ai/sdk/voice/route` — drop-in route handler adapters.
 *
 * Verifies that:
 *  - Each per-resource module exports the right HTTP-method functions
 *  - Zero-config modules delegate to `createVoiceHandlers({})` and
 *    therefore pick up `RUNTIME_AUTH_SECRET` + `PROJECT_ID` from env
 *  - Proxy-mode `signed-url` `GET` reaches the upstream Shogo API
 *    with the runtime token + projectId on the wire
 *  - `audio-tags` `GET` returns the static catalog without touching
 *    the network
 *  - `tts-preview` / `agent` return 501 in proxy mode (per the
 *    server's documented behavior)
 *  - `createVoiceRoute()` returns the same shape and routes through
 *    BYO-EL config without env auto-detection
 *  - Wrong HTTP verb → 405 (delegation is intact, not silently
 *    re-implemented in the adapter layer)
 *
 * Run: bun test packages/sdk/src/voice/__tests__/route.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import * as signedUrlRoute from '../route/signed-url'
import * as ttsPreviewRoute from '../route/tts-preview'
import * as agentRoute from '../route/agent'
import * as audioTagsRoute from '../route/audio-tags'
import * as musicRoute from '../route/music'
import { createVoiceRoute } from '../route/index'

const ORIGINAL_RT = process.env.RUNTIME_AUTH_SECRET
const ORIGINAL_PID = process.env.PROJECT_ID
const ORIGINAL_API = process.env.SHOGO_API_URL

let originalFetch: typeof globalThis.fetch
type Call = { url: string; init: RequestInit }
let fetchCalls: Call[] = []
let fetchHandler: (call: Call) => { status?: number; body?: unknown } = () => ({
  status: 200,
  body: {},
})

beforeEach(() => {
  delete process.env.RUNTIME_AUTH_SECRET
  delete process.env.PROJECT_ID
  delete process.env.SHOGO_API_URL
  fetchCalls = []
  fetchHandler = () => ({ status: 200, body: {} })
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url =
      typeof input === 'string' ? input : (input as URL | Request).toString()
    fetchCalls.push({ url, init })
    const { status = 200, body } = fetchHandler({ url, init })
    return new Response(body == null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (ORIGINAL_RT === undefined) delete process.env.RUNTIME_AUTH_SECRET
  else process.env.RUNTIME_AUTH_SECRET = ORIGINAL_RT
  if (ORIGINAL_PID === undefined) delete process.env.PROJECT_ID
  else process.env.PROJECT_ID = ORIGINAL_PID
  if (ORIGINAL_API === undefined) delete process.env.SHOGO_API_URL
  else process.env.SHOGO_API_URL = ORIGINAL_API
})

describe('per-resource module exports', () => {
  test('signed-url exports a GET function', () => {
    expect(typeof signedUrlRoute.GET).toBe('function')
  })

  test('tts-preview exports a POST function', () => {
    expect(typeof ttsPreviewRoute.POST).toBe('function')
  })

  test('agent exports POST, PATCH, DELETE', () => {
    expect(typeof agentRoute.POST).toBe('function')
    expect(typeof agentRoute.PATCH).toBe('function')
    expect(typeof agentRoute.DELETE).toBe('function')
  })

  test('audio-tags exports a GET function', () => {
    expect(typeof audioTagsRoute.GET).toBe('function')
  })

  test('music exports a POST function', () => {
    expect(typeof musicRoute.POST).toBe('function')
  })
})

describe('music POST (proxy mode via env auto-detect)', () => {
  test('forwards a prompt body to the Shogo API and streams audio back', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt_music'
    process.env.PROJECT_ID = 'proj_music'
    process.env.SHOGO_API_URL = 'http://api.local'
    fetchHandler = () => ({ status: 200, body: { ok: true } })

    const res = await musicRoute.POST(
      new Request('http://pod/api/voice/music', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'lofi beats', musicLengthMs: 15000 }),
      }),
    )
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    const [call] = fetchCalls
    expect(call.url).toBe('http://api.local/api/voice/music?projectId=proj_music')
    const headers = (call.init.headers ?? {}) as Record<string, string>
    expect(headers['x-runtime-token']).toBe('rt_music')
    expect(JSON.parse(call.init.body as string)).toEqual({
      prompt: 'lofi beats',
      musicLengthMs: 15000,
    })
  })

  test('rejects a body with both prompt and compositionPlan (400, no network)', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt'
    process.env.PROJECT_ID = 'p'

    const res = await musicRoute.POST(
      new Request('http://pod/api/voice/music', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'x', compositionPlan: { sections: [] } }),
      }),
    )
    expect(res.status).toBe(400)
    expect(fetchCalls).toHaveLength(0)
  })

  test('non-POST request returns 405', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt'
    process.env.PROJECT_ID = 'p'
    const res = await musicRoute.POST(
      new Request('http://pod/api/voice/music', { method: 'GET' }),
    )
    expect(res.status).toBe(405)
  })
})

describe('signed-url GET (proxy mode via env auto-detect)', () => {
  test('forwards to Shogo API with runtime token + projectId', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt_route_token'
    process.env.PROJECT_ID = 'proj_route'
    process.env.SHOGO_API_URL = 'http://api.local'
    fetchHandler = () => ({
      status: 200,
      body: { signedUrl: 'wss://el/x', agentId: 'agent_route', userContext: '' },
    })

    const res = await signedUrlRoute.GET(
      new Request('http://pod/api/voice/signed-url'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { signedUrl: string; agentId: string }
    expect(body.signedUrl).toBe('wss://el/x')
    expect(body.agentId).toBe('agent_route')

    expect(fetchCalls).toHaveLength(1)
    const [call] = fetchCalls
    expect(call.url).toBe('http://api.local/api/voice/signed-url?projectId=proj_route')
    const headers = (call.init.headers ?? {}) as Record<string, string>
    expect(headers['x-runtime-token']).toBe('rt_route_token')
  })

  test('non-GET request returns 405 (delegation intact)', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt'
    process.env.PROJECT_ID = 'p'
    process.env.SHOGO_API_URL = 'http://api'

    const res = await signedUrlRoute.GET(
      new Request('http://pod/api/voice/signed-url', { method: 'POST' }),
    )
    expect(res.status).toBe(405)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('audio-tags GET', () => {
  test('returns the static catalog without hitting the network', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt'
    process.env.PROJECT_ID = 'p'

    const res = await audioTagsRoute.GET(
      new Request('http://pod/api/voice/audio-tags'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tags: unknown
      groups: unknown
      defaults: { voiceSettings: unknown }
    }
    expect(body.tags).toBeTruthy()
    expect(body.groups).toBeTruthy()
    expect(body.defaults.voiceSettings).toBeTruthy()
    expect(fetchCalls).toHaveLength(0)
  })

  test('non-GET request returns 405', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt'
    process.env.PROJECT_ID = 'p'
    const res = await audioTagsRoute.GET(
      new Request('http://pod/api/voice/audio-tags', { method: 'POST' }),
    )
    expect(res.status).toBe(405)
  })
})

describe('tts-preview / agent in proxy mode → 501', () => {
  beforeEach(() => {
    process.env.RUNTIME_AUTH_SECRET = 'rt'
    process.env.PROJECT_ID = 'p'
  })

  test('tts-preview POST returns 501 with explanatory body', async () => {
    const res = await ttsPreviewRoute.POST(
      new Request('http://pod/api/voice/tts-preview', { method: 'POST' }),
    )
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('Not Implemented')
    expect(body.detail).toContain('runtime-token proxy mode')
  })

  test('agent.POST / PATCH / DELETE all return 501', async () => {
    for (const handler of [agentRoute.POST, agentRoute.PATCH, agentRoute.DELETE]) {
      const res = await handler(
        new Request('http://pod/api/voice/agent', { method: 'POST' }),
      )
      expect(res.status).toBe(501)
    }
  })
})

describe('createVoiceRoute (BYO-EL factory)', () => {
  test('returns the per-resource shape with all expected handlers', () => {
    const voice = createVoiceRoute({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () => new Response('')) as unknown as typeof fetch,
      },
    })
    expect(typeof voice.signedUrl.GET).toBe('function')
    expect(typeof voice.ttsPreview.POST).toBe('function')
    expect(typeof voice.music.POST).toBe('function')
    expect(typeof voice.agent.POST).toBe('function')
    expect(typeof voice.agent.PATCH).toBe('function')
    expect(typeof voice.agent.DELETE).toBe('function')
    expect(typeof voice.audioTags.GET).toBe('function')
  })

  test('explicit proxy option does not consult process.env', async () => {
    let upstreamCalls = 0
    const localFetch = (async (input: unknown) => {
      upstreamCalls++
      const url =
        typeof input === 'string' ? input : (input as URL | Request).toString()
      expect(url).toContain('https://api.explicit.test/api/voice/signed-url')
      expect(url).toContain('projectId=proj_explicit')
      return new Response(
        JSON.stringify({ signedUrl: 'wss://x', agentId: 'a' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const voice = createVoiceRoute({
      proxy: {
        runtimeToken: 'rt_explicit',
        projectId: 'proj_explicit',
        apiUrl: 'https://api.explicit.test',
        fetch: localFetch,
      },
    })

    const res = await voice.signedUrl.GET(
      new Request('http://pod/api/voice/signed-url'),
    )
    expect(res.status).toBe(200)
    expect(upstreamCalls).toBe(1)
    expect(fetchCalls).toHaveLength(0)
  })

  test('audioTags returns the static catalog through the factory', async () => {
    const voice = createVoiceRoute({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () => new Response('')) as unknown as typeof fetch,
      },
    })
    const res = await voice.audioTags.GET(
      new Request('http://pod/api/voice/audio-tags'),
    )
    expect(res.status).toBe(200)
  })
})
