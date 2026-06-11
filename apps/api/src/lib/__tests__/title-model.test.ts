// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/lib/title-model.ts — the admin-selectable model
 * used to generate chat/project titles.
 *
 *   bun test apps/api/src/lib/__tests__/title-model.test.ts
 *
 * Provider/transport selection now lives in `resolve-language-model.ts`
 * (covered by its own test); here we mock that seam and `ai`'s `generateText`
 * so we can drive the configured-vs-default fallback + token mapping
 * deterministically.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

const DEFAULT_ASSISTANT_MODEL = 'hoshi-1.0'

// ─── Controllable resolver + generateText mocks ────────────────────────────
// `resolvable[id]` → the billing id to return, or null/undefined to make the
// model unresolvable (helper returns null → runModel throws).
let resolvable: Record<string, { billingModelId: string } | null | undefined> = {}
// `behavior[id]` → text / usage to return, or { throws: true } to simulate an
// upstream failure for that model.
let behavior: Record<string, { text?: string; usage?: any; throws?: boolean }> = {}

mock.module('../resolve-language-model', () => ({
  DEFAULT_ASSISTANT_MODEL,
  resolveLanguageModel: (id: string) => {
    const r = resolvable[id]
    if (!r) return null
    return { model: { __id: id }, billingModelId: r.billingModelId, provider: 'custom' }
  },
}))

mock.module('ai', () => ({
  generateText: async (opts: any) => {
    const id = opts.model?.__id
    const b = behavior[id] ?? {}
    if (b.throws) throw new Error(`upstream error for ${id}`)
    return {
      text: b.text ?? '{"title": "Default Title", "description": "d"}',
      usage: b.usage ?? { inputTokens: 11, outputTokens: 7 },
    }
  },
}))

const {
  DEFAULT_TITLE_MODEL_ID,
  setTitleGenerationModelId,
  getTitleGenerationModelId,
  generateTitleCompletion,
} = await import('../title-model')

const SYSTEM = 'system prompt'
const PROMPT = 'first message'

beforeEach(() => {
  // Default model resolves and produces a result.
  resolvable = { [DEFAULT_TITLE_MODEL_ID]: { billingModelId: DEFAULT_TITLE_MODEL_ID } }
  behavior = {}
  setTitleGenerationModelId(null)
})

describe('title-model id resolution', () => {
  test('defaults to the shared assistant model id when unset', () => {
    expect(DEFAULT_TITLE_MODEL_ID).toBe(DEFAULT_ASSISTANT_MODEL)
    expect(getTitleGenerationModelId()).toBe(DEFAULT_TITLE_MODEL_ID)
  })

  test('returns the configured id once set, and resets on empty', () => {
    setTitleGenerationModelId('hoshi-custom')
    expect(getTitleGenerationModelId()).toBe('hoshi-custom')
    setTitleGenerationModelId('   ')
    expect(getTitleGenerationModelId()).toBe(DEFAULT_TITLE_MODEL_ID)
  })
})

describe('generateTitleCompletion', () => {
  test('runs the configured model and bills its resolved id + token usage', async () => {
    resolvable['hoshi-custom'] = { billingModelId: 'hoshi-custom' }
    behavior['hoshi-custom'] = {
      text: '{"title": "Hoshi Title", "description": "d"}',
      usage: { inputTokens: 20, outputTokens: 5 },
    }
    setTitleGenerationModelId('hoshi-custom')

    const result = await generateTitleCompletion({ system: SYSTEM, prompt: PROMPT })
    expect(result.text).toContain('Hoshi Title')
    expect(result.inputTokens).toBe(20)
    expect(result.outputTokens).toBe(5)
    expect(result.billingModelId).toBe('hoshi-custom')
  })

  test('maps OpenAI-style usage keys (prompt/completion tokens)', async () => {
    resolvable['hoshi-custom'] = { billingModelId: 'hoshi-custom' }
    behavior['hoshi-custom'] = {
      text: 'x',
      usage: { promptTokens: 42, completionTokens: 9 },
    }
    setTitleGenerationModelId('hoshi-custom')

    const result = await generateTitleCompletion({ system: SYSTEM, prompt: PROMPT })
    expect(result.inputTokens).toBe(42)
    expect(result.outputTokens).toBe(9)
  })

  test('falls back to the default model when the configured model errors', async () => {
    resolvable['hoshi-custom'] = { billingModelId: 'hoshi-custom' }
    behavior['hoshi-custom'] = { throws: true }
    setTitleGenerationModelId('hoshi-custom')

    const result = await generateTitleCompletion({ system: SYSTEM, prompt: PROMPT })
    expect(result.text).toContain('Default Title')
    expect(result.billingModelId).toBe(DEFAULT_TITLE_MODEL_ID)
  })

  test('falls back to the default model when the configured model is unresolvable', async () => {
    // No `resolvable` entry → helper returns null → runModel throws → fallback.
    setTitleGenerationModelId('nonexistent-model')

    const result = await generateTitleCompletion({ system: SYSTEM, prompt: PROMPT })
    expect(result.text).toContain('Default Title')
    expect(result.billingModelId).toBe(DEFAULT_TITLE_MODEL_ID)
  })

  test('only tries the default once when it is also the configured id', async () => {
    behavior[DEFAULT_TITLE_MODEL_ID] = { throws: true }
    await expect(
      generateTitleCompletion({ system: SYSTEM, prompt: PROMPT }),
    ).rejects.toThrow()
  })

  test('throws when neither configured nor default can produce a result', async () => {
    resolvable = {} // nothing resolves at all
    setTitleGenerationModelId('hoshi-custom')
    await expect(
      generateTitleCompletion({ system: SYSTEM, prompt: PROMPT }),
    ).rejects.toThrow()
  })
})
