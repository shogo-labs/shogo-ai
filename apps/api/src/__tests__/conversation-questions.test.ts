// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pure parts of question cards: cleaning up what an agent or the model
 * proposes, the free text check that decides whether the model runs at all,
 * reading the model's reply, and folding a mention written twice.
 */

import { describe, expect, test } from 'bun:test'
import {
  normalizeQuestionDrafts,
  publicBlocks,
  questionOptions,
  questionsToMarkdown,
  secretNameFrom,
  type QuestionBlock,
} from '../services/conversation-message-kind'
import { looksLikeAsk, parseDesign } from '../services/conversation-question-designer'
import { collapseRepeatedMentions } from '../services/conversation-mentions'
import { parseQuestionActionValue, promptKey, questionActionValue, questionActions } from '../services/conversation-questions'
import { STAGING_FIXTURES } from './fixtures/staging-agent-asks'

const block = (over: Partial<QuestionBlock> = {}): QuestionBlock => ({
  id: 'q_1',
  to: { userIds: ['u1'], via: 'mention' },
  header: 'Alert destination',
  prompt: 'Where should alerts go?',
  interaction: 'choice',
  options: [{ label: 'Slack' }, { label: 'PagerDuty' }],
  status: 'open',
  source: 'agent',
  ...over,
})

describe('normalizeQuestionDrafts', () => {
  test('keeps a well-formed choice question', () => {
    const [q] = normalizeQuestionDrafts([{ header: 'Region', prompt: 'Which region?', interaction: 'choice', options: [{ label: 'us-east' }, { label: 'eu-west', description: 'Frankfurt' }] }])
    expect(q).toMatchObject({ header: 'Region', prompt: 'Which region?', interaction: 'choice' })
    expect(q!.options).toEqual([{ label: 'us-east' }, { label: 'eu-west', description: 'Frankfurt' }])
  })

  test('a choice with fewer than two options becomes a text question', () => {
    const [q] = normalizeQuestionDrafts([{ header: 'Region', prompt: 'Which region?', interaction: 'choice', options: [{ label: 'us-east' }] }])
    expect(q!.interaction).toBe('text')
    expect(q!.options).toBeUndefined()
  })

  test('caps the count, the header and the options', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ header: `Q${i} ${'x'.repeat(60)}`, prompt: `Question ${i}?`, interaction: 'choice', options: Array.from({ length: 9 }, (_, j) => ({ label: `opt ${j}` })) }))
    const out = normalizeQuestionDrafts(many)
    expect(out).toHaveLength(4)
    expect(out[0]!.header.length).toBeLessThanOrEqual(40)
    expect(out[0]!.options!.length).toBeLessThanOrEqual(6)
  })

  test('drops entries without a prompt and unknown interactions fall back to text', () => {
    const out = normalizeQuestionDrafts([{ header: 'Empty' }, { header: 'Odd', prompt: 'Odd one?', interaction: 'slider' }, 'nonsense', null])
    expect(out).toHaveLength(1)
    expect(out[0]!.interaction).toBe('text')
  })

  test('a secret needs a usable name; one is derived from the header when missing', () => {
    const [named] = normalizeQuestionDrafts([{ header: 'Key', prompt: 'Paste the key?', interaction: 'secret', secretName: 'ensembledata api token' }])
    expect(named!.secretName).toBe('ENSEMBLEDATA_API_TOKEN')
    expect(secretNameFrom('  ')).toBeNull()
  })

  test('not an array is nothing', () => {
    expect(normalizeQuestionDrafts(undefined)).toEqual([])
    expect(normalizeQuestionDrafts({ prompt: 'x?' })).toEqual([])
  })
})

describe('question options and markdown', () => {
  test('confirm questions get Approve / Not yet / Discuss', () => {
    expect(questionOptions({ interaction: 'confirm' }).map((o) => o.label)).toEqual(['Approve', 'Not yet', 'Discuss'])
    expect(questionOptions({ interaction: 'text' })).toEqual([])
  })

  test('markdown names who is asked and shows answers', () => {
    const md = questionsToMarkdown([
      block(),
      block({ id: 'q_2', header: 'Budget', prompt: 'Monthly ceiling?', interaction: 'text', options: undefined, status: 'answered', answer: { text: '$500', by: { userId: 'u1', name: 'Russell' }, at: new Date().toISOString() } }),
    ], { users: new Map([['u1', 'Russell']]) })
    expect(md).toContain('Alert destination')
    expect(md).toContain('Slack')
    expect(md).toContain('Russell')
    expect(md).toContain('$500')
  })

  test('the stored secret never leaves the server', () => {
    const out = publicBlocks({ messageKind: 'decision', questions: [block({ interaction: 'secret', secretName: 'K', secretCipher: 'v1:abc' })] }) as any
    expect(out.questions[0].secretCipher).toBeUndefined()
    expect(out.questions[0].secretName).toBe('K')
  })
})

