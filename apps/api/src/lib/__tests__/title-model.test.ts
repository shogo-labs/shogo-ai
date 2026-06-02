// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/lib/title-model.ts — the admin-selectable model
 * used to generate chat/project titles.
 *
 *   bun test apps/api/src/lib/__tests__/title-model.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// ─── Mutable mock data for the model registry (id-aware, like the real one) ──
let ENTRIES: Record<string, any> = {}
let ROUTINGS: Record<string, any> = {}

mock.module('../../services/model-registry.service', () => ({
  getMergedModelEntrySync: (id: string) => ENTRIES[id],
  getDbRoutingConfigSync: (id: string) => ROUTINGS[id],
}))

// Mock the Anthropic path so the default/fallback branch is deterministic.
let anthropicText = '{"title": "Anthropic Title", "description": "from anthropic"}'
mock.module('ai', () => ({
  generateText: async (_opts: any) => ({
    text: anthropicText,
    usage: { inputTokens: 11, outputTokens: 7 },
  }),
}))
mock.module('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (model: string) => ({ model }),
}))

const {
  DEFAULT_TITLE_MODEL_ID,
  setTitleGenerationModelId,
  getTitleGenerationModelId,
  generateTitleCompletion,
} = await import('../title-model')

const SYSTEM = 'system prompt'
const PROMPT = 'first message'

// The default Haiku model resolves to a native Anthropic catalog entry.
const HAIKU_ENTRY = {
  id: DEFAULT_TITLE_MODEL_ID,
  provider: 'anthropic',
  apiModel: DEFAULT_TITLE_MODEL_ID,
}

beforeEach(() => {
  ENTRIES = { [DEFAULT_TITLE_MODEL_ID]: HAIKU_ENTRY }
  ROUTINGS = {}
  setTitleGenerationModelId(null)
  anthropicText = '{"title": "Anthropic Title", "description": "from anthropic"}'
  process.env.ANTHROPIC_API_KEY = 'sk-test'
})

afterEach(() => {
  ;(globalThis.fetch as any) = realFetch
})

const realFetch = globalThis.fetch

describe('title-model id resolution', () => {
  test('defaults to the Haiku model id when unset', () => {
    expect(getTitleGenerationModelId()).toBe(DEFAULT_TITLE_MODEL_ID)
  })

  test('returns the configured id once set, and resets on empty', () => {
    setTitleGenerationModelId('hoshi')
    expect(getTitleGenerationModelId()).toBe('hoshi')
    setTitleGenerationModelId('   ')
    expect(getTitleGenerationModelId()).toBe(DEFAULT_TITLE_MODEL_ID)
  })
})

describe('custom OpenAI-compatible provider (Hoshi)', () => {
  test('calls the provider chat-completions endpoint and bills the real id', async () => {
    ENTRIES['hoshi'] = { id: 'hoshi', provider: 'custom', apiModel: 'hoshi-1' }
    ROUTINGS['hoshi'] = {
      provider: 'custom',
      apiModel: 'hoshi-1',
      baseUrl: 'https://api.hoshi.example/v1',
      apiKey: 'sk-hoshi',
      authStyle: 'bearer',
    }
    setTitleGenerationModelId('hoshi')

    let capturedUrl = ''
    let capturedInit: any = null
    ;(globalThis.fetch as any) = async (url: string, init: any) => {
      capturedUrl = url
      capturedInit = init
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"title": "Hoshi Title", "description": "d"}' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }),
      }
    }

    const result = await generateTitleCompletion({ system: SYSTEM, prompt: PROMPT })

    expect(capturedUrl).toBe('https://api.hoshi.example/v1/chat/completions')
    expect(capturedInit.headers['Authorization']).toBe('Bearer sk-hoshi')
    const body = JSON.parse(capturedInit.body)
    expect(body.model).toBe('hoshi-1')
    expect(result.text).toContain('Hoshi Title')
    expect(result.inputTokens).toBe(20)
    expect(result.outputTokens).toBe(5)
    expect(result.billingModelId).toBe('hoshi')
  })

  test('uses the api-key header when configured', async () => {
    ENTRIES['hoshi'] = { id: 'hoshi', provider: 'custom', apiModel: 'hoshi-1' }
    ROUTINGS['hoshi'] = {
      provider: 'custom',
      apiModel: 'hoshi-1',
      baseUrl: 'https://api.hoshi.example/v1',
      apiKey: 'sk-hoshi',
      authStyle: 'api-key-header',
    }
    setTitleGenerationModelId('hoshi')

    let capturedInit: any = null
    ;(globalThis.fetch as any) = async (_url: string, init: any) => {
      capturedInit = init
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }),
      }
    }

    await generateTitleCompletion({ system: SYSTEM, prompt: PROMPT })
    expect(capturedInit.headers['api-key']).toBe('sk-hoshi')
    expect(capturedInit.headers['Authorization']).toBeUndefined()
  })

  test('falls back to the default Haiku model when the custom provider errors', async () => {
    ENTRIES['hoshi'] = { id: 'hoshi', provider: 'custom', apiModel: 'hoshi-1' }
    ROUTINGS['hoshi'] = {
      provider: 'custom',
      apiModel: 'hoshi-1',
      baseUrl: 'https://api.hoshi.example/v1',
      apiKey: 'sk-hoshi',
      authStyle: 'bearer',
    }
    setTitleGenerationModelId('hoshi')

    ;(globalThis.fetch as any) = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' })

    const result = await generateTitleCompletion({ system: SYSTEM, prompt: PROMPT })
    // The fallback ran the Anthropic default model.
    expect(result.text).toContain('Anthropic Title')
    expect(result.billingModelId).toBe(DEFAULT_TITLE_MODEL_ID)
  })
})

describe('anthropic default model', () => {
  test('runs the Anthropic model when configured id is anthropic', async () => {
    // HAIKU_ENTRY is seeded in beforeEach; configured id is unset → default.
    const result = await generateTitleCompletion({ system: SYSTEM, prompt: PROMPT })
    expect(result.text).toContain('Anthropic Title')
    expect(result.inputTokens).toBe(11)
    expect(result.outputTokens).toBe(7)
    expect(result.billingModelId).toBe(DEFAULT_TITLE_MODEL_ID)
  })

  test('throws when no model can produce a result', async () => {
    // Configured custom provider with no credentials, and no anthropic key for
    // the fallback → nothing can run.
    ENTRIES['hoshi'] = { id: 'hoshi', provider: 'custom', apiModel: 'hoshi-1' }
    setTitleGenerationModelId('hoshi')
    delete process.env.ANTHROPIC_API_KEY

    await expect(generateTitleCompletion({ system: SYSTEM, prompt: PROMPT })).rejects.toThrow()
  })
})
