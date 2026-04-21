// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  CONVAI_TTS_MODEL_FALLBACK,
  ElevenLabsApiError,
  ElevenLabsClient,
  MEMORY_CLIENT_TOOLS,
  resolveConvaiTtsModel,
} from '../elevenlabs'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

/** Mock `fetch` that records calls and returns whatever response is queued. */
function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: RecordedCall[] = []
  let i = 0
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v
        })
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v
      } else {
        for (const [k, v] of Object.entries(init.headers)) headers[k] = String(v)
      }
    }
    let parsedBody: unknown
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body)
      } catch {
        parsedBody = init.body
      }
    }
    calls.push({ url, method, headers, body: parsedBody })
    const next = responses[i++] ?? responses[responses.length - 1]!
    const bodyPayload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body)
    return new Response(bodyPayload, {
      status: next.status,
      headers: {
        'content-type': 'application/json',
        ...(next.headers ?? {}),
      },
    })
  }
  return { impl, calls }
}

describe('resolveConvaiTtsModel', () => {
  test('accepts supported ids', () => {
    expect(resolveConvaiTtsModel('eleven_turbo_v2_5')).toBe('eleven_turbo_v2_5')
    expect(resolveConvaiTtsModel('eleven_flash_v2')).toBe('eleven_flash_v2')
  })
  test('falls back for unsupported or missing ids', () => {
    expect(resolveConvaiTtsModel(null)).toBe(CONVAI_TTS_MODEL_FALLBACK)
    expect(resolveConvaiTtsModel('eleven_v3')).toBe(CONVAI_TTS_MODEL_FALLBACK)
    expect(resolveConvaiTtsModel('')).toBe(CONVAI_TTS_MODEL_FALLBACK)
  })
})

describe('ElevenLabsClient.createAgent', () => {
  test('posts to /v1/convai/agents/create with composed prompt + tools', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: { agent_id: 'agent_abc' } }])
    const el = new ElevenLabsClient({ apiKey: 'xi_test', fetch: impl })

    const id = await el.createAgent({
      displayName: 'Russell',
      characterName: 'Zix',
      voiceId: 'voice_1',
      systemPrompt: 'You are Zix.',
      firstMessage: 'Hi there!',
      expressivity: 'subtle',
      audioTags: ['laughs'],
      tools: MEMORY_CLIENT_TOOLS,
    })

    expect(id).toBe('agent_abc')
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.url).toContain('/v1/convai/agents/create')
    expect(call!.method).toBe('POST')
    expect(call!.headers['xi-api-key']).toBe('xi_test')

    const body = call!.body as {
      name: string
      conversation_config: {
        agent: { prompt: { prompt: string; tools: unknown[] }; first_message: string; language: string }
        tts: { voice_id: string; model_id: string }
      }
      platform_settings: { overrides: unknown }
    }
    expect(body.name).toBe('Companion-Zix-for-Russell')
    expect(body.conversation_config.agent.first_message).toBe('Hi there!')
    expect(body.conversation_config.agent.language).toBe('en')
    expect(body.conversation_config.agent.prompt.prompt).toContain('You are Zix.')
    expect(body.conversation_config.agent.prompt.prompt).toContain('[laughs]')
    expect(body.conversation_config.agent.prompt.prompt).toContain('{{user_context}}')
    expect(body.conversation_config.agent.prompt.tools).toHaveLength(1)
    expect(body.conversation_config.tts.voice_id).toBe('voice_1')
    expect(body.conversation_config.tts.model_id).toBe(CONVAI_TTS_MODEL_FALLBACK)
  })

  test('omits memory block when memoryBlock=null', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: { agent_id: 'a' } }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    await el.createAgent({
      displayName: 'D',
      characterName: 'C',
      voiceId: 'v',
      systemPrompt: 'P',
      firstMessage: 'hi',
      memoryBlock: null,
    })
    const prompt = (calls[0]!.body as {
      conversation_config: { agent: { prompt: { prompt: string } } }
    }).conversation_config.agent.prompt.prompt
    expect(prompt).not.toContain('{{user_context}}')
    expect(prompt).toContain('P')
  })

  test('throws ElevenLabsApiError on non-ok response', async () => {
    const { impl } = mockFetch([{ status: 401, body: 'bad key' }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    await expect(
      el.createAgent({
        displayName: 'D',
        characterName: 'C',
        voiceId: 'v',
        systemPrompt: 'P',
        firstMessage: 'hi',
      }),
    ).rejects.toBeInstanceOf(ElevenLabsApiError)
  })
})

describe('ElevenLabsClient.patchAgent', () => {
  test('sends only the fields supplied', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: {} }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    await el.patchAgent('agent_1', { voiceId: 'new_voice' })
    expect(calls[0]!.url).toContain('/v1/convai/agents/agent_1')
    expect(calls[0]!.method).toBe('PATCH')
    const body = calls[0]!.body as {
      conversation_config?: { tts?: { voice_id?: string; model_id?: string }; agent?: unknown }
    }
    expect(body.conversation_config?.tts?.voice_id).toBe('new_voice')
    expect(body.conversation_config?.agent).toBeUndefined()
  })

  test('is a no-op when nothing is supplied', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: {} }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    await el.patchAgent('agent_1', {})
    expect(calls).toHaveLength(0)
  })
})

describe('ElevenLabsClient.getSignedUrl', () => {
  test('returns the signed_url from the response', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: { signed_url: 'wss://x' } }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    const url = await el.getSignedUrl('agent_1')
    expect(url).toBe('wss://x')
    expect(calls[0]!.url).toContain('agent_id=agent_1')
  })
})

describe('ElevenLabsClient.textToSpeech', () => {
  test('returns audio bytes and the model actually used', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const { impl } = mockFetch([
      { status: 200, body: new TextDecoder().decode(bytes), headers: { 'content-type': 'audio/mpeg' } },
    ])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    const res = await el.textToSpeech({
      voiceId: 'v',
      text: 'hello',
      modelId: 'eleven_flash_v2_5',
    })
    expect(res.modelId).toBe('eleven_flash_v2_5')
    expect(res.contentType).toBe('audio/mpeg')
  })

  test('falls back to eleven_turbo_v2_5 if the first attempt fails', async () => {
    const { impl, calls } = mockFetch([
      { status: 500, body: { error: 'nope' } },
      { status: 200, body: 'ok', headers: { 'content-type': 'audio/mpeg' } },
    ])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    const res = await el.textToSpeech({
      voiceId: 'v',
      text: 'hi',
      modelId: 'eleven_v3',
    })
    expect(res.modelId).toBe('eleven_turbo_v2_5')
    expect(calls).toHaveLength(2)
    expect((calls[1]!.body as { model_id: string }).model_id).toBe('eleven_turbo_v2_5')
  })
})

describe('ElevenLabsClient.voiceExists', () => {
  test('true when the API returns 200', async () => {
    const { impl } = mockFetch([{ status: 200, body: {} }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    expect(await el.voiceExists('v')).toBe(true)
  })
  test('false when the API returns 404', async () => {
    const { impl } = mockFetch([{ status: 404, body: {} }])
    const el = new ElevenLabsClient({ apiKey: 'k', fetch: impl })
    expect(await el.voiceExists('v')).toBe(false)
  })
})
