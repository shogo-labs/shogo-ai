// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { findLastUserMessage, extractUserText } from '../chat-message.js'

describe('findLastUserMessage', () => {
  it('returns null on empty array', () => {
    expect(findLastUserMessage([])).toBeNull()
  })
  it('returns null when no user message exists', () => {
    expect(findLastUserMessage([{ role: 'assistant', content: 'hi' }])).toBeNull()
  })
  it('returns the most recent user message', () => {
    const r = findLastUserMessage([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ])
    expect(r?.content).toBe('second')
  })
})

describe('extractUserText', () => {
  it('returns string content verbatim', () => {
    expect(extractUserText({ role: 'user', content: 'hello' })).toBe('hello')
  })
  it('joins AI SDK v3 parts text segments with newlines', () => {
    expect(extractUserText({
      role: 'user',
      parts: [
        { type: 'text', text: 'line1' },
        { type: 'tool-result', value: 'x' },
        { type: 'text', text: 'line2' },
      ],
    })).toBe('line1\nline2')
  })
  it('returns empty string for parts array with no text', () => {
    expect(extractUserText({ role: 'user', parts: [{ type: 'tool-result', value: 'x' }] })).toBe('')
  })
  it('coerces non-string content to String() fallback', () => {
    expect(extractUserText({ role: 'user', content: 42 })).toBe('42')
    expect(extractUserText({ role: 'user', content: null })).toBe('')
    expect(extractUserText({ role: 'user' })).toBe('')
  })
})
