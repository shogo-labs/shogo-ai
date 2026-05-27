// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
// Coverage closeout for src/server.ts — error/edge paths the original
// server.test.ts and server-proxy-mode.test.ts didn't reach.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createVoiceHandlers, toNodeListener, type VoiceHandlersConfig } from '../server'
import type { Companion, CompanionStore, VoiceUser } from '../types'

const ENV_TO_CLEAR = [
  'RUNTIME_AUTH_SECRET', 'PROJECT_ID', 'SHOGO_API_URL', 'SHOGO_API_KEY',
  'AI_PROXY_URL', 'AI_PROXY_TOKEN',
] as const

let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_TO_CLEAR) { savedEnv[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function makeCompanionStore(initial?: Companion): CompanionStore & { record: Companion | null } {
  const store = {
    record: initial ?? null,
    async findByUserId(userId: string) {
      if (this.record && this.record.userId === userId) return { ...this.record }
      return null
    },
    async create(data: any) { this.record = { id: 'c1', ...data } as Companion; return { ...this.record } },
    async update(userId: string, patch: any) {
      if (!this.record || this.record.userId !== userId) throw new Error('not found')
      this.record = { ...this.record, ...patch } as Companion
      return { ...this.record }
    },
    async delete(userId: string) { if (this.record?.userId === userId) this.record = null },
  }
  return store as any
}

function baseCompanion(overrides: Partial<Companion> = {}): Companion {
  return {
    id: 'c_1', userId: 'user_1', agentId: 'agent_123',
    displayName: 'R', characterName: 'Z', voiceId: 'v',
    systemPrompt: 'P', firstMessage: 'hi',
    expressivity: 'subtle', audioTags: [],
    voiceSettings: null, ttsModelId: null,
    ...overrides,
  }
}

const okFetch: typeof fetch = async () =>
  new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })

function buildHandlers(
  user: VoiceUser | null, fetchImpl: typeof fetch, store: CompanionStore,
  extra: Partial<VoiceHandlersConfig> = {},
) {
  return createVoiceHandlers({
    apiKey: 'xi_test', getUser: async () => user, companionStore: store,
    fetch: fetchImpl, ...extra,
  })
}

describe('createVoiceHandlers — config validation', () => {
  test('throws when neither proxy nor apiKey provided', () => {
    expect(() => createVoiceHandlers({ getUser: async () => null, companionStore: makeCompanionStore() } as any))
      .toThrow(/apiKey is required/)
  })
  test('throws when apiKey set but getUser missing', () => {
    expect(() => createVoiceHandlers({ apiKey: 'k', companionStore: makeCompanionStore() } as any))
      .toThrow(/getUser is required/)
  })
  test('throws when getUser set but companionStore missing', () => {
    expect(() => createVoiceHandlers({ apiKey: 'k', getUser: async () => null } as any))
      .toThrow(/companionStore is required/)
  })
})

describe('resolveProxyOptions — explicit-config branches', () => {
  test('throws when proxy.runtimeToken missing', () => {
    expect(() => createVoiceHandlers({
      proxy: { runtimeToken: '', projectId: 'p', apiUrl: 'http://x' },
    } as any)).toThrow(/proxy requires runtimeToken/)
  })
  test('throws when proxy.projectId missing', () => {
    expect(() => createVoiceHandlers({
      proxy: { runtimeToken: 't', projectId: '', apiUrl: 'http://x' },
    } as any)).toThrow(/proxy requires runtimeToken/)
  })
  test('throws when proxy.apiUrl missing', () => {
    expect(() => createVoiceHandlers({
      proxy: { runtimeToken: 't', projectId: 'p', apiUrl: '' },
    } as any)).toThrow(/proxy requires runtimeToken/)
  })
  test('warns when apiKey provided alongside proxy (proxy takes priority)', () => {
    const warns: string[] = []
    const h = createVoiceHandlers({
      proxy: { runtimeToken: 't', projectId: 'p', apiUrl: 'http://x', fetch: okFetch },
      apiKey: 'xi_should_be_ignored',
      logger: (level, msg) => { if (level === 'warn') warns.push(msg) },
    } as any)
    expect(warns.some(w => /apiKey is ignored/i.test(w) || /runtime-token proxy mode is active/i.test(w))).toBe(true)
    expect(typeof h.signedUrl).toBe('function')
  })
})

