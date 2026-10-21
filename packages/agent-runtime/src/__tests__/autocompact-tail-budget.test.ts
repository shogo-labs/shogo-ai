// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-96 — a kept *count* of messages is not a kept *size*.
 *
 * Production proxy logs (7 days to 2026-10-20) show a median request of 129k
 * tokens, 20% over 200k, and single requests up to 837k: the tail is dominated
 * by a few giant tool results, not by many small messages. Keeping 4 (mid-turn)
 * or 10 (turn boundary) messages verbatim therefore does not guarantee the
 * request lands under the cap the compaction exists to enforce.
 */
import { describe, test, expect } from 'bun:test'
import type { Message, UserMessage } from '@mariozechner/pi-ai'
import { MidTurnAutocompactor } from '../midturn-autocompact'
import {
  SessionManager,
  estimateMessageArrayTokens,
  splitIndexForTokenBudget,
} from '../session-manager'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function assistant(text: string): Message {
  return { role: 'assistant', content: text, timestamp: Date.now() } as unknown as Message
}

/** ~`tokens` tokens of tool output (4 chars per token). */
function toolResult(tokens: number, marker: string): Message {
  return {
    role: 'toolResult',
    content: `${marker} ` + 'x'.repeat(Math.max(0, tokens * 4 - marker.length - 1)),
    toolName: 'read_file',
    timestamp: Date.now(),
  } as unknown as Message
}

/** Eight short exchanges, then one enormous tool result at the very end. */
function historyWithGiantTail(tailTokens: number): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < 8; i++) {
    messages.push(user(`step ${i} MARKER_STEP_${i} ` + 'a'.repeat(2_000)))
    messages.push(assistant(`ok ${i}`))
  }
  messages.push(user('read the big file MARKER_TAIL'))
  messages.push(toolResult(tailTokens, 'MARKER_GIANT'))
  messages.push(assistant('read it'))
  return messages
}

describe('splitIndexForTokenBudget', () => {
  test('a tail that already fits keeps the count-based split', () => {
    const messages: Message[] = []
    for (let i = 0; i < 12; i++) messages.push(user(`m${i} ` + 'b'.repeat(400)))

    const byCount = splitIndexForTokenBudget(messages, {
      tailBudgetTokens: 1_000_000,
      minKeepMessages: 2,
      maxKeepMessages: 4,
    })
    // Nothing to fold beyond the requested keep count.
    expect(byCount).toBe(messages.length - 4)
  })

  test('a giant tool result is folded away, not kept verbatim', () => {
    const messages = historyWithGiantTail(120_000)
    const split = splitIndexForTokenBudget(messages, {
      tailBudgetTokens: 10_000,
      minKeepMessages: 2,
      maxKeepMessages: 4,
    })

    expect(split).not.toBeNull()
    const tail = messages.slice(split!)
    expect(estimateMessageArrayTokens(tail)).toBeLessThanOrEqual(10_000)
    // The 120k tool result went into the summary's head, not the tail.
    expect(tail.some((m) => m.role === 'toolResult')).toBe(false)
    expect(split!).toBeGreaterThan(messages.length - 4)
  })

  test('never folds past the minimum kept messages', () => {
    const messages = [user('a ' + 'c'.repeat(40_000)), assistant('b'), user('c ' + 'd'.repeat(40_000))]
    const split = splitIndexForTokenBudget(messages, {
      tailBudgetTokens: 10, // impossible: the last message alone is ~10k
      minKeepMessages: 2,
      maxKeepMessages: 2,
    })

    // Two messages must survive no matter how little budget is left.
    expect(split).toBe(messages.length - 2)
  })

  test('a conversation shorter than the keep count is never compacted', () => {
    const messages = [user('only'), assistant('one')]
    expect(
      splitIndexForTokenBudget(messages, { tailBudgetTokens: 100, minKeepMessages: 2, maxKeepMessages: 4 }),
    ).toBeNull()
  })
})

describe('MidTurnAutocompactor tail budget', () => {
  test('a compaction that keeps a huge tool result lands under the cap', async () => {
    const autoCompactTokens = 100_000
    const tailBudgetTokens = 20_000
    const events: Array<{ tokensBefore: number; tokensAfter: number }> = []
    const compactor = new MidTurnAutocompactor({
      autoCompactTokens,
      keepRecentMessages: 4,
      tailBudgetTokens,
      minKeepMessages: 1,
      promptOverheadTokens: 12_000,
      summarize: async (head, previousSummary) => {
        const markers = head
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .flatMap((t) => [...t.matchAll(/MARKER_[A-Z_]+/g)].map((x) => x[0]))
        return [previousSummary, 'SUMMARY', ...new Set(markers)].filter(Boolean).join(' ')
      },
      apply: () => {},
    })

    // ~150k of history + a 120k tool result: the count-based split (keep 4)
    // would leave the giant result verbatim and stay well over the cap.
    const messages = historyWithGiantTail(120_000)
    const out = await compactor.transform(messages)
    if (out.event) events.push(out.event)

    expect(out.event).not.toBeNull()
    // The request we would have sent is now under the trigger, and the giant
    // tool result survived only inside the summary.
    expect(events[0].tokensAfter).toBeLessThan(autoCompactTokens)
    expect(out.messages.some((m) => m.role === 'toolResult')).toBe(false)
    // Nothing that was folded away was silently dropped.
    expect(out.messages[0].content).toContain('MARKER_GIANT')
  })

  test('the session that produced it is under its own autocompact threshold', async () => {
    const autoCompactTokens = 100_000
    const sm = new SessionManager({ contextWindowTokens: 1_000_000 })
    sm.setSummarizeFn(async (head, previousSummary) => {
      const markers = head
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .flatMap((t) => [...t.matchAll(/MARKER_[A-Z_]+/g)].map((x) => x[0]))
      return [previousSummary, 'SUMMARY', ...new Set(markers)].filter(Boolean).join(' ')
    })
    const sessionId = 'sho-96-tail-budget'
    sm.getOrCreate(sessionId)

    const compactor = new MidTurnAutocompactor({
      autoCompactTokens: 100_000,
      keepRecentMessages: 4,
      tailBudgetTokens: sm.compactionTailBudgetTokens,
      minKeepMessages: 1,
      promptOverheadTokens: 5_000,
      summarize: (head, prev) => sm.summarizeHead(head, prev),
      apply: (summary, splitIndex, replaceSummary) => {
        sm.applyCompaction(sessionId, { summary, splitIndex, replaceSummary: replaceSummary.replaceSummary })
      },
    })

    const session = sm.getOrCreate(sessionId)
    session.messages = historyWithGiantTail(120_000)

    // The session's tail budget follows the 200k cap (40% = 80k), so the
    // post-compaction session is far below what it started at.
    expect(sm.compactionTailBudgetTokens).toBe(80_000)
    const before = sm.estimateTokens(session)
    const out = await compactor.transform(session.messages)

    expect(out.event).not.toBeNull()
    expect(sm.estimateTokens(session)).toBeLessThan(before)
    expect(sm.estimateTokens(session)).toBeLessThan(autoCompactTokens)
  })
})
