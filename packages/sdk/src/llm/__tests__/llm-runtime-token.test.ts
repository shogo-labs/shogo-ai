// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * createShogoLlmProvider runtime-token mode tests.
 *
 *   bun test packages/sdk/src/llm/__tests__/llm-runtime-token.test.ts
 */

import { describe, expect, test } from 'bun:test'

import { createShogoLlmProvider } from '../index'

describe('createShogoLlmProvider — credential mode', () => {
  test('runtimeToken sends `Authorization: Bearer rt_v1_*` to the gateway', async () => {
    let captured: { url: string; auth: string | null } | null = null
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const headers = new Headers(init?.headers)
      captured = { url, auth: headers.get('authorization') }
      return new Response(
        JSON.stringify({
          id: 'cmpl_1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const provider = createShogoLlmProvider({
      runtimeToken: 'rt_v1_proj_123_' + 'a'.repeat(64),
      baseUrl: 'https://studio.example',
      fetch: fakeFetch,
    })

    // Driving the provider through Vercel AI SDK is heavy for a unit test;
    // we instead invoke the underlying OpenAI-compatible chat model directly.
    const model = provider.chatModel('claude-sonnet-4-5')
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as any).catch(() => {})

    expect(captured).not.toBeNull()
    expect(captured!.url).toBe('https://studio.example/api/ai/v1/chat/completions')
    expect(captured!.auth).toBe('Bearer rt_v1_proj_123_' + 'a'.repeat(64))
  })

  test('apiKey sends `Authorization: Bearer shogo_sk_*`', async () => {
    let auth: string | null = null
    const fakeFetch: typeof fetch = async (_input, init) => {
      auth = new Headers(init?.headers).get('authorization')
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const provider = createShogoLlmProvider({
      apiKey: 'shogo_sk_test',
      fetch: fakeFetch,
    })
    const model = provider.chatModel('claude-sonnet-4-5')
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as any).catch(() => {})
    expect(auth).toBe('Bearer shogo_sk_test')
  })

  test('throws when neither apiKey nor runtimeToken is provided', () => {
    expect(() => createShogoLlmProvider({} as any)).toThrow(/one of `apiKey` or `runtimeToken`/)
  })

  test('throws when both apiKey and runtimeToken are provided', () => {
    expect(() =>
      createShogoLlmProvider({
        apiKey: 'shogo_sk_x',
        runtimeToken: 'rt_v1_p_h',
      }),
    ).toThrow(/exactly one of `apiKey` or `runtimeToken`/)
  })
})
