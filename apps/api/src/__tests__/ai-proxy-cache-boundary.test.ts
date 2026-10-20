// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prompt-cache accounting at the proxy boundary (SHO-82).
 *
 * Two things the cache-efficiency suite depends on but cannot see from inside
 * the runtime:
 *
 *  1. The `<|CACHE_BOUNDARY|>` canary must never reach a model as text. On
 *     Anthropic it splits the system prompt into a cached block and an uncached
 *     one; on every other provider there is no breakpoint to place, so it is
 *     stripped rather than shipped.
 *  2. The usage split must be an identity: hit + miss + write == the provider's
 *     prompt tokens, with cache writes reported only where the provider has them
 *     (Anthropic). Double-counting `cached_tokens` would inflate every ratio the
 *     suite reports.
 */
import { describe, test, expect } from 'bun:test'
import {
  anthropicUsageToOpenAI,
  applyDefaultCacheBreakpoints,
  splitOpenAIPromptUsage,
  stripCacheBoundaryText,
} from '../routes/ai-proxy'

const MARKER = '<|CACHE_BOUNDARY|>'

describe('stripCacheBoundaryText', () => {
  test('removes the canary and leaves one blank line between the two zones', () => {
    const input = `stable guide text\n\n${MARKER}\n\ndynamic memory text`
    expect(stripCacheBoundaryText(input)).toBe('stable guide text\n\ndynamic memory text')
  })

  test('leaves text without the canary byte-identical', () => {
    const clean = '# Prompt\n\nNothing to see.\n'
    expect(stripCacheBoundaryText(clean)).toBe(clean)
  })

  test('strips an inline occurrence too (never shipped as prompt text)', () => {
    expect(stripCacheBoundaryText(`a ${MARKER} b`)).not.toContain(MARKER)
  })
})

describe('Anthropic breakpoints stay as they were', () => {
  test('the stable block keeps cache_control and the dynamic block does not', () => {
    const body: Record<string, any> = {
      system: `STABLE${'\n\n'}${MARKER}${'\n\n'}DYNAMIC`,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object' } }],
    }
    applyDefaultCacheBreakpoints(body)
    const blocks = body.system as Array<{ text: string; cache_control?: unknown }>
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toBe('STABLE')
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1].text).toBe('DYNAMIC')
    expect(blocks[1].cache_control).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(MARKER)
  })
})

describe('usage identity across both wire formats', () => {
  test('Anthropic → OpenAI → runtime split round-trips exactly', () => {
    const cases = [
      { input: 100, read: 0, write: 0 },
      { input: 100, read: 900, write: 0 },
      { input: 100, read: 900, write: 200 },
      { input: 3, read: 0, write: 7_200 },
    ]
    for (const c of cases) {
      const split = splitOpenAIPromptUsage(anthropicUsageToOpenAI(c.input, c.read, c.write, 42))
      expect(split).toEqual({
        inputTokens: c.input,
        cachedInputTokens: c.read,
        cacheWriteTokens: c.write,
      })
      // hit + miss + write is the provider's prompt total — nothing lost, nothing doubled.
      const openai = anthropicUsageToOpenAI(c.input, c.read, c.write, 42)
      expect(split.inputTokens + split.cachedInputTokens + split.cacheWriteTokens).toBe(openai.prompt_tokens)
    }
  })

  test('cached_tokens is not double counted when writes are present', () => {
    const usage = anthropicUsageToOpenAI(100, 900, 200, 42)
    expect(usage.prompt_tokens_details.cached_tokens).toBe(1_100)
    const split = splitOpenAIPromptUsage(usage)
    expect(split.cachedInputTokens).toBe(900)
    expect(split.cacheWriteTokens).toBe(200)
    expect(split.cachedInputTokens + split.cacheWriteTokens).toBe(usage.prompt_tokens_details.cached_tokens)
  })

  test('DeepSeek-style usage reports no cache writes (writes are Anthropic-only)', () => {
    const split = splitOpenAIPromptUsage({ prompt_tokens: 10_000, prompt_cache_hit_tokens: 9_000, prompt_cache_miss_tokens: 1_000 })
    expect(split).toEqual({ inputTokens: 1_000, cachedInputTokens: 9_000, cacheWriteTokens: 0 })
  })
})
