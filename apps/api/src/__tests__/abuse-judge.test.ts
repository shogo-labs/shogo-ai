// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// SHO-459 — judgeCandidate unit tests.
//
// Tests:
//   1. LLM-invented turnIds are stripped before returning.
//   2. Malformed JSON on first attempt → retried → success.
//   3. Malformed JSON on both attempts → returns null.
//   4. First attempt throws → returns null.
//   5. No model transport → returns null (graceful skip).
//
//   bun test apps/api/src/__tests__/abuse-judge.test.ts

import { describe, expect, mock, test, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// Module mocks — declared at top level before any dynamic import of ai.
// ---------------------------------------------------------------------------

let _generateTextImpl: (...args: any[]) => Promise<{ text: string }> = async () => ({ text: '{}' })

mock.module('ai', () => ({
  generateText: (...args: any[]) => _generateTextImpl(...args),
}))

let _resolveLanguageModelImpl: (...args: any[]) => any = () => ({
  model: {},
  billingModelId: 'mock-model-id',
  provider: 'openai',
})

mock.module('../lib/resolve-language-model', () => ({
  resolveLanguageModel: (...args: any[]) => _resolveLanguageModelImpl(...args),
}))

mock.module('@shogo/model-catalog', () => ({
  resolveAgentModeDefault: () => 'mock-model-id',
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTurn = (id: string) => ({
  id,
  userId: 'u1',
  source: 'cloud' as const,
  createdAt: new Date(),
  userText: `user text for ${id}`,
  assistantText: `assistant text for ${id}`,
})

function goodJson(turnIds: string[]): string {
  return JSON.stringify({
    verdicts: [
      {
        category: 'offensive_third_party',
        severity: 85,
        confidence: 'high',
        summary: 'probing external systems',
        turnIds,
      },
    ],
  })
}

// ---------------------------------------------------------------------------
// 1. turnId filtering
// ---------------------------------------------------------------------------

describe('judgeCandidate — LLM turnId filtering', () => {
  beforeEach(() => {
    _resolveLanguageModelImpl = () => ({ model: {}, billingModelId: 'mock-model-id', provider: 'openai' })
  })

  test('invented turnIds returned by LLM are stripped', async () => {
    const turns = [makeTurn('real-t1'), makeTurn('real-t2')]
    _generateTextImpl = async () => ({ text: goodJson(['real-t1', 'real-t2', 'invented-999']) })
    const { judgeCandidate } = await import('../services/abuse/judge')
    const result = await judgeCandidate(turns)
    expect(result).not.toBeNull()
    expect(result!.verdicts[0].turnIds).toEqual(['real-t1', 'real-t2'])
    expect(result!.verdicts[0].turnIds).not.toContain('invented-999')
  })

  test('verdict whose ALL turnIds were invented has an empty turnIds array', async () => {
    const turns = [makeTurn('real-t1')]
    _generateTextImpl = async () => ({ text: goodJson(['invented-a', 'invented-b']) })
    const { judgeCandidate } = await import('../services/abuse/judge')
    const result = await judgeCandidate(turns)
    expect(result).not.toBeNull()
    expect(result!.verdicts[0].turnIds).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Retry on malformed JSON
// ---------------------------------------------------------------------------

describe('judgeCandidate — retry on malformed JSON', () => {
  beforeEach(() => {
    _resolveLanguageModelImpl = () => ({ model: {}, billingModelId: 'mock', provider: 'openai' })
  })

  test('malformed first attempt → valid second attempt → returns verdicts', async () => {
    const turns = [makeTurn('t1')]
    let calls = 0
    _generateTextImpl = async () => {
      calls++
      return { text: calls === 1 ? 'this is not json }{' : goodJson(['t1']) }
    }
    const { judgeCandidate } = await import('../services/abuse/judge')
    const result = await judgeCandidate(turns)
    expect(result).not.toBeNull()
    expect(calls).toBe(2)
    expect(result!.verdicts).toHaveLength(1)
  })

  test('both attempts malformed → returns null', async () => {
    const turns = [makeTurn('t1')]
    _generateTextImpl = async () => ({ text: 'NOT_JSON' })
    const { judgeCandidate } = await import('../services/abuse/judge')
    const result = await judgeCandidate(turns)
    expect(result).toBeNull()
  })

  test('first attempt throws → returns null', async () => {
    const turns = [makeTurn('t1')]
    _generateTextImpl = async () => { throw new Error('transport error') }
    const { judgeCandidate } = await import('../services/abuse/judge')
    const result = await judgeCandidate(turns)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. No model transport
// ---------------------------------------------------------------------------

describe('judgeCandidate — no model transport', () => {
  test('resolveLanguageModel returns null → returns null', async () => {
    _resolveLanguageModelImpl = () => null
    const { judgeCandidate } = await import('../services/abuse/judge')
    const result = await judgeCandidate([makeTurn('t1')])
    expect(result).toBeNull()
  })
})
