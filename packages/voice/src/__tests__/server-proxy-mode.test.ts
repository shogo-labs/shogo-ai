// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Dual-mode `createVoiceHandlers()` — runtime-token proxy path.
 *
 * When `RUNTIME_AUTH_SECRET` + `PROJECT_ID` are set (or an explicit
 * `proxy` option is passed), the handlers become a thin forwarder to
 * the Shogo API instead of talking directly to ElevenLabs. This lets
 * generated pod apps mount the same `/api/voice/*` shape with zero
 * configuration.
 *
 * Run: bun test packages/sdk/src/voice/__tests__/server-proxy-mode.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createVoiceHandlers } from '../server'

const ORIGINAL_RT = process.env.RUNTIME_AUTH_SECRET
const ORIGINAL_PID = process.env.PROJECT_ID
const ORIGINAL_API = process.env.SHOGO_API_URL

beforeEach(() => {
  delete process.env.RUNTIME_AUTH_SECRET
  delete process.env.PROJECT_ID
  delete process.env.SHOGO_API_URL
})

afterEach(() => {
  if (ORIGINAL_RT === undefined) delete process.env.RUNTIME_AUTH_SECRET
  else process.env.RUNTIME_AUTH_SECRET = ORIGINAL_RT
  if (ORIGINAL_PID === undefined) delete process.env.PROJECT_ID
  else process.env.PROJECT_ID = ORIGINAL_PID
  if (ORIGINAL_API === undefined) delete process.env.SHOGO_API_URL
  else process.env.SHOGO_API_URL = ORIGINAL_API
})

type Call = { url: string; init: RequestInit }

