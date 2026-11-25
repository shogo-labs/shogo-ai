// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { getGoogleThinkingEfforts, getSupportedReasoningEfforts, isReasoningEffort } from '../index'

describe('model reasoning effort metadata', () => {
  test('keeps Google model-specific supported levels', () => {
    expect(getGoogleThinkingEfforts('gemini-3.5-flash-lite')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(getGoogleThinkingEfforts('gemini-4-neon')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(getSupportedReasoningEfforts({ provider: 'google', apiModel: 'gemini-4-carbon' } as any))
      .toEqual(['low', 'medium', 'high'])
  })

  test('exposes known native provider capabilities', () => {
    expect(getSupportedReasoningEfforts({
      provider: 'anthropic', apiModel: 'claude-sonnet-5', thinkingApi: 'adaptive',
    } as any)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(getSupportedReasoningEfforts({
      provider: 'openai', apiModel: 'gpt-6-astra',
    } as any)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  test('requires explicit capabilities for unknown/custom routes and filters malformed metadata', () => {
    expect(getSupportedReasoningEfforts({ provider: 'custom', apiModel: 'reasoner' } as any)).toEqual([])
    expect(getSupportedReasoningEfforts({
      provider: 'custom',
      apiModel: 'reasoner',
      capabilities: { reasoningEfforts: ['low', 'turbo', 'high', 'low'] },
    } as any)).toEqual(['low', 'high'])
    expect(getSupportedReasoningEfforts({
      provider: 'custom', apiModel: 'reasoner', capabilities: { reasoningEfforts: [] },
    } as any)).toEqual([])
  })

  test('validates only the supported effort vocabulary', () => {
    expect(isReasoningEffort('xhigh')).toBe(true)
    expect(isReasoningEffort('turbo')).toBe(false)
  })
})