describe('looksLikeAsk', () => {
  for (const fixture of STAGING_FIXTURES) {
    test(`${fixture.gate ? 'passes' : 'skips'}: ${fixture.name}`, () => {
      expect(looksLikeAsk(fixture.text.replaceAll('{me}', '<@u:abc>'))).toBe(fixture.gate)
    })
  }

  test('ask phrases count without a question mark', () => {
    expect(looksLikeAsk('Please confirm the cutover window for Friday.')).toBe(true)
    expect(looksLikeAsk('I need your sign-off before merging.')).toBe(true)
  })

  test('a mention token alone is not a question', () => {
    expect(looksLikeAsk('<@u:abc>')).toBe(false)
  })
})

describe('parseDesign', () => {
  const open = new Set(['q_open'])

  test('reads JSON wrapped in prose or a fence', () => {
    const raw = 'Here you go:\n```json\n{"questions":[{"header":"Proceed","prompt":"Ship it?","interaction":"confirm","sameAs":"q_open"}],"moot":[]}\n```'
    const design = parseDesign(raw, open)
    expect(design!.questions).toHaveLength(1)
    expect(design!.questions[0]!.interaction).toBe('confirm')
    expect(design!.sameAs).toEqual(['q_open'])
  })

  test('ignores ids it was not given', () => {
    const design = parseDesign('{"questions":[{"header":"A","prompt":"A?","interaction":"text","sameAs":"q_made_up"}],"moot":["q_open","q_other"]}', open)
    expect(design!.sameAs).toEqual([null])
    expect(design!.moot).toEqual(['q_open'])
  })

  test('drops invalid questions but keeps sameAs aligned', () => {
    const design = parseDesign('{"questions":[{"header":"Bad"},{"header":"Good","prompt":"Good?","interaction":"text","sameAs":"q_open"}]}', open)
    expect(design!.questions.map((q) => q.header)).toEqual(['Good'])
    expect(design!.sameAs).toEqual(['q_open'])
  })

  test('null when the reply is not JSON', () => {
    expect(parseDesign('no questions here', open)).toBeNull()
    expect(parseDesign('{not json}', open)).toBeNull()
  })
})

describe('collapseRepeatedMentions', () => {
  test('folds a token repeated in parentheses', () => {
    expect(collapseRepeatedMentions('<@u:abc> (<@u:abc>) can you check?')).toBe('<@u:abc> can you check?')
  })

  test('folds the same person written by name', () => {
    const lookup = new Map([['russell', '<@u:abc>']])
    expect(collapseRepeatedMentions('<@u:abc> (Russell) can you check?', lookup)).toBe('<@u:abc> can you check?')
    expect(collapseRepeatedMentions('<@u:abc> (@russell) ok', lookup)).toBe('<@u:abc> ok')
  })

  test('leaves different people and plain parentheses alone', () => {
    const lookup = new Map([['dana', '<@u:def>']])
    expect(collapseRepeatedMentions('<@u:abc> (<@u:def>)')).toBe('<@u:abc> (<@u:def>)')
    expect(collapseRepeatedMentions('<@u:abc> (Dana)', lookup)).toBe('<@u:abc> (Dana)')
    expect(collapseRepeatedMentions('<@u:abc> (for the release)', lookup)).toBe('<@u:abc> (for the release)')
  })
})

describe('question buttons on chat platforms', () => {
  test('values round-trip', () => {
    const value = questionActionValue('msg_1', 'q_2', 3)
    expect(parseQuestionActionValue(value)).toEqual({ messageId: 'msg_1', questionId: 'q_2', index: 3 })
    expect(parseQuestionActionValue('approve|x')).toBeNull()
  })

  test('buttons for the first open single-select question only', () => {
    const actions = questionActions('msg_1', [
      block({ id: 'q_a', interaction: 'text', options: undefined }),
      block({ id: 'q_b', interaction: 'confirm', options: undefined }),
      block({ id: 'q_c' }),
    ])
    expect(actions.map((a) => a.label)).toEqual(['Approve', 'Not yet', 'Discuss'])
    expect(actions.every((a) => a.kind === 'question')).toBe(true)
    expect(parseQuestionActionValue(actions[1]!.value)!.questionId).toBe('q_b')
    expect(questionActions('msg_1', [block({ multiSelect: true })])).toEqual([])
  })

  test('the same question in other words keys the same', () => {
    expect(promptKey('Where should alerts go?')).toBe(promptKey('  where should ALERTS go ? '))
  })
})
