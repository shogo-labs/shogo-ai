// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { createLlmSummarizer, identitySummarizer } from '../summarizer'

describe('summarizer', () => {
  test('identitySummarizer returns input unchanged', async () => {
    expect(await identitySummarizer.summarize('hello world')).toBe('hello world')
  })

  test('createLlmSummarizer passes transcript via default prompt', async () => {
    let seenPrompt = ''
    const s = createLlmSummarizer({
      complete: async prompt => {
        seenPrompt = prompt
        return '- a\n- b\n'
      },
    })
    const out = await s.summarize('raw transcript text')
    expect(out).toBe('- a\n- b\n')
    expect(seenPrompt).toContain('raw transcript text')
    expect(seenPrompt).toMatch(/bullet/i)
  })

  test('createLlmSummarizer honors a custom buildPrompt', async () => {
    let seenPrompt = ''
    const s = createLlmSummarizer({
      complete: async p => {
        seenPrompt = p
        return ''
      },
      buildPrompt: t => `CUSTOM::${t}`,
    })
    await s.summarize('hello')
    expect(seenPrompt).toBe('CUSTOM::hello')
  })

  test('identitySummarizer.consolidate unions existing + transcript as bullets', async () => {
    const out = await identitySummarizer.consolidate!({
      existingBullets: ['likes tea', 'lives in Honolulu'],
      transcript: 'user mentioned enjoying sushi',
    })
    expect(out).toBe('- likes tea\n- lives in Honolulu\n- user mentioned enjoying sushi')
  })

  test('identitySummarizer.consolidate handles empty existing bullets', async () => {
    const out = await identitySummarizer.consolidate!({
      existingBullets: [],
      transcript: 'first fact',
    })
    expect(out).toBe('- first fact')
  })

  test('createLlmSummarizer.consolidate uses a default prompt with merge/conflict rules', async () => {
    let seenPrompt = ''
    const s = createLlmSummarizer({
      complete: async p => {
        seenPrompt = p
        return '- favorite color: turquoise\n- lives in Honolulu'
      },
    })
    const out = await s.consolidate!({
      existingBullets: ['favorite color: cerulean', 'lives in Honolulu'],
      transcript: 'User: actually I like turquoise now',
    })
    expect(out).toContain('turquoise')
    expect(seenPrompt).toContain('- favorite color: cerulean')
    expect(seenPrompt).toContain('actually I like turquoise now')
    expect(seenPrompt).toMatch(/merge/i)
    expect(seenPrompt).toMatch(/conflict/i)
  })

  test('createLlmSummarizer.consolidate shows (none) for empty existing memory', async () => {
    let seenPrompt = ''
    const s = createLlmSummarizer({
      complete: async p => {
        seenPrompt = p
        return ''
      },
    })
    await s.consolidate!({ existingBullets: [], transcript: 'hello' })
    expect(seenPrompt).toContain('(none)')
  })

  test('createLlmSummarizer honors a custom buildConsolidationPrompt', async () => {
    let seenPrompt = ''
    const s = createLlmSummarizer({
      complete: async p => {
        seenPrompt = p
        return '- out'
      },
      buildConsolidationPrompt: ({ existingBullets, transcript }) =>
        `CONS::${existingBullets.join('|')}::${transcript}`,
    })
    await s.consolidate!({ existingBullets: ['a', 'b'], transcript: 't' })
    expect(seenPrompt).toBe('CONS::a|b::t')
  })
})
