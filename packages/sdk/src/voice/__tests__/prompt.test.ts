// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MEMORY_BLOCK,
  composeAgentPrompt,
  extractBasePrompt,
  stripMemoryBlock,
} from '../prompt'

describe('stripMemoryBlock', () => {
  test('removes trailing `# Memory` block', () => {
    const composed = `You are a helpful assistant.\n\n${DEFAULT_MEMORY_BLOCK}`
    expect(stripMemoryBlock(composed)).toBe('You are a helpful assistant.')
  })

  test('removes legacy zix-memory marker', () => {
    const composed = `Base prompt.\n\n<!-- zix-memory-v1 -->\nold content here`
    expect(stripMemoryBlock(composed)).toBe('Base prompt.')
  })

  test('is a no-op on plain prompts', () => {
    expect(stripMemoryBlock('simple.')).toBe('simple.')
  })
})

describe('composeAgentPrompt', () => {
  test('is idempotent — applying twice yields the same string', () => {
    const once = composeAgentPrompt('You are Zix.', {
      expressivity: 'subtle',
      audioTags: ['laughs'],
    })
    const twice = composeAgentPrompt(once, {
      expressivity: 'subtle',
      audioTags: ['laughs'],
    })
    expect(twice).toBe(once)
  })

  test('honors memoryBlock=null (no memory appended)', () => {
    const prompt = composeAgentPrompt('Base.', {
      expressivity: 'off',
      memoryBlock: null,
    })
    expect(prompt).toBe('Base.')
  })

  test("uses the default memory block when memoryBlock isn't overridden", () => {
    const prompt = composeAgentPrompt('Base.', {
      expressivity: 'off',
    })
    expect(prompt).toContain('{{user_context}}')
  })

  test('supports a custom memory block', () => {
    const prompt = composeAgentPrompt('Base.', {
      expressivity: 'off',
      memoryBlock: '# Custom',
    })
    expect(prompt.endsWith('# Custom')).toBe(true)
  })
})

describe('extractBasePrompt', () => {
  test('strips both expressivity and memory blocks', () => {
    const base = 'You are Zix.'
    const composed = composeAgentPrompt(base, {
      expressivity: 'full',
      audioTags: ['laughs', 'whispers'],
    })
    expect(extractBasePrompt(composed)).toBe(base)
  })
})
