// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolveModel } from '../pi-adapter.js'
import { clearDynamicModels, registerDynamicModels } from '../model-catalog'

describe('resolveModel — custom OpenAI-compatible (DB) providers', () => {
  const PREV = process.env.OPENAI_BASE_URL
  const PREV_DEEPSEEK = process.env.AGENT_DEEPSEEK_MODEL_IDS

  beforeEach(() => {
    // Simulate configureAIProxy having pointed OpenAI traffic at the proxy.
    process.env.OPENAI_BASE_URL = 'https://api.example.test/api/ai/v1'
  })
  afterEach(() => {
    if (PREV === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = PREV
    if (PREV_DEEPSEEK === undefined) delete process.env.AGENT_DEEPSEEK_MODEL_IDS
    else process.env.AGENT_DEEPSEEK_MODEL_IDS = PREV_DEEPSEEK
  })

  it('routes a custom model through the OpenAI chat-completions proxy', () => {
    const model = resolveModel('custom', 'mimo-v2.5')
    // Native OpenAI chat-completions API (preserves tool calls), NOT the
    // lossy Anthropic conversion path and NOT the OpenAI Responses API.
    expect(model.api).toBe('openai-completions')
    // Tagged as openai so the proxy token/base URL resolve via OPENAI_* env.
    expect(model.provider).toBe('openai')
    // pi sends model.id as the upstream model name; the proxy resolves the
    // DB routing for it.
    expect(model.id).toBe('mimo-v2.5')
    // Base URL is the proxy (OpenAI SDK appends /chat/completions).
    expect(model.baseUrl).toBe('https://api.example.test/api/ai/v1')
  })

  it('falls back to the OpenAI default base URL when no proxy is configured', () => {
    delete process.env.OPENAI_BASE_URL
    const model = resolveModel('custom', 'some-db-model')
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://api.openai.com')
  })

  it('adds explicit DeepSeek compatibility for DB-backed Hoshi models', () => {
    process.env.AGENT_DEEPSEEK_MODEL_IDS = 'hoshi-2-0'
    const model = resolveModel('custom', 'hoshi-2-0') as any
    expect(model.compat).toEqual({
      cacheControlFormat: 'anthropic',
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
      supportsStore: false,
      supportsDeveloperRole: false,
    })
  })

  it('also recognizes a direct DeepSeek model id', () => {
    const model = resolveModel('custom', 'deepseek-flash') as any
    expect(model.compat?.thinkingFormat).toBe('deepseek')
  })

  it('asks pi-ai for Anthropic-style cache markers on custom models', () => {
    const model = resolveModel('custom', 'mimo-v2.5') as any
    expect(model.compat?.cacheControlFormat).toBe('anthropic')
  })
})

describe('resolveModel — DB models from the dynamic registry', () => {
  const OPUS_UUID = '8947628a-1415-4b3a-90c3-63f8a85c16b7'
  const PREV_ANTHROPIC = process.env.ANTHROPIC_BASE_URL

  beforeEach(() => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.example.test/api/ai/anthropic'
  })
  afterEach(() => {
    clearDynamicModels()
    if (PREV_ANTHROPIC === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = PREV_ANTHROPIC
  })

  it('routes an Anthropic-backed custom id through native Anthropic messages', () => {
    registerDynamicModels([{ id: OPUS_UUID, provider: 'anthropic', apiModel: 'claude-opus-5-5', contextWindow: 1_000_000 }])
    const model = resolveModel('custom', OPUS_UUID)
    expect(model.api).toBe('anthropic-messages')
    expect(model.provider).toBe('anthropic')
    expect(model.id).toBe(OPUS_UUID)
    expect(model.baseUrl).toBe('https://api.example.test/api/ai/anthropic')
    expect(model.contextWindow).toBe(1_000_000)
  })

  it('treats a claude-* apiModel as Anthropic-backed even under another provider label', () => {
    registerDynamicModels([{ id: OPUS_UUID, provider: 'custom', apiModel: 'claude-opus-5-5' }])
    expect(resolveModel('custom', OPUS_UUID).api).toBe('anthropic-messages')
  })

  it('uses the registry context window for genuine custom models', () => {
    registerDynamicModels([{ id: 'mimo-v2.5', provider: 'custom', apiModel: 'mimo-v2.5', contextWindow: 256_000 }])
    const model = resolveModel('custom', 'mimo-v2.5')
    expect(model.api).toBe('openai-completions')
    expect(model.contextWindow).toBe(256_000)
  })

  it('keeps the 200K default for ids the registry does not know', () => {
    expect(resolveModel('custom', 'unknown-model').contextWindow).toBe(200_000)
  })
})

// SHO-231: a `provider: 'google'` model row (Gemini) is served by the API
// proxy, which is the only place holding the Google key. The runtime has no
// GOOGLE_API_KEY of its own, so it must not build a native Google model that
// talks to generativelanguage.googleapis.com directly.
describe('resolveModel — Google (Gemini) models', () => {
  const GEMINI_UUID = '5b0c1c1e-9f2a-4f7d-8c2b-0a1b2c3d4e5f'
  const PREV_OPENAI = process.env.OPENAI_BASE_URL
  const PREV_GOOGLE = process.env.GOOGLE_BASE_URL

  beforeEach(() => {
    process.env.OPENAI_BASE_URL = 'https://api.example.test/api/ai/v1'
    delete process.env.GOOGLE_BASE_URL
  })
  afterEach(() => {
    clearDynamicModels()
    if (PREV_OPENAI === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = PREV_OPENAI
    if (PREV_GOOGLE === undefined) delete process.env.GOOGLE_BASE_URL
    else process.env.GOOGLE_BASE_URL = PREV_GOOGLE
  })

  it('routes a DB Gemini model through the proxy chat-completions endpoint', () => {
    registerDynamicModels([{ id: GEMINI_UUID, provider: 'google', apiModel: 'gemini-2.5-flash' }])
    const model = resolveModel('google', GEMINI_UUID)
    expect(model.api).toBe('openai-completions')
    expect(model.provider).toBe('openai')
    expect(model.baseUrl).toBe('https://api.example.test/api/ai/v1')
  })

  it('keeps a static gemini id off the native Google transport too', () => {
    const model = resolveModel('google', 'gemini-2.5-pro')
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://api.example.test/api/ai/v1')
  })
})
