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

  // Regression: the multi-project L1 eval's real analyst output formats
  // each option as a bold markdown heading with an em dash separator
  // ("**Option 1 — Combine both...**"), not "Option 1:" or "1.". The
  // original pattern required the digit to be immediately followed by
  // `.`/`)`/`:` with no markdown noise beforehand, so it silently matched
  // 0 options on every real (non-hand-written) pipeline comment, hanging
  // l1-multi-project.integration.test.ts's five-options `waitUntil` until
  // its hour-long timeout with no indication why.
  test('tolerates bold markdown headings with an em dash separator (real analyst output)', () => {
    const body = [
      '## Root Cause',
      '',
      '**Option 1 — Combine both boundary strips into one regex (smallest change)**',
      'Merge the existing leading-strip with a trailing-strip into a single alternation.',
      '',
      '---',
      '',
      '**Option 2 — Keep two explicit replace calls**',
      'Retain the existing leading strip and add a symmetric trailing strip.',
      '',
      '---',
      '',
      '**Option 3 — Single anchored regex with both strips in one pass**',
      '',
      '---',
      '',
      '**Option 4 — Lookahead/lookbehind anchored replacement**',
      '',
      '---',
      '',
      '**Option 5 — Extract a `trimHyphens` helper**',
    ].join('\n')
    expect(countNumberedOptions(body)).toBe(5)
  })

  // Regression: intake's real "post the options" comment includes a section
  // heading like "## 5 options — please pick one" above the list. The old
  // pattern happily matched this too (digit "5" + optional decoration +
  // whitespace + non-space), turning a genuine 5-option comment into a count
  // of 6 — which never satisfies a `waitUntil` for "exactly 5", so it hangs
  // for the full timeout (found live running the L1 multi-project eval).
  test('does not count a "## N options — ..." section heading as an option', () => {
    const body = [
      '## 5 options — please pick one',
      '',
      '**Option 1 — Add a symmetric trailing-strip step** ⭐ _Recommended_',
      'One-liner, zero risk.',
      '',
      '**Option 2 — Merge both guards into one combined replace**',
      'Single call, identical semantics.',
      '',
      '**Option 3 — Prevent the tail hyphen at generation time**',
      'Harder to read.',
      '',
      '**Option 4 — Rewrite using split/filter/join**',
      'Structural rewrite.',
      '',
      '**Option 5 — Delegate to an established `slugify` npm library**',
      'Adds a dependency.',
    ].join('\n')
    expect(countNumberedOptions(body)).toBe(5)
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
