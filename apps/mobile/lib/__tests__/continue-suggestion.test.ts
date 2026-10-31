// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "Continue <project>" chip's one line of text (SHO-266).
 *
 * The suggestion is read off the last assistant turn the phone already has, so
 * these pin the three outcomes the chip depends on: the question the turn
 * closed on, the short imperative line it ended with when it asked nothing, and
 * nothing at all when the turn left neither.
 */
import { describe, expect, test } from 'bun:test'
import {
  MAX_SUGGESTION_CHARS,
  continueChipLabel,
  continueSuggestionFromMessages,
  suggestionFromAssistantText,
} from '../chat/continue-suggestion'

describe('suggestionFromAssistantText', () => {
  test('prefers the last question the turn asked', () => {
    const text = [
      'I scaffolded the app and the dev server is running.',
      'Want me to wire up the pricing page next?',
      'Anything else before I stop?',
    ].join('\n')
    expect(suggestionFromAssistantText(text)).toBe('Anything else before I stop?')
  })

  test('falls back to the last short imperative line', () => {
    const text = [
      'The build finished and the preview is live.',
      'Here is what changed:',
      '- new landing page',
      'Run the tests',
    ].join('\n')
    expect(suggestionFromAssistantText(text)).toBe('Run the tests')
  })

  test('prefers an earlier question over a later imperative line', () => {
    const text = ['Shall I add a dark mode toggle?', 'Ping me if you want it faster'].join('\n')
    expect(suggestionFromAssistantText(text)).toBe('Shall I add a dark mode toggle?')
  })

  test('returns nothing when the turn ends on a plain statement', () => {
    expect(suggestionFromAssistantText('The build completed. Nothing failed.')).toBeNull()
  })

  test('returns nothing for an empty or whitespace turn', () => {
    expect(suggestionFromAssistantText('')).toBeNull()
    expect(suggestionFromAssistantText('   \n\n ')).toBeNull()
    expect(suggestionFromAssistantText(null)).toBeNull()
  })

  test('ignores fenced code, headings, rules and table rows', () => {
    const text = [
      '## Summary',
      '```',
      'Run the tests',
      '```',
      '---',
      '| file | change |',
      'All done.',
    ].join('\n')
    expect(suggestionFromAssistantText(text)).toBeNull()
  })

  test('reads a stripped list item or blockquote as the imperative line', () => {
    expect(suggestionFromAssistantText('- Restart the dev server')).toBe('Restart the dev server')
    expect(suggestionFromAssistantText('> Deploy it')).toBe('Deploy it')
  })

  test('drops markdown emphasis and link syntax from the line', () => {
    expect(suggestionFromAssistantText('**Run `bun test`**')).toBe('Run bun test')
    expect(suggestionFromAssistantText('Open [the preview](https://x.test/p)')).toBe('Open the preview')
  })

  test('collapses a wrapped question into one line', () => {
    expect(suggestionFromAssistantText('Want me to\nwire up the\npricing page?')).toBe(
      'Want me to wire up the pricing page?',
    )
  })

  test('clips a long question at a word boundary', () => {
    const long = `${'word '.repeat(60)}what next?`
    const suggestion = suggestionFromAssistantText(long)
    expect(suggestion).not.toBeNull()
    expect(suggestion!.length).toBeLessThanOrEqual(MAX_SUGGESTION_CHARS + 1)
    expect(suggestion!.endsWith('…')).toBe(true)
  })
})

describe('continueSuggestionFromMessages', () => {
  test('reads only the last assistant turn', () => {
    const suggestion = continueSuggestionFromMessages([
      { role: 'assistant', parts: [{ type: 'text', text: 'An older question?' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Ship it' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Ship the pricing page now?' }] },
    ])
    expect(suggestion).toBe('Ship the pricing page now?')
  })

  test('falls back to plain content when a message has no parts', () => {
    expect(
      continueSuggestionFromMessages([{ role: 'assistant', content: 'Rename the project?' }]),
    ).toBe('Rename the project?')
  })

  test('is null when the transcript is empty or has no assistant turn', () => {
    expect(continueSuggestionFromMessages([])).toBeNull()
    expect(continueSuggestionFromMessages(null)).toBeNull()
    expect(
      continueSuggestionFromMessages([{ role: 'user', parts: [{ type: 'text', text: 'hi?' }] }]),
    ).toBeNull()
  })

  test('skips a trailing tool-only row (a row with no text is not a turn)', () => {
    const suggestion = continueSuggestionFromMessages([
      { role: 'assistant', parts: [{ type: 'text', text: 'Add a README' }] },
      { role: 'assistant', parts: [{ type: 'tool-invocation', text: undefined }] },
    ])
    expect(suggestion).toBe('Add a README')
  })

  test('never reads past the last assistant turn that has text', () => {
    // The last turn ended plainly: it offered nothing, and an older turn's
    // question is not the next step of this conversation (QA, SHO-266).
    const suggestion = continueSuggestionFromMessages([
      { role: 'assistant', parts: [{ type: 'text', text: 'Want me to wire up the pricing page?' }] },
      { role: 'user', parts: [{ type: 'text', text: 'No, just make it build.' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Done. Build passed.' }] },
    ])
    expect(suggestion).toBeNull()
  })
})

describe('continueChipLabel', () => {
  test('names the project, and falls back to a bare Continue', () => {
    expect(continueChipLabel('Surfer')).toBe('Continue Surfer')
    expect(continueChipLabel('  Surfer  ')).toBe('Continue Surfer')
    expect(continueChipLabel('')).toBe('Continue')
    expect(continueChipLabel(null)).toBe('Continue')
  })
})
