// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { createVoiceHandlers, type VoiceHandlersConfig } from '../server'
import type { Companion, CompanionStore, VoiceUser } from '../types'

function makeCompanionStore(initial?: Companion): CompanionStore & { record: Companion | null } {
  const store = {
    record: initial ?? null,
    async findByUserId(userId: string): Promise<Companion | null> {
      if (this.record && this.record.userId === userId) return { ...this.record }
      return null
    },
    async create(data: Omit<Companion, 'id'> & { id?: string }): Promise<Companion> {
      const full: Companion = { id: data.id ?? `c_${data.userId}`, ...data } as Companion
      this.record = full
      return { ...full }
    },
    async update(userId: string, patch: Partial<Companion>): Promise<Companion> {
      if (!this.record || this.record.userId !== userId) throw new Error('not found')
      this.record = { ...this.record, ...patch } as Companion
      return { ...this.record }
    },
    async delete(userId: string): Promise<void> {
      if (this.record?.userId === userId) this.record = null
    },
  }
  return store as CompanionStore & { record: Companion | null }
}

function baseCompanion(overrides: Partial<Companion> = {}): Companion {
  return {
    id: 'c_1',
    userId: 'user_1',
    agentId: 'agent_123',
    displayName: 'Russell',
    characterName: 'Zix',
    voiceId: 'voice_1',
    systemPrompt: 'You are Zix.',
    firstMessage: 'Hi there!',
    expressivity: 'subtle',
    audioTags: ['laughs'],
    voiceSettings: null,
    ttsModelId: null,
    ...overrides,
  }
}

interface MockFetchResponse {
  url: RegExp
  status: number
  body: unknown
  headers?: Record<string, string>
}

function mockFetch(responses: MockFetchResponse[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    let parsed: unknown
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = init.body
      }
    }
    calls.push({ url, method, body: parsed })
    const match = responses.find((r) => r.url.test(url))
    if (!match) {
      return new Response(JSON.stringify({ error: 'no mock for ' + url }), { status: 599 })
    }
    const payload = typeof match.body === 'string' ? match.body : JSON.stringify(match.body)
    return new Response(payload, {
      status: match.status,
      headers: { 'content-type': 'application/json', ...(match.headers ?? {}) },
    })
  }
  return { impl, calls }
}

function buildHandlers(
  user: VoiceUser | null,
  fetchImpl: typeof fetch,
  store: CompanionStore,
  extra: Partial<VoiceHandlersConfig> = {},
) {
  return createVoiceHandlers({
    apiKey: 'xi_test',
    getUser: async () => user,
    companionStore: store,
    fetch: fetchImpl,
    ...extra,
  })
}

describe('createVoiceHandlers.signedUrl', () => {
  test('returns 401 when no user is resolved', async () => {
    const { impl } = mockFetch([])
    const store = makeCompanionStore()
    const h = buildHandlers(null, impl, store)
    const res = await h.signedUrl(new Request('http://x/voice/signed-url'))
    expect(res.status).toBe(401)
  })

  test('returns 404 when the user has no companion yet', async () => {
    const { impl } = mockFetch([])
    const store = makeCompanionStore()
    const h = buildHandlers({ id: 'user_1' }, impl, store)
    const res = await h.signedUrl(new Request('http://x/voice/signed-url'))
    expect(res.status).toBe(404)
  })

  test('returns 405 on non-GET', async () => {
    const { impl } = mockFetch([])
    const h = buildHandlers({ id: 'user_1' }, impl, makeCompanionStore())
    const res = await h.signedUrl(new Request('http://x/voice/signed-url', { method: 'POST' }))
    expect(res.status).toBe(405)
  })

  test('patches the agent and returns the signed URL', async () => {
    const { impl, calls } = mockFetch([
      { url: /\/v1\/convai\/agents\/agent_123$/, status: 200, body: {} },
      { url: /get-signed-url/, status: 200, body: { signed_url: 'wss://signed' } },
    ])
    const store = makeCompanionStore(baseCompanion())
    const h = buildHandlers({ id: 'user_1' }, impl, store)

    const res = await h.signedUrl(new Request('http://x/voice/signed-url'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      signedUrl: string
      agentId: string
      userContext: string
    }
    expect(body.signedUrl).toBe('wss://signed')
    expect(body.agentId).toBe('agent_123')

    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.url).toContain('/v1/convai/agents/agent_123')
    expect(calls[1]!.url).toContain('agent_id=agent_123')
  })

  test('returns 502 when 11Labs signed-url request fails', async () => {
    const { impl } = mockFetch([
      { url: /\/v1\/convai\/agents\/agent_123$/, status: 200, body: {} },
      { url: /get-signed-url/, status: 500, body: 'upstream boom' },
    ])
    const store = makeCompanionStore(baseCompanion())
    const h = buildHandlers({ id: 'user_1' }, impl, store)
    const res = await h.signedUrl(new Request('http://x/voice/signed-url'))
    expect(res.status).toBe(502)
  })

  test('preloads memory context when memoryStore is provided', async () => {
    const { impl } = mockFetch([
      { url: /\/v1\/convai\/agents\/agent_123$/, status: 200, body: {} },
      { url: /get-signed-url/, status: 200, body: { signed_url: 'wss://x' } },
    ])
    const store = makeCompanionStore(baseCompanion())
    const h = buildHandlers({ id: 'user_1' }, impl, store, {
      memoryStore: () => ({
        search: () => [
          { chunk: 'favorite color: teal', matchType: 'fts' },
          { chunk: 'lives in Honolulu' },
        ],
      }),
    })
    const res = await h.signedUrl(new Request('http://x/voice/signed-url'))
    const body = (await res.json()) as { userContext: string }
    expect(body.userContext).toContain('teal')
    expect(body.userContext).toContain('Honolulu')
    expect(body.userContext).toContain('[fts]')
  })
})