describe('proxy-mode handlers — notImplemented + elevenLabs proxy', () => {
  const proxyCfg = (fetchImpl?: typeof fetch) => ({
    proxy: { runtimeToken: 'rt', projectId: 'p', apiUrl: 'http://api', fetch: fetchImpl ?? okFetch },
  })

  test('tts returns 501 Not Implemented', async () => {
    const h = createVoiceHandlers(proxyCfg() as any)
    const r = await h.tts(new Request('http://x/tts', { method: 'POST' }))
    expect(r.status).toBe(501)
    const body = await r.json() as any
    expect(body.detail).toMatch(/runtime-token proxy mode/)
  })

  test('agent.create / patch / delete all return 501 in proxy mode', async () => {
    const h = createVoiceHandlers(proxyCfg() as any)
    expect((await h.agent.create(new Request('http://x'))).status).toBe(501)
    expect((await h.agent.patch(new Request('http://x', { method: 'PATCH' }))).status).toBe(501)
    expect((await h.agent.delete(new Request('http://x', { method: 'DELETE' }))).status).toBe(501)
  })

  test('audioTags works in proxy mode (does NOT need EL)', async () => {
    const h = createVoiceHandlers(proxyCfg() as any)
    const r = await h.audioTags(new Request('http://x/tags'))
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(Array.isArray(body.tags)).toBe(true)
  })

  test('elevenLabs proxy throws when any method is accessed', () => {
    const h = createVoiceHandlers(proxyCfg() as any)
    expect(() => (h.elevenLabs as any).createAgent({})).toThrow(/proxy mode/)
    expect(() => (h.elevenLabs as any).anyMethodAtAll).toThrow(/proxy mode/)
  })

  test('signedUrl proxies the upstream response (200 + body passthrough)', async () => {
    const upstreamFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ signedUrl: 'wss://up', agentId: 'a' }), { status: 200, headers: { 'content-type': 'application/json' } })
    const h = createVoiceHandlers(proxyCfg(upstreamFetch) as any)
    const r = await h.signedUrl(new Request('http://x/voice/signed-url'))
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(body.signedUrl).toBe('wss://up')
  })

  test('signedUrl returns 502 when proxy fetch throws', async () => {
    const erroringFetch: typeof fetch = async () => { throw new Error('upstream down') }
    const warns: any[] = []
    const h = createVoiceHandlers({
      proxy: { runtimeToken: 'rt', projectId: 'p', apiUrl: 'http://api', fetch: erroringFetch },
      logger: (lvl, msg, ctx) => { if (lvl === 'error') warns.push({ msg, ctx }) },
    } as any)
    const r = await h.signedUrl(new Request('http://x/voice/signed-url'))
    expect(r.status).toBe(502)
    const body = await r.json() as any
    expect(body.error).toBe('signedUrl proxy failed')
    expect(warns.some(w => /proxy signedUrl failed/.test(w.msg))).toBe(true)
  })

  test('signedUrl on non-GET returns 405 in proxy mode', async () => {
    const h = createVoiceHandlers(proxyCfg() as any)
    const r = await h.signedUrl(new Request('http://x/signed-url', { method: 'POST' }))
    expect(r.status).toBe(405)
  })
})

describe('createProxyHandlers — global fetch unavailable', () => {
  test('throws when no proxy.fetch and globalThis.fetch is undefined', () => {
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = undefined
    try {
      expect(() =>
        createVoiceHandlers({
          proxy: { runtimeToken: 'rt', projectId: 'p', apiUrl: 'http://api' },
        } as any),
      ).toThrow(/global fetch is unavailable/)
    } finally {
      ;(globalThis as any).fetch = orig
    }
  })
})

describe('readJson — malformed body handling', () => {
  test('doTts returns 400 on malformed JSON body', async () => {
    const h = buildHandlers({ id: 'user_1' }, okFetch, makeCompanionStore(baseCompanion()))
    const req = new Request('http://x/tts', { method: 'POST', body: 'not-json{', headers: { 'content-type': 'application/json' } })
    const r = await h.tts(req)
    expect(r.status).toBe(400)
    const body = await r.json() as any
    expect(body.error).toBe('Invalid JSON body')
  })
  test('agent.create returns 400 on malformed JSON', async () => {
    const h = buildHandlers({ id: 'user_1' }, okFetch, makeCompanionStore())
    const req = new Request('http://x/agent', { method: 'POST', body: 'broken' })
    const r = await h.agent.create(req)
    expect(r.status).toBe(400)
  })
  test('agent.patch returns 400 on malformed JSON', async () => {
    const h = buildHandlers({ id: 'user_1' }, okFetch, makeCompanionStore(baseCompanion()))
    const req = new Request('http://x/agent', { method: 'PATCH', body: 'broken' })
    const r = await h.agent.patch(req)
    expect(r.status).toBe(400)
  })
})

