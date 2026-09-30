// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AGENT_SUMMARIZER_MODEL parsing. The summarizer must run on its own injected
 * model + provider — never the session's provider — or an Anthropic id gets
 * paired with an OpenAI session and sent to OpenAI's Responses API.
 */

import { describe, expect, test } from 'bun:test'
import { resolveSummarizerModel } from '../gateway'

const FALLBACK = { id: 'claude-haiku-4-5', provider: 'anthropic' }

describe('resolveSummarizerModel', () => {
  test('uses the injected id and provider (Hoshi 2.0 backing model)', () => {
    expect(resolveSummarizerModel(JSON.stringify({ id: 'deepseek-flash', provider: 'custom' })))
      .toEqual({ id: 'deepseek-flash', provider: 'custom' })
  })

  test('infers the provider from the id when none is injected', () => {
    expect(resolveSummarizerModel(JSON.stringify({ id: 'gpt-5.4-nano' })))
      .toEqual({ id: 'gpt-5.4-nano', provider: 'openai' })
    expect(resolveSummarizerModel(JSON.stringify({ id: 'claude-haiku-4-5' })))
      .toEqual({ id: 'claude-haiku-4-5', provider: 'anthropic' })
  })

  test('keeps the local provider for local-LLM runtimes', () => {
    expect(resolveSummarizerModel(JSON.stringify({ id: 'qwen3:8b', provider: 'local' })))
      .toEqual({ id: 'qwen3:8b', provider: 'local' })
  })

  test('falls back to Haiku on Anthropic when unset or malformed', () => {
    expect(resolveSummarizerModel(undefined)).toEqual(FALLBACK)
    expect(resolveSummarizerModel('')).toEqual(FALLBACK)
    expect(resolveSummarizerModel('not json')).toEqual(FALLBACK)
    expect(resolveSummarizerModel('null')).toEqual(FALLBACK)
    expect(resolveSummarizerModel(JSON.stringify({ id: '  ' }))).toEqual(FALLBACK)
    expect(resolveSummarizerModel(JSON.stringify({ provider: 'openai' }))).toEqual(FALLBACK)
  })
})