function makeMockFetch(
  handler: (req: Call) => { status?: number; body?: unknown },
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url =
      typeof input === 'string' ? input : (input as URL | Request).toString()
    calls.push({ url, init })
    const { status = 200, body } = handler({ url, init })
    return new Response(body == null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

describe('createVoiceHandlers — runtime-token proxy mode', () => {
  test('explicit proxy option: signedUrl forwards to Shogo API with runtime token + projectId', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { signedUrl: 'wss://el.example/x', agentId: 'agent_1', userContext: '' },
    }))

    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt_live_zzz',
        projectId: 'proj_abc',
        apiUrl: 'https://api.shogo.test',
        fetch: fetchImpl,
      },
    })

    const res = await handlers.signedUrl(new Request('http://pod/api/voice/signed-url'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { signedUrl: string; agentId: string }
    expect(body.signedUrl).toBe('wss://el.example/x')
    expect(body.agentId).toBe('agent_1')

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.url).toContain('https://api.shogo.test/api/voice/signed-url')
    expect(call.url).toContain('projectId=proj_abc')
    const headers = (call.init.headers ?? {}) as Record<string, string>
    expect(headers['x-runtime-token']).toBe('rt_live_zzz')
  })

  test('env auto-detect: RUNTIME_AUTH_SECRET + PROJECT_ID → proxy mode', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt_env_token'
    process.env.PROJECT_ID = 'proj_env'
    process.env.SHOGO_API_URL = 'http://api.local'

    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { signedUrl: 'wss://x', agentId: 'a' },
    }))

    const handlers = createVoiceHandlers({ fetch: fetchImpl })
    await handlers.signedUrl(new Request('http://pod/api/voice/signed-url'))

    const [call] = calls
    expect(call.url).toBe('http://api.local/api/voice/signed-url?projectId=proj_env')
    const headers = (call.init.headers ?? {}) as Record<string, string>
    expect(headers['x-runtime-token']).toBe('rt_env_token')
  })

  test('proxy mode passes upstream 4xx through transparently', async () => {
    const { fetch: fetchImpl } = makeMockFetch(() => ({
      status: 403,
      body: { error: 'Runtime token scope mismatch' },
    }))

    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'proj_x',
        apiUrl: 'http://api',
        fetch: fetchImpl,
      },
    })
    const res = await handlers.signedUrl(new Request('http://pod/api/voice/signed-url'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/scope mismatch/i)
  })

  test('proxy mode skips apiKey/getUser/companionStore validation', () => {
    expect(() =>
      createVoiceHandlers({
        proxy: {
          runtimeToken: 'rt',
          projectId: 'p',
          apiUrl: 'http://api',
          fetch: (async () => new Response('')) as any,
        },
      }),
    ).not.toThrow()
  })

  test('audioTags works in proxy mode (static catalog, no network)', async () => {
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () => new Response('')) as any,
      },
    })
    const res = await handlers.audioTags(new Request('http://pod/api/voice/audio-tags'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tags: unknown; groups: unknown }
    expect(body.tags).toBeTruthy()
    expect(body.groups).toBeTruthy()
  })

  test('music forwards to /api/voice/music with the runtime token + projectId', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: {},
    }))
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt_music',
        projectId: 'proj_music',
        apiUrl: 'http://api',
        fetch: fetchImpl,
      },
    })
    const res = await handlers.music(
      new Request('http://pod/api/voice/music', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'synthwave', musicLengthMs: 20000 }),
      }),
    )
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.url).toBe('http://api/api/voice/music?projectId=proj_music')
    const headers = (call.init.headers ?? {}) as Record<string, string>
    expect(headers['x-runtime-token']).toBe('rt_music')
    expect(JSON.parse(call.init.body as string)).toEqual({
      prompt: 'synthwave',
      musicLengthMs: 20000,
    })
  })

  test('music rejects an invalid body (prompt XOR compositionPlan) without hitting the network', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({ status: 200, body: {} }))
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: fetchImpl,
      },
    })
    const res = await handlers.music(
      new Request('http://pod/api/voice/music', { method: 'POST', body: '{}' }),
    )
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('tts + agent.* return 501 in proxy mode (no end-user context)', async () => {
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () => new Response('')) as any,
      },
    })
    for (const handler of [
      handlers.tts,
      handlers.agent.create,
      handlers.agent.patch,
      handlers.agent.delete,
    ]) {
      const res = await handler(new Request('http://pod/x'))
      expect(res.status).toBe(501)
    }
  })

  test('forwards agentName from incoming request to upstream URL', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { signedUrl: 'wss://x', agentId: 'agent_arch', agentName: 'architect' },
    }))
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'proj_z',
        apiUrl: 'http://api',
        fetch: fetchImpl,
      },
    })
    const res = await handlers.signedUrl(
      new Request('http://pod/api/voice/signed-url?agentName=architect'),
    )
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.url).toBe(
      'http://api/api/voice/signed-url?projectId=proj_z&agentName=architect',
    )
  })

  test('omits agentName when client did not pass one', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { signedUrl: 'wss://x', agentId: 'a' },
    }))
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'proj_z',
        apiUrl: 'http://api',
        fetch: fetchImpl,
      },
    })
    await handlers.signedUrl(new Request('http://pod/api/voice/signed-url'))
    const [call] = calls
    expect(call.url).toBe('http://api/api/voice/signed-url?projectId=proj_z')
    expect(call.url).not.toContain('agentName')
  })

  test('does not forward arbitrary unknown query params', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { signedUrl: 'w', agentId: 'a' },
    }))
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'proj_z',
        apiUrl: 'http://api',
        fetch: fetchImpl,
      },
    })
    await handlers.signedUrl(
      new Request(
        'http://pod/api/voice/signed-url?agentName=architect&foo=bar&projectId=spoofed',
      ),
    )
    const [call] = calls
    // Allowlist forwards only `agentName`; pinned `projectId` from the
    // runtime token wins; `foo` is dropped.
    expect(call.url).toBe(
      'http://api/api/voice/signed-url?projectId=proj_z&agentName=architect',
    )
    expect(call.url).not.toContain('foo=bar')
    expect(call.url).not.toContain('spoofed')
  })

  test('signedUrl rejects non-GET (405) in proxy mode', async () => {
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () => new Response('')) as any,
      },
    })
    const res = await handlers.signedUrl(
      new Request('http://pod/api/voice/signed-url', { method: 'POST' }),
    )
    expect(res.status).toBe(405)
  })

  test('no env + no proxy option → BYO-EL mode (throws without apiKey)', () => {
    expect(() => createVoiceHandlers({})).toThrow(/apiKey is required/)
  })

  test('explicit proxy overrides env', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'env_token'
    process.env.PROJECT_ID = 'env_proj'
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({
      status: 200,
      body: { signedUrl: 'w', agentId: 'a' },
    }))
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'explicit_token',
        projectId: 'explicit_proj',
        apiUrl: 'http://explicit',
        fetch: fetchImpl,
      },
    })
    await handlers.signedUrl(new Request('http://pod/api/voice/signed-url'))
    expect(calls[0].url).toContain('explicit_proj')
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    expect(headers['x-runtime-token']).toBe('explicit_token')
  })
})
