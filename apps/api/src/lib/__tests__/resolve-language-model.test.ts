// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/lib/resolve-language-model.ts — the shared
 * multi-provider model resolver used by the chat / voice / title surfaces.
 *
 *   bun test apps/api/src/lib/__tests__/resolve-language-model.test.ts
 *
 * Covers the transport-selection logic that previously lived inline in
 * routes/chat.ts and routes/voice.ts: Anthropic via the proxy's
 * `/ai/anthropic/v1` (or a direct key), custom OpenAI-compatible via `/ai/v1`,
 * public-alias → backing-id resolution, and null when nothing is configured.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// ─── Mutable registry + alias fixtures ─────────────────────────────────────
let ENTRIES: Record<string, any> = {}
let ALIASES: Record<string, { backingModelId: string } | null> = {}

mock.module('../../services/model-registry.service', () => ({
  getMergedModelEntrySync: (id: string) => ENTRIES[id],
}))
mock.module('../../services/public-models.service', () => ({
  resolvePublicModelSync: (id: string) => ALIASES[id] ?? null,
}))

// ─── Provider factory spies ────────────────────────────────────────────────
const anthropicCalls: any[] = []
mock.module('@ai-sdk/anthropic', () => ({
  createAnthropic: (opts: any) => {
    anthropicCalls.push(opts)
    return (model: string) => ({ __provider: 'anthropic', __opts: opts, model })
  },
}))
const openaiCalls: any[] = []
mock.module('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: (opts: any) => {
    openaiCalls.push(opts)
    return (model: string) => ({ __provider: 'openai', __opts: opts, model })
  },
}))

const { resolveLanguageModel, DEFAULT_ASSISTANT_MODEL } = await import(
  '../resolve-language-model'
)

const SAVED = {
  AI_PROXY_URL: process.env.AI_PROXY_URL,
  AI_PROXY_TOKEN: process.env.AI_PROXY_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}

beforeEach(() => {
  ENTRIES = {}
  ALIASES = {}
  anthropicCalls.length = 0
  openaiCalls.length = 0
  delete process.env.AI_PROXY_URL
  delete process.env.AI_PROXY_TOKEN
  delete process.env.ANTHROPIC_API_KEY
})

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete (process.env as any)[k]
    else (process.env as any)[k] = v
  }
})

describe('resolveLanguageModel — anthropic models', () => {
  test('routes through the proxy /ai/anthropic/v1 endpoint when proxy is configured', () => {
    process.env.AI_PROXY_URL = 'https://proxy.shogo.ai/ai/v1'
    process.env.AI_PROXY_TOKEN = 'proxy-token'
    ENTRIES['claude-haiku-4-5-20251001'] = {
      provider: 'anthropic',
      apiModel: 'claude-haiku-4-5-20251001',
    }

    const resolved = resolveLanguageModel('claude-haiku-4-5-20251001')
    expect(resolved).not.toBeNull()
    expect(resolved!.provider).toBe('anthropic')
    expect(resolved!.billingModelId).toBe('claude-haiku-4-5-20251001')
    expect(anthropicCalls[0].baseURL).toBe('https://proxy.shogo.ai/ai/anthropic/v1')
    expect(anthropicCalls[0].apiKey).toBe('proxy-token')
    expect((resolved!.model as any).model).toBe('claude-haiku-4-5-20251001')
  })

  test('falls back to a direct ANTHROPIC_API_KEY client (no baseURL) when no proxy', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    const resolved = resolveLanguageModel('claude-sonnet-4-5')
    expect(resolved).not.toBeNull()
    expect(resolved!.provider).toBe('anthropic')
    expect(anthropicCalls[0].baseURL).toBeUndefined()
    expect(anthropicCalls[0].apiKey).toBe('sk-ant')
  })

  test('infers anthropic from a claude-* id even without a registry entry', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    const resolved = resolveLanguageModel('claude-3-5-sonnet-20240620')
    expect(resolved!.provider).toBe('anthropic')
    expect((resolved!.model as any).model).toBe('claude-3-5-sonnet-20240620')
  })

  test('returns null when no anthropic transport is configured', () => {
    const resolved = resolveLanguageModel('claude-haiku-4-5')
    expect(resolved).toBeNull()
  })

  test('partial proxy config (token without URL) falls back to the direct key', () => {
    process.env.AI_PROXY_TOKEN = 'orphan'
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    const resolved = resolveLanguageModel('claude-haiku-4-5')
    expect(anthropicCalls[0].baseURL).toBeUndefined()
    expect(anthropicCalls[0].apiKey).toBe('sk-ant')
  })
})

