// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolveModel } from '../pi-adapter.js'

describe('resolveModel — custom OpenAI-compatible (DB) providers', () => {
  const PREV = process.env.OPENAI_BASE_URL

  beforeEach(() => {
    // Simulate configureAIProxy having pointed OpenAI traffic at the proxy.
    process.env.OPENAI_BASE_URL = 'https://api.example.test/api/ai/v1'
  })
  afterEach(() => {
    if (PREV === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = PREV
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
})