describe('createVoiceHandlers.agent.create', () => {
  test('rejects when a companion already exists', async () => {
    const { impl } = mockFetch([])
    const store = makeCompanionStore(baseCompanion())
    const h = buildHandlers({ id: 'user_1' }, impl, store)
    const res = await h.agent.create(
      new Request('http://x/voice/agent', {
        method: 'POST',
        body: JSON.stringify({
          displayName: 'R',
          characterName: 'Z',
          voiceId: 'v',
          systemPrompt: 'p',
          firstMessage: 'hi',
        }),
      }),
    )
    expect(res.status).toBe(409)
  })

  test('creates the 11Labs agent and persists the companion', async () => {
    const { impl, calls } = mockFetch([
      { url: /\/v1\/convai\/agents\/create$/, status: 200, body: { agent_id: 'agent_new' } },
    ])
    const store = makeCompanionStore()
    const h = buildHandlers({ id: 'user_1' }, impl, store)

    const res = await h.agent.create(
      new Request('http://x/voice/agent', {
        method: 'POST',
        body: JSON.stringify({
          displayName: 'Russell',
          characterName: 'Zix',
          voiceId: 'voice_1',
          systemPrompt: 'You are Zix.',
          firstMessage: 'Hi there!',
          expressivity: 'subtle',
          audioTags: ['laughs', 'whispers'],
        }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Companion
    expect(body.agentId).toBe('agent_new')
    expect(body.userId).toBe('user_1')
    expect(calls).toHaveLength(1)
  })

  test('400 when required fields missing', async () => {
    const { impl } = mockFetch([])
    const h = buildHandlers({ id: 'user_1' }, impl, makeCompanionStore())
    const res = await h.agent.create(
      new Request('http://x/voice/agent', {
        method: 'POST',
        body: JSON.stringify({ displayName: 'R' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('createVoiceHandlers.agent.patch', () => {
  test('PATCHes both 11Labs and the companion store', async () => {
    const { impl, calls } = mockFetch([
      { url: /\/v1\/convai\/agents\/agent_123$/, status: 200, body: {} },
    ])
    const store = makeCompanionStore(baseCompanion())
    const h = buildHandlers({ id: 'user_1' }, impl, store)
    const res = await h.agent.patch(
      new Request('http://x/voice/agent', {
        method: 'PATCH',
        body: JSON.stringify({ voiceId: 'voice_new' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Companion
    expect(body.voiceId).toBe('voice_new')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
  })

  test('404 when there is no companion', async () => {
    const { impl } = mockFetch([])
    const h = buildHandlers({ id: 'user_1' }, impl, makeCompanionStore())
    const res = await h.agent.patch(
      new Request('http://x/voice/agent', {
        method: 'PATCH',
        body: JSON.stringify({ voiceId: 'v' }),
      }),
    )
    expect(res.status).toBe(404)
  })
})

describe('createVoiceHandlers.agent.delete', () => {
  test('deletes the 11Labs agent and clears the companion', async () => {
    const { impl, calls } = mockFetch([{ url: /.*/, status: 200, body: {} }])
    const store = makeCompanionStore(baseCompanion())
    const h = buildHandlers({ id: 'user_1' }, impl, store)
    const res = await h.agent.delete(new Request('http://x/voice/agent', { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(store.record).toBeNull()
    expect(calls[0]!.method).toBe('DELETE')
  })

  test('200 ok even when no companion exists', async () => {
    const { impl, calls } = mockFetch([])
    const h = buildHandlers({ id: 'user_1' }, impl, makeCompanionStore())
    const res = await h.agent.delete(new Request('http://x/voice/agent', { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(0)
  })
})

describe('createVoiceHandlers.tts', () => {
  test('POSTs to text-to-speech and forwards the audio', async () => {
    const { impl } = mockFetch([
      {
        url: /\/v1\/text-to-speech\/voice_xyz/,
        status: 200,
        body: 'audio-bytes',
        headers: { 'content-type': 'audio/mpeg' },
      },
    ])
    const h = buildHandlers({ id: 'user_1' }, impl, makeCompanionStore())
    const res = await h.tts(
      new Request('http://x/voice/tts-preview', {
        method: 'POST',
        body: JSON.stringify({ voiceId: 'voice_xyz', text: 'hello' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('x-tts-model-used')).toBeDefined()
  })

  test('400 when voiceId is missing', async () => {
    const { impl } = mockFetch([])
    const h = buildHandlers({ id: 'user_1' }, impl, makeCompanionStore())
    const res = await h.tts(
      new Request('http://x/voice/tts-preview', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('createVoiceHandlers.audioTags', () => {
  test('returns the catalog without requiring auth', async () => {
    const { impl } = mockFetch([])
    const h = buildHandlers(null, impl, makeCompanionStore())
    const res = await h.audioTags(new Request('http://x/voice/audio-tags'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tags: unknown[]
      groups: unknown[]
      expressivity: unknown[]
      defaults: { allowedTags: string[]; ttsModelId: string }
    }
    expect(body.tags.length).toBeGreaterThan(0)
    expect(body.groups.length).toBe(3)
    expect(body.expressivity.length).toBe(3)
    expect(body.defaults.allowedTags).toContain('laughs')
  })
})
