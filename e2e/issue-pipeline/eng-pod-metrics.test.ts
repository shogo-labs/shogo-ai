// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { computeMetrics, formatMetrics, missedTargets, roleOf, type RunMessage } from './eng-pod-metrics'

const T0 = Date.parse('2026-10-01T09:00:00Z')
const at = (min: number) => new Date(T0 + min * 60000).toISOString()

let n = 0
function msg(over: Partial<RunMessage> & { who?: string; min: number }): RunMessage {
  const { who, min, ...rest } = over
  return {
    id: `m${++n}`,
    threadRootId: 'root',
    authorType: who ? 'agent' : 'user',
    authorAgent: who ? { name: `Engineering Team — ${who}` } : null,
    text: 'text',
    blocks: null,
    createdAt: at(min),
    ...rest,
  }
}

const root: RunMessage = { id: 'root', threadRootId: null, authorType: 'user', text: 'Checkout total is wrong', createdAt: at(0) }
const card = (min: number, links: Array<{ label: string; url: string }> = []) =>
  msg({ who: 'Coordinator', min, id: 'card', blocks: { type: 'status_card', messageKind: 'status', card: { links } } })

/** The run the demo is meant to produce. */
function goldenRun(): RunMessage[] {
  return [
    root,
    card(1),
    msg({ who: 'Builder', min: 3, blocks: { messageKind: 'status' }, text: 'Reproducing' }),
    msg({ who: 'Builder', min: 9, blocks: { messageKind: 'result' }, text: 'PR ready: https://github.com/o/r/pull/7 preview https://p.example.dev/preview' }),
    msg({ who: 'Reviewer', min: 11, text: 'PASS — criteria met' }),
    msg({
      who: 'Builder',
      min: 12,
      blocks: { type: 'approval_request', messageKind: 'decision', approval: { status: 'approved', decidedBy: 'user-1' } },
      text: 'Merge?',
    }),
    msg({ who: 'Builder', min: 13, blocks: { messageKind: 'result' }, text: 'Merged' }),
  ]
}

describe('verdict detection', () => {
  test('finds the reviewer verdict after narration and inside bold', () => {
    const run = goldenRun().map((m) =>
      m.text === 'PASS — criteria met'
        ? { ...m, text: "I'll verify this independently. Let me look at the branch.\n\n**Verdict: PASS** — all criteria met" }
        : m,
    )
    expect(computeMetrics({ messages: run, rootId: 'root', prCreatedAt: at(9) }).reviewerRounds).toBe(1)
  })
})

describe('roleOf', () => {
  test('maps agent names to roles', () => {
    expect(roleOf(msg({ who: 'Builder', min: 1 }))).toBe('Builder')
    expect(roleOf(root)).toBeNull()
  })
})

describe('timeline and narration', () => {
  const finished = (min: number, seq: number, extra: Partial<RunMessage> = {}) =>
    msg({ who: 'Builder', min, seq, blocks: { messageKind: 'result', work: { startedAt: T0, completedAt: T0 + min * 60000 } }, text: 'Merged.', ...extra })

  test('a reply listed after the messages that existed when it finished is in order', () => {
    const run = [{ ...root, seq: 1 }, msg({ who: 'Builder', min: 5, seq: 2, blocks: { type: 'approval_request', messageKind: 'decision' } }), finished(8, 3)]
    expect(computeMetrics({ messages: run, rootId: 'root' }).timelineViolations).toBe(0)
  })

  test('a reply listed before an approval card created while it was still working is a violation', () => {
    const run = [
      { ...root, seq: 1 },
      finished(8, 2),
      msg({ who: 'Builder', min: 5, seq: 3, blocks: { type: 'approval_request', messageKind: 'decision' } }),
    ]
    const m = computeMetrics({ messages: run, rootId: 'root' })
    expect(m.timelineViolations).toBe(1)
    expect(missedTargets(m).join()).toContain('listed before')
  })

  test('a reply moved to the end is judged by when it finished, not when it started', () => {
    // The reviewer started at minute 2 (createdAt) but finished last, so it is listed last: in order.
    const run = [
      { ...root, seq: 1 },
      finished(5, 2),
      msg({ who: 'Reviewer', min: 2, seq: 3, blocks: { messageKind: 'result', work: { startedAt: T0, completedAt: T0 + 7 * 60000 } }, text: 'PASS' }),
    ]
    expect(computeMetrics({ messages: run, rootId: 'root' }).timelineViolations).toBe(0)
  })

  test('replies that open like a progress update are counted', () => {
    const run = [root, finished(4, 2, { text: "I'll start by checking the repo." }), finished(8, 3, { text: 'The PR is merged.' })]
    expect(computeMetrics({ messages: run, rootId: 'root' }).narrationLeaked).toBe(1)
  })
})

