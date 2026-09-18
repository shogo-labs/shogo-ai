// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the pure helper functions in helpers.ts — the parts of the
 * eval ladder that don't need a live agent runtime or GitHub repo, so they
 * run in normal CI unlike l0-l3.integration.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import {
  botComments,
  countNumberedOptions,
  extractLearnedSection,
  extractRunId,
  sectionsChangedOutsideLearned,
  type GhIssue,
} from './helpers'

describe('extractRunId', () => {
  test('finds the marker in a body', () => {
    expect(extractRunId('hello\n<!-- shogo:runId=run_abc123 -->\nworld')).toBe('run_abc123')
  })

  test('returns undefined when absent', () => {
    expect(extractRunId('no marker here')).toBeUndefined()
    expect(extractRunId(null)).toBeUndefined()
    expect(extractRunId(undefined)).toBeUndefined()
  })
})

describe('countNumberedOptions', () => {
  test('counts a clean 1-5 numbered list', () => {
    const body = ['1. Do A', '2. Do B', '3. Do C', '4. Do D', '5. Do E'].join('\n')
    expect(countNumberedOptions(body)).toBe(5)
  })

  test('tolerates "Option N:" style and parenthesised numbers', () => {
    const body = ['Option 1: Do A', 'Option 2: Do B', '3) Do C', '4) Do D', '5) Do E'].join('\n')
    expect(countNumberedOptions(body)).toBe(5)
  })

  test('does not count sub-bullets or prose mentioning numbers', () => {
    const body = [
      '1. Do A',
      '   - because of reason 1',
      '2. Do B',
      'We considered 3 other approaches but rejected them.',
    ].join('\n')
    expect(countNumberedOptions(body)).toBe(2)
  })

  test('returns 0 for a body with no numbered list', () => {
    expect(countNumberedOptions('just some prose')).toBe(0)
  })
})

describe('botComments', () => {
  function issueWith(comments: Array<{ body: string; author: { login: string } }>): GhIssue {
    return { number: 1, title: 't', body: '', url: '', state: 'open', comments }
  }

  test('matches "<slug>[bot]" logins only', () => {
    const issue = issueWith([
      { body: 'human reply', author: { login: 'russ' } },
      { body: 'the analysis', author: { login: 'shogo-ai[bot]' } },
    ])
    const result = botComments(issue)
    expect(result).toHaveLength(1)
    expect(result[0].body).toBe('the analysis')
  })

  test('returns empty when no bot has commented', () => {
    const issue = issueWith([{ body: 'hi', author: { login: 'russ' } }])
    expect(botComments(issue)).toHaveLength(0)
  })
})

describe('extractLearnedSection', () => {
  test('extracts the section body between headers', () => {
    const md = [
      '# Title',
      '## Role',
      'Some role text.',
      '## Learned',
      '- lesson one',
      '- lesson two',
      '## Boundaries',
      'more text',
    ].join('\n')
    const learned = extractLearnedSection(md)
    expect(learned).toContain('lesson one')
    expect(learned).toContain('lesson two')
    expect(learned).not.toContain('more text')
  })

  test('returns undefined when there is no Learned section', () => {
    expect(extractLearnedSection('# Title\n## Role\ntext')).toBeUndefined()
  })
})

describe('sectionsChangedOutsideLearned', () => {
  const before = ['## Role', 'Plan implementations.', '## Learned', '(nothing yet)', '## Boundaries', 'Stay in scope.'].join('\n')

  test('reports no changes when only Learned differs', () => {
    const after = ['## Role', 'Plan implementations.', '## Learned', '- watch for missing auth checks', '## Boundaries', 'Stay in scope.'].join('\n')
    expect(sectionsChangedOutsideLearned(before, after)).toEqual([])
  })

  test('flags any other section that changed', () => {
    const after = ['## Role', 'Plan implementations AND deploy them.', '## Learned', '(nothing yet)', '## Boundaries', 'Stay in scope.'].join('\n')
    expect(sectionsChangedOutsideLearned(before, after)).toEqual(['role'])
  })
})