describe('doSignedUrl — pre-sync patch failure + memory failure', () => {
  test('logs warn and continues when el.patchAgent throws', async () => {
    let callIdx = 0
    const fetchImpl: typeof fetch = async (input: any) => {
      callIdx++
      const url = String(input)
      if (url.includes('/v1/convai/agents/agent_123') && !url.includes('get-signed-url')) {
        if (callIdx === 1) return new Response('boom', { status: 500 })
      }
      if (url.includes('get-signed-url')) {
        return new Response(JSON.stringify({ signed_url: 'wss://still-ok' }), { status: 200 })
      }
      return new Response('', { status: 200 })
    }
    const warns: any[] = []
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore(baseCompanion()), {
      logger: (lvl, msg) => { if (lvl === 'warn') warns.push(msg) },
    })
    const r = await h.signedUrl(new Request('http://x/signed-url'))
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(body.signedUrl).toBe('wss://still-ok')
    expect(warns.some(w => /pre-sync patch failed/.test(w))).toBe(true)
  })

  test('logs warn and continues when memoryStore.search throws', async () => {
    const fetchImpl: typeof fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('get-signed-url'))
        return new Response(JSON.stringify({ signed_url: 'wss://x' }), { status: 200 })
      return new Response('{}', { status: 200 })
    }
    const warns: any[] = []
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore(baseCompanion()), {
      memoryStore: () => ({ search: () => { throw new Error('memory boom') } }) as any,
      logger: (lvl, msg) => { if (lvl === 'warn') warns.push(msg) },
    })
    const r = await h.signedUrl(new Request('http://x/signed-url'))
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(body.userContext).toBe('')
    expect(warns.some(w => /memory preload failed/.test(w))).toBe(true)
  })
})

describe('doTts — text fallback + el error path', () => {
  test('builds preview line when body.text is empty (uses buildPreviewLine)', async () => {
    let ttsCall: any = null
    const fetchImpl: typeof fetch = async (input: any, init: any) => {
      const url = String(input)
      if (url.includes('text-to-speech')) {
        ttsCall = { url, body: init?.body }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { 'content-type': 'audio/mpeg' },
        })
      }
      return new Response('{}', { status: 200 })
    }
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore(baseCompanion()))
    const r = await h.tts(new Request('http://x/tts', {
      method: 'POST',
      body: JSON.stringify({ voiceId: 'v1', text: '', characterName: 'Sage' }),
    }))
    expect(r.status).toBe(200)
    expect(ttsCall).not.toBeNull()
    const sentBody = JSON.parse(ttsCall!.body) as any
    expect(sentBody.text.length).toBeGreaterThan(0)
  })

  test('returns 502 when el.textToSpeech throws (ElevenLabsApiError path)', async () => {
    const fetchImpl: typeof fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('text-to-speech'))
        return new Response('el down', { status: 503 })
      return new Response('{}', { status: 200 })
    }
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore(baseCompanion()))
    const r = await h.tts(new Request('http://x/tts', {
      method: 'POST',
      body: JSON.stringify({ voiceId: 'v', text: 'hello' }),
    }))
    expect(r.status).toBe(502)
  })
})

describe('doAgentPatch — el.patchAgent error path', () => {
  test('returns 502 when patchAgent fails with ElevenLabsApiError', async () => {
    const fetchImpl: typeof fetch = async () => new Response('el bad', { status: 500 })
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore(baseCompanion()))
    const r = await h.agent.patch(new Request('http://x/agent', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'New Name' }),
    }))
    expect(r.status).toBe(502)
  })

  test('patch without 11Labs-affecting fields skips EL call entirely', async () => {
    let elCalled = false
    const fetchImpl: typeof fetch = async (input: any) => {
      elCalled = true
      return new Response('{}', { status: 200 })
    }
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore(baseCompanion()))
    const r = await h.agent.patch(new Request('http://x/agent', {
      method: 'PATCH', body: JSON.stringify({}),
    }))
    expect(r.status).toBe(200)
    expect(elCalled).toBe(false)
  })
})

describe('doAgentCreate — invalid JSON', () => {
  test('returns 400 when body is not an object', async () => {
    const h = buildHandlers({ id: 'user_1' }, okFetch, makeCompanionStore())
    const r = await h.agent.create(new Request('http://x/agent', {
      method: 'POST', body: JSON.stringify('a string not object'),
    }))
    expect(r.status).toBe(400)
  })
})

