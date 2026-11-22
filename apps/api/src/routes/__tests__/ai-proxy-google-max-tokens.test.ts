// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gemini proxy invariants
 *
 *  1. When a request to a Gemini model carries no `max_tokens`, the proxy
 *     injects `max_tokens: 65_536` (the catalog cap) so we never ask Google
 *     for a synchronous response longer than the endpoint allows.
 *  2. When the caller explicitly passes `max_tokens`, that value is used as-is.
 *  3. The catalog `reasoningEffort` survives the Google body rewrite
 *     (it is NOT deleted like `thinking` and `reasoning_content` are).
 *
 * Run: bun test ./apps/api/src/routes/__tests__/ai-proxy-google-max-tokens.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { buildOpenAICompatibleBody } from '../ai-proxy'

type Req = { model: string; messages: any[]; max_tokens?: number }

function googleConfig(model: string) {
  return { provider: 'google' as const, apiModel: model }
}

function req(model: string, maxTokens?: number): Req {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
  }
}

describe('buildOpenAICompatibleBody — Gemini max_tokens injection', () => {
  it('injects max_tokens: 65536 when caller omits it (Carbon)', () => {
    const body = buildOpenAICompatibleBody(req('gemini-4-carbon') as any, googleConfig('gemini-4-carbon') as any, {})
    expect(body.max_tokens).toBe(65_536)
  })

  it('injects max_tokens: 65536 when caller omits it (Argon)', () => {
    const body = buildOpenAICompatibleBody(req('gemini-4-argon') as any, googleConfig('gemini-4-argon') as any, {})
    expect(body.max_tokens).toBe(65_536)
  })

  it('injects max_tokens: 65536 when caller omits it (Neon)', () => {
    const body = buildOpenAICompatibleBody(req('gemini-4-neon') as any, googleConfig('gemini-4-neon') as any, {})
    expect(body.max_tokens).toBe(65_536)
  })

  it('honours an explicit max_tokens from the caller', () => {
    const body = buildOpenAICompatibleBody(req('gemini-4-carbon', 1024) as any, googleConfig('gemini-4-carbon') as any, {})
    expect(body.max_tokens).toBe(1024)
  })

  it('does not set max_completion_tokens for Google (OpenAI-only field)', () => {
    const body = buildOpenAICompatibleBody(req('gemini-4-carbon') as any, googleConfig('gemini-4-carbon') as any, {})
    expect(body.max_completion_tokens).toBeUndefined()
  })

  // pi-ai's chat-completions client sends max_completion_tokens on every turn;
  // Google 400s "max_tokens and max_completion_tokens cannot both be set".
  it('folds a runtime max_completion_tokens into max_tokens, never sending both', () => {
    const r = { ...req('gemini-4-carbon'), max_completion_tokens: 32_000 } as any
    const body = buildOpenAICompatibleBody(r, googleConfig('gemini-4-carbon') as any, {})
    expect(body.max_tokens).toBe(32_000)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('prefers an explicit max_tokens when both arrive', () => {
    const r = { ...req('gemini-4-carbon', 1024), max_completion_tokens: 32_000 } as any
    const body = buildOpenAICompatibleBody(r, googleConfig('gemini-4-carbon') as any, {})
    expect(body.max_tokens).toBe(1024)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('strips store / thinking / reasoning_content for Google', () => {
    const r = {
      ...req('gemini-4-argon'),
      store: true,
      thinking: { type: 'enabled' },
      reasoning_content: 'x',
    } as any
    const body = buildOpenAICompatibleBody(r, googleConfig('gemini-4-argon') as any, {})
    expect(body.store).toBeUndefined()
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_content).toBeUndefined()
  })
})
