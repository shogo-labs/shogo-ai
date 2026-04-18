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
})
