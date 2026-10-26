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
const ORIGINAL_CLOUD = process.env.SHOGO_CLOUD_URL

beforeEach(() => {
  delete process.env.RUNTIME_AUTH_SECRET
  delete process.env.PROJECT_ID
  delete process.env.SHOGO_API_URL
  delete process.env.SHOGO_CLOUD_URL
})

afterEach(() => {
  if (ORIGINAL_RT === undefined) delete process.env.RUNTIME_AUTH_SECRET
  else process.env.RUNTIME_AUTH_SECRET = ORIGINAL_RT
  if (ORIGINAL_PID === undefined) delete process.env.PROJECT_ID
  else process.env.PROJECT_ID = ORIGINAL_PID
  if (ORIGINAL_API === undefined) delete process.env.SHOGO_API_URL
  else process.env.SHOGO_API_URL = ORIGINAL_API
  if (ORIGINAL_CLOUD === undefined) delete process.env.SHOGO_CLOUD_URL
  else process.env.SHOGO_CLOUD_URL = ORIGINAL_CLOUD
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

  test('tts posts to /api/voice/tts and passes audio + model headers through', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({ status: 200 }))
    const audio = new Uint8Array([9, 8, 7])
    const fetchWithAudio = (async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : String(input)
      calls.push({ url, init })
      return new Response(audio, {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'x-tts-model-used': 'eleven_v4',
          'x-tts-model-requested': 'eleven_v4',
        },
      })
    }) as unknown as typeof fetch
    void fetchImpl
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt_tts',
        projectId: 'proj_tts',
        apiUrl: 'http://api',
        fetch: fetchWithAudio,
      },
    })
    const res = await handlers.tts(
      new Request('http://pod/api/voice/tts', {
        method: 'POST',
        body: JSON.stringify({ text: 'Narration check.', modelId: 'eleven_v4' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_v4')
    expect(res.headers.get('x-tts-model-requested')).toBe('eleven_v4')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([9, 8, 7])

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.url).toBe('http://api/api/voice/tts?projectId=proj_tts')
    const headers = (call.init.headers ?? {}) as Record<string, string>
    expect(headers['x-runtime-token']).toBe('rt_tts')
    expect(JSON.parse(call.init.body as string)).toEqual({
      text: 'Narration check.',
      modelId: 'eleven_v4',
    })
  })

  test('tts returns 501 with the desktop message when upstream has no voice route', async () => {
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () => new Response('not found', { status: 404 })) as any,
      },
    })
    const res = await handlers.tts(
      new Request('http://pod/api/voice/tts', {
        method: 'POST',
        body: JSON.stringify({ text: 'hi' }),
      }),
    )
    expect(res.status).toBe(501)
    const body = (await res.json()) as { detail: string }
    expect(body.detail).toContain('no voice routes')
  })

  test('a pod with a runtime token but no API host still serves the local-only handlers', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt'
    process.env.PROJECT_ID = 'p'
    // No SHOGO_API_URL / SHOGO_CLOUD_URL — CI's env. Construction must not
    // throw, and everything that never leaves the process must still answer.
    const handlers = createVoiceHandlers({})
    expect(
      (await handlers.audioTags(new Request('http://pod/api/voice/audio-tags'))).status,
    ).toBe(200)
    const rejected = await handlers.music(
      new Request('http://pod/api/voice/music', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'x', compositionPlan: { sections: [] } }),
      }),
    )
    expect(rejected.status).toBe(400)
    expect(
      (await handlers.music(new Request('http://pod/api/voice/music', { method: 'GET' }))).status,
    ).toBe(405)
    // Only an actual proxied call refuses to guess a host.
    await expect(
      handlers.music(
        new Request('http://pod/api/voice/music', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'x' }),
        }),
      ),
    ).rejects.toThrow(/SHOGO_API_URL/)
  })

  test('tts forwards upstream Warning 199 so a pod caller sees the fallback', async () => {
    const proxied = (async () =>
      new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'x-tts-model-used': 'eleven_v4_turbo',
          'x-tts-model-requested': 'eleven_v4',
          warning: '199 - "eleven_v4 unavailable, used eleven_v4_turbo"',
        },
      })) as unknown as typeof fetch
    const handlers = createVoiceHandlers({
      proxy: { runtimeToken: 'rt', projectId: 'p', apiUrl: 'http://api', fetch: proxied },
    })
    const res = await handlers.tts(
      new Request('http://pod/api/voice/tts', {
        method: 'POST',
        body: JSON.stringify({ text: 'hi', modelId: 'eleven_v4' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_v4_turbo')
    expect(res.headers.get('warning')).toContain('199')
  })

  test('tts without text never hits the network', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({ status: 200, body: {} }))
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: fetchImpl,
      },
    })
    const res = await handlers.tts(
      new Request('http://pod/api/voice/tts', { method: 'POST', body: JSON.stringify({}) }),
    )
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('tts builds the audioTags preview line before forwarding', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({ status: 200, body: {} }))
    const handlers = createVoiceHandlers({
      proxy: { runtimeToken: 'rt', projectId: 'p', apiUrl: 'http://api', fetch: fetchImpl },
    })
    const res = await handlers.tts(
      new Request('http://pod/api/voice/tts', {
        method: 'POST',
        body: JSON.stringify({ audioTags: ['laughs'], characterName: 'Ada' }),
      }),
    )

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    const forwarded = JSON.parse(calls[0]!.init.body as string)
    expect(String(forwarded.text)).toContain('Ada')
    expect(forwarded.audioTags).toBeUndefined()
  })

  test('elevenLabs.textToSpeech goes through the proxy; agent provisioning throws', async () => {
    const { fetch: fetchImpl, calls } = makeMockFetch(() => ({ status: 200 }))
    const proxied = (async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : String(input)
      calls.push({ url, init })
      return new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'x-tts-model-used': 'eleven_v4_turbo',
          'x-tts-model-requested': 'eleven_v4',
        },
      })
    }) as unknown as typeof fetch
    void fetchImpl
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: proxied,
      },
    })
    const out = await handlers.elevenLabs.textToSpeech({
      voiceId: 'v1',
      text: 'hi',
      modelId: 'eleven_v4',
    })
    expect(out.modelId).toBe('eleven_v4_turbo')
    expect(out.requestedModel).toBe('eleven_v4')
    expect(out.fellBack).toBe(true)
    expect(calls[0]!.url).toBe('http://api/api/voice/tts?projectId=p')
    expect(() => (handlers.elevenLabs as any).createAgent).toThrow(/not available in runtime-token proxy mode/)
  })

  test('agent.* return 501 in proxy mode (no end-user context)', async () => {
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () => new Response('')) as any,
      },
    })
    for (const handler of [
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