describe('toNodeListener', () => {
  test('writes status + headers + body from handler Response', async () => {
    const handler = async (_req: Request) =>
      new Response('hello body', {
        status: 201,
        headers: { 'x-test': 'yes', 'content-type': 'text/plain' },
      })
    const listener = toNodeListener(handler)

    const headers: Record<string, string | string[]> = {}
    let body = ''
    let statusCode = 0
    const reqMock = {
      method: 'POST',
      url: '/test',
      headers: { host: 'example.com', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ a: 1 }))
      },
    } as any
    const resMock = {
      setHeader(name: string, value: string | string[]) { headers[name.toLowerCase()] = value },
      get statusCode() { return statusCode },
      set statusCode(v: number) { statusCode = v },
      end(buf?: Buffer | string) {
        body = typeof buf === 'string' ? buf : buf ? buf.toString() : ''
      },
    } as any

    listener(reqMock, resMock)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(statusCode).toBe(201)
    expect(headers['x-test']).toBe('yes')
    expect(body).toBe('hello body')
  })

  test('writes 500 + error message when the handler throws', async () => {
    const handler = async (_req: Request) => { throw new Error('handler boom') }
    const listener = toNodeListener(handler)
    let body = ''
    let statusCode = 0
    const reqMock = {
      method: 'GET', url: '/x', headers: { host: 'h' },
      async *[Symbol.asyncIterator]() {},
    } as any
    const resMock = {
      setHeader() {},
      get statusCode() { return statusCode },
      set statusCode(v: number) { statusCode = v },
      end(buf?: any) { body = typeof buf === 'string' ? buf : String(buf) },
    } as any
    listener(reqMock, resMock)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(statusCode).toBe(500)
    expect(body).toContain('handler boom')
  })

  test('omits body when handler Response has no body and skips init.body when empty', async () => {
    const handler = async (_req: Request) => new Response(null, { status: 204 })
    const listener = toNodeListener(handler)
    let statusCode = 0
    const reqMock = {
      method: 'GET', url: '/x', headers: {},
      async *[Symbol.asyncIterator]() {},
    } as any
    const resMock = {
      setHeader() {},
      get statusCode() { return statusCode },
      set statusCode(v: number) { statusCode = v },
      end() {},
    } as any
    listener(reqMock, resMock)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(statusCode).toBe(204)
  })
})

describe('doSignedUrl — basePrompt persistence + handleElError non-ApiError', () => {
  test('persists cleaned basePrompt when extraction changed the prompt', async () => {
    const fetchImpl: typeof fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('get-signed-url'))
        return new Response(JSON.stringify({ signed_url: 'wss://x' }), { status: 200 })
      return new Response('{}', { status: 200 })
    }
    const seeded = baseCompanion({
      systemPrompt: 'Base text.\n\n# Memory\n\nKnown context about this user from past conversations:\n{{user_context}}\n\nblah blah',
    })
    const store = makeCompanionStore(seeded)
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, store)
    const r = await h.signedUrl(new Request('http://x/signed-url'))
    expect(r.status).toBe(200)
    expect(store.record!.systemPrompt).toBe('Base text.')
  })

  test('handleElError returns 500 for a thrown non-ApiError', async () => {
    // Fetch throws synchronously → el.getSignedUrl rethrows a plain Error
    const fetchImpl: typeof fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('get-signed-url')) throw new Error('network down')
      return new Response('{}', { status: 200 })
    }
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore(baseCompanion()))
    const r = await h.signedUrl(new Request('http://x/signed-url'))
    expect(r.status).toBe(500)
    const body = await r.json() as any
    expect(body.detail).toContain('network down')
  })

  test('handleElError on agent.create returns 500 for plain Error', async () => {
    const fetchImpl: typeof fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('/v1/convai/agents/create')) throw new Error('createAgent network')
      return new Response('{}', { status: 200 })
    }
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore())
    const r = await h.agent.create(new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'D', characterName: 'C', voiceId: 'v',
        systemPrompt: 'p', firstMessage: 'hi',
      }),
    }))
    expect(r.status).toBe(500)
  })
})

describe('doAgentPatch — field-by-field branches', () => {
  test('patches expressivity, audioTags, voiceSettings, ttsModelId together', async () => {
    let patchCall: any = null
    const fetchImpl: typeof fetch = async (input: any, init: any) => {
      const url = String(input)
      if (url.includes('/v1/convai/agents/agent_123')) {
        patchCall = { url, body: init?.body }
        return new Response('{}', { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore(baseCompanion()))
    const r = await h.agent.patch(new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({
        expressivity: 'natural',
        audioTags: ['laughs', 'sighs'],
        voiceSettings: { stability: 0.6, similarity_boost: 0.7 },
        ttsModelId: 'eleven_turbo',
      }),
    }))
    expect(r.status).toBe(200)
    expect(patchCall).not.toBeNull()
  })

  test('patch with only ttsModelId still triggers EL patch (needs11Labs true)', async () => {
    let elPatched = false
    const fetchImpl: typeof fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('/v1/convai/agents/agent_123')) {
        elPatched = true
        return new Response('{}', { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }
    const h = buildHandlers({ id: 'user_1' }, fetchImpl, makeCompanionStore(baseCompanion()))
    const r = await h.agent.patch(new Request('http://x', {
      method: 'PATCH', body: JSON.stringify({ ttsModelId: 'eleven_turbo' }),
    }))
    expect(r.status).toBe(200)
    expect(elPatched).toBe(true)
  })
})
