// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Credential precedence for `createVoiceHandlers()`.
 *
 * The pod runtime injects `RUNTIME_AUTH_SECRET` + `PROJECT_ID`, which used to
 * make proxy mode unconditional — an explicit `apiKey` was ignored with only
 * a log line. Now an explicit `apiKey` wins, `mode` can force either
 * transport, and only a genuinely-unused key logs a warning.
 *
 * Run: bun test packages/voice/src/__tests__/credential-precedence.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createVoiceHandlers } from '../server'

const ENV_KEYS = ['RUNTIME_AUTH_SECRET', 'PROJECT_ID', 'SHOGO_API_URL', 'SHOGO_CLOUD_URL'] as const
const originals: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originals[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originals[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function podEnv() {
  process.env.RUNTIME_AUTH_SECRET = 'rt_pod_token'
  process.env.PROJECT_ID = 'proj_pod'
  process.env.SHOGO_API_URL = 'http://api.shogo.test'
}

type Call = { url: string; headers: Record<string, string> }

/** Records requests and answers with audio bytes. */
function recordingFetch(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {}
    const raw = init?.headers ?? {}
    for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v)
    calls.push({ url: typeof input === 'string' ? input : String(input), headers })
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const ttsRequest = () =>
  new Request('http://app/api/voice/tts-preview', {
    method: 'POST',
    body: JSON.stringify({ voiceId: 'voice_1', text: 'hi', modelId: 'eleven_v4' }),
  })

describe('createVoiceHandlers — credential precedence', () => {
  test('explicit apiKey wins over the ambient pod runtime token (BYO, no ignored warning)', async () => {
    podEnv()
    const { fetch, calls } = recordingFetch()
    const warns: string[] = []
    const handlers = createVoiceHandlers({
      apiKey: 'xi_byo_key',
      fetch,
      logger: (level, msg) => {
        if (level === 'warn') warns.push(msg)
      },
    })

    const res = await handlers.tts(ttsRequest())
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('https://api.elevenlabs.io/v1/text-to-speech/voice_1')
    expect(calls[0]!.headers['xi-api-key']).toBe('xi_byo_key')
    expect(calls[0]!.headers['x-runtime-token']).toBeUndefined()
    expect(warns.some((w) => /ignored/i.test(w))).toBe(false)
  })

  test('mode "byo" inside a pod uses the supplied key', async () => {
    podEnv()
    const { fetch, calls } = recordingFetch()
    const handlers = createVoiceHandlers({ apiKey: 'xi_forced', mode: 'byo', fetch })
    await handlers.tts(ttsRequest())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('api.elevenlabs.io')
    expect(calls[0]!.headers['xi-api-key']).toBe('xi_forced')
  })

  test('no apiKey + pod env → proxy mode with the runtime token', async () => {
    podEnv()
    const { fetch, calls } = recordingFetch()
    const handlers = createVoiceHandlers({ fetch })
    const res = await handlers.tts(ttsRequest())
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://api.shogo.test/api/voice/tts?projectId=proj_pod')
    expect(calls[0]!.headers['x-runtime-token']).toBe('rt_pod_token')
    expect(calls[0]!.headers['xi-api-key']).toBeUndefined()
  })

  test('mode "proxy" with an apiKey still proxies', async () => {
    podEnv()
    const { fetch, calls } = recordingFetch()
    const handlers = createVoiceHandlers({ apiKey: 'xi_unused', mode: 'proxy', fetch })
    await handlers.tts(ttsRequest())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('http://api.shogo.test/api/voice/tts')
    expect(calls[0]!.headers['x-runtime-token']).toBe('rt_pod_token')
    expect(calls[0]!.headers['xi-api-key']).toBeUndefined()
  })

  test('neither an apiKey nor a runtime token → throws', () => {
    expect(() => createVoiceHandlers({})).toThrow(/apiKey is required/)
  })

  test('mode "proxy" without pod env → throws a mode-specific error', () => {
    expect(() => createVoiceHandlers({ mode: 'proxy' })).toThrow(/mode "proxy"/)
  })

  test('pod env without SHOGO_API_URL / SHOGO_CLOUD_URL → constructing is fine, a proxied call refuses to guess a host', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'rt'
    process.env.PROJECT_ID = 'proj'
    // Construction must never throw: a pod that sets the token but not the
    // host still needs the local-only handlers (validation, 405s, catalog).
    const handlers = createVoiceHandlers({})
    expect(
      (await handlers.audioTags(new Request('http://app/api/voice/audio-tags'))).status,
    ).toBe(200)
    await expect(handlers.tts(ttsRequest())).rejects.toThrow(/SHOGO_API_URL/)
  })

  test('tts works with only an apiKey (no getUser / companionStore)', async () => {
    const { fetch, calls } = recordingFetch()
    const handlers = createVoiceHandlers({ apiKey: 'xi_only', fetch })
    const res = await handlers.tts(ttsRequest())
    expect(res.status).toBe(200)
    expect(calls[0]!.headers['xi-api-key']).toBe('xi_only')
  })

  test('user-scoped handlers answer a clear 500 when no getUser was supplied', async () => {
    const { fetch } = recordingFetch()
    const handlers = createVoiceHandlers({ apiKey: 'xi_only', fetch })
    const res = await handlers.signedUrl(new Request('http://app/api/voice/signed-url'))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { detail: string }
    expect(body.detail).toContain('getUser')
  })
})