describe('resolveLanguageModel — custom OpenAI-compatible models', () => {
  test('resolves a public alias to its backing id and routes via proxy /ai/v1', () => {
    process.env.AI_PROXY_URL = 'https://proxy.shogo.ai/ai/v1'
    process.env.AI_PROXY_TOKEN = 'proxy-token'
    ALIASES['hoshi-1.0'] = { backingModelId: 'hoshi-backing-id' }
    ENTRIES['hoshi-backing-id'] = { provider: 'custom', apiModel: 'hoshi-upstream-1' }

    const resolved = resolveLanguageModel('hoshi-1.0')
    expect(resolved).not.toBeNull()
    expect(resolved!.provider).toBe('custom')
    expect(resolved!.billingModelId).toBe('hoshi-backing-id')
    expect(openaiCalls[0].baseURL).toBe('https://proxy.shogo.ai/ai/v1')
    expect(openaiCalls[0].apiKey).toBe('proxy-token')
    // The proxy resolves DB ids/aliases, so forward the backing id (not the
    // upstream apiModel).
    expect((resolved!.model as any).model).toBe('hoshi-backing-id')
    expect(anthropicCalls.length).toBe(0)
  })

  test('honors a registry entry provider over the claude prefix heuristic', () => {
    process.env.AI_PROXY_URL = 'https://proxy.shogo.ai/ai/v1'
    process.env.AI_PROXY_TOKEN = 'proxy-token'
    // Non-claude id with an explicit custom provider → custom branch.
    ENTRIES['mimo-1'] = { provider: 'custom', apiModel: 'mimo-upstream' }
    const resolved = resolveLanguageModel('mimo-1')
    expect(resolved!.provider).toBe('custom')
    expect(openaiCalls.length).toBe(1)
  })

  test('returns null for a custom model when the proxy is not configured', () => {
    ENTRIES['mimo-1'] = { provider: 'custom', apiModel: 'mimo-upstream' }
    // No proxy creds; the direct anthropic key does NOT enable custom models.
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    const resolved = resolveLanguageModel('mimo-1')
    expect(resolved).toBeNull()
  })
})

describe('resolveLanguageModel — header forwarding', () => {
  test('forwards custom headers to the anthropic provider', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    resolveLanguageModel('claude-haiku-4-5', {
      headers: { 'x-shogo-usage-tag': 'title_generation' },
    })
    expect(anthropicCalls[0].headers).toEqual({ 'x-shogo-usage-tag': 'title_generation' })
  })

  test('forwards custom headers to the custom OpenAI-compatible provider', () => {
    process.env.AI_PROXY_URL = 'https://proxy.shogo.ai/ai/v1'
    process.env.AI_PROXY_TOKEN = 'proxy-token'
    ENTRIES['mimo-1'] = { provider: 'custom', apiModel: 'mimo-upstream' }
    resolveLanguageModel('mimo-1', {
      headers: { 'x-shogo-usage-tag': 'title_generation' },
    })
    expect(openaiCalls[0].headers).toEqual({ 'x-shogo-usage-tag': 'title_generation' })
  })
})

describe('DEFAULT_ASSISTANT_MODEL', () => {
  test('is the Hoshi public alias', () => {
    expect(DEFAULT_ASSISTANT_MODEL).toBe('hoshi-1.0')
  })
})