describe('computeMetrics', () => {
  test('the golden run meets every target', () => {
    const m = computeMetrics({ messages: goldenRun(), rootId: 'root', prCreatedAt: at(8) })
    expect(m.msToPr).toBe(8 * 60000)
    expect(m.msToPreview).toBe(9 * 60000)
    // card + PR-ready result + verdict + approval + merged; the status ping is collapsed
    expect(m.humanReadMessages).toBe(5)
    expect(m.humanInterventions).toBe(1)
    expect(m.wastedAgentTurns).toBe(0)
    expect(m.reviewerRounds).toBe(1)
    expect(missedTargets(m)).toEqual([])
  })

  test('a card edited in place is one message', () => {
    // An edit changes the row, not the count: the API returns the card once
    // however many times the coordinator updates it.
    const edited = { ...card(1), text: 'step 3 of 4' }
    const m = computeMetrics({ messages: [root, edited], rootId: 'root' })
    expect(m.humanReadMessages).toBe(1)
  })

  test('replies from people and undecided approvals', () => {
    const messages = [
      root,
      msg({ min: 2, text: 'also the shipping looks off' }),
      msg({ who: 'Builder', min: 3, blocks: { type: 'approval_request', messageKind: 'decision', approval: { status: 'pending' } } }),
    ]
    const m = computeMetrics({ messages, rootId: 'root' })
    expect(m.humanInterventions).toBe(1)
    expect(missedTargets(m)).toContain('no pull request was opened')
  })

  test('extra responders that answered the untagged post are wasted turns', () => {
    const messages = [
      root,
      msg({ who: 'Builder', min: 0.5, text: 'I can take this' }),
      msg({ who: 'Reviewer', min: 0.6, text: 'Looks like a bug' }),
      msg({ who: 'Coordinator', min: 1, text: 'Triaging' }),
      msg({ who: 'Builder', min: 2, text: 'On it' }),
    ]
    const m = computeMetrics({ messages, rootId: 'root' })
    expect(m.wasted.extraResponders.sort()).toEqual(['Engineering Team — Builder', 'Engineering Team — Reviewer'])
    expect(m.wastedAgentTurns).toBe(2)
  })

  test('paused notices and a third review round are wasted', () => {
    const messages = [
      root,
      card(1),
      msg({ who: 'Reviewer', min: 4, text: 'FAIL 1. missing test' }),
      msg({ who: 'Reviewer', min: 6, text: 'FAIL 1. still missing' }),
      msg({ who: 'Reviewer', min: 8, text: 'PASS' }),
      { id: 'sys', threadRootId: 'root', authorType: 'system', text: 'Paused: too many back-and-forth replies', createdAt: at(9) } as RunMessage,
    ]
    const m = computeMetrics({ messages, rootId: 'root' })
    expect(m.reviewerRounds).toBe(3)
    expect(m.wasted).toMatchObject({ pausedNotices: 1, reviewerRoundsOverLimit: 1 })
    expect(m.wastedAgentTurns).toBe(2)
  })

  test('top-level agent posts after the bug count as messages to read; other threads do not', () => {
    const messages = [
      root,
      msg({ who: 'Coordinator', min: 1, threadRootId: null, text: 'New ticket!' }),
      msg({ who: 'Builder', min: 2, threadRootId: 'other', text: 'unrelated' }),
    ]
    const m = computeMetrics({ messages, rootId: 'root' })
    expect(m.humanReadMessages).toBe(1)
    expect(m.totalMessages).toBe(2)
  })

  test('slow runs and noisy channels miss their targets', () => {
    const messages = [root, ...Array.from({ length: 6 }, (_, i) => msg({ who: 'Builder', min: i + 1, text: `update ${i}` }))]
    const m = computeMetrics({ messages, rootId: 'root', prCreatedAt: at(20) })
    const missed = missedTargets(m)
    expect(missed.some((x) => x.startsWith('PR took 20.0 min'))).toBe(true)
    expect(missed.some((x) => x.includes('6 messages to read'))).toBe(true)
    expect(missed.some((x) => x.includes('0 human interventions'))).toBe(true)
  })

  test('throws when the bug post is missing', () => {
    expect(() => computeMetrics({ messages: [], rootId: 'root' })).toThrow('not found')
  })

  test('formats a readable report', () => {
    const text = formatMetrics(computeMetrics({ messages: goldenRun(), rootId: 'root', prCreatedAt: at(8) }))
    expect(text).toContain('bug post → PR:        8.0 min')
    expect(text).toContain('human interventions:  1')
  })
})
