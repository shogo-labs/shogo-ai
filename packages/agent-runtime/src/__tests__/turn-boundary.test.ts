// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, afterEach } from 'bun:test'
import {
  assistantWindowStart,
  compactToolArgs,
  foldTurnMiddle,
  isFlattenedResult,
  lastTurnStart,
  nthTurnStart,
  protectedStart,
  summariseTurn,
  turnCount,
  turnInProgress,
} from '../turn-boundary'
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function toolRound(toolName: string, id: string, output: string, args: Record<string, any> = {}): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: toolName, arguments: args }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'mock',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    } as any,
    {
      role: 'toolResult',
      toolCallId: id,
      toolName,
      content: [{ type: 'text', text: output }],
      isError: false,
      timestamp: Date.now(),
    } as ToolResultMessage,
  ]
}

/** One turn with `rounds` tool rounds (2 messages each) closed by a final answer. */
function turn(text: string, rounds: number, outputSize = 40): Message[] {
  const msgs: Message[] = [user(text)]
  for (let i = 0; i < rounds; i++) msgs.push(...toolRound('exec', `${text}-r${i}`, `out ${i} ${'x'.repeat(outputSize)}`))
  msgs.push(assistant(`done: ${text}`))
  return msgs
}

const originalFlag = process.env.AGENT_TURN_AWARE_COMPACTION

afterEach(() => {
  if (originalFlag === undefined) delete process.env.AGENT_TURN_AWARE_COMPACTION
  else process.env.AGENT_TURN_AWARE_COMPACTION = originalFlag
})

describe('lastTurnStart', () => {
  test('finds the user message that opened the most recent turn', () => {
    const msgs = [...turn('a', 1), ...turn('b', 3), ...turn('c', 2)]
    expect(lastTurnStart(msgs)).toBe(msgs.length - 6)
    expect(msgs[lastTurnStart(msgs)].role).toBe('user')
  })

  test('is 0 for an empty history and for a single turn', () => {
    expect(lastTurnStart([])).toBe(0)
    expect(lastTurnStart(turn('only', 4))).toBe(0)
  })

  test('a tool-result-first history still resolves to 0', () => {
    const msgs: Message[] = [
      { role: 'toolResult', toolCallId: 'x', toolName: 'exec', content: [{ type: 'text', text: 'orphan' }], isError: false, timestamp: 0 } as ToolResultMessage,
    ]
    expect(lastTurnStart(msgs)).toBe(0)
  })

  test('a steered background note is not a turn start', () => {
    const before = [...turn('a', 1), ...turn('b', 2)]
    const expected = lastTurnStart(before)
    const msgs = [...before]
    msgs.push({ role: 'user', content: 'background note', timestamp: 0, __shogoBackgroundNote: true } as any)
    expect(lastTurnStart(msgs)).toBe(expected)
  })

  test('counts and nth-from-last agree with the walk', () => {
    const msgs = [...turn('a', 1), ...turn('b', 1), ...turn('c', 1)]
    expect(turnCount(msgs)).toBe(3)
    expect(nthTurnStart(msgs, 1)).toBe(lastTurnStart(msgs))
    expect(msgs[nthTurnStart(msgs, 2)].role).toBe('user')
    expect(nthTurnStart(msgs, 3)).toBe(0)
  })
})

describe('summariseTurn', () => {
  test('counts rounds, tool calls, names, placeholders and chars for the turn only', () => {
    const older = turn('older', 2, 500)
    const current: Message[] = [user('ship the thing')]
    current.push(...toolRound('read_file', 'r1', 'file body', { path: 'src/a.ts' }))
    current.push(...toolRound('exec', 'r2', '[Tool output processed — 900 chars, see assistant response]'))
    current.push(assistant('done'))

    const summary = summariseTurn([...older, ...current], older.length)
    expect(summary.messages).toBe(current.length)
    expect(summary.rounds).toBe(2)
    expect(summary.toolCalls).toBe(2)
    expect(summary.toolNames).toEqual(['read_file', 'exec'])
    expect(summary.placeholders).toBe(1)
    expect(summary.chars).toBeGreaterThan(0)
  })

  test('a turn with no tool calls is one round-less turn', () => {
    const summary = summariseTurn(turn('hello', 0), 0)
    expect(summary.rounds).toBe(0)
    expect(summary.toolCalls).toBe(0)
    expect(summary.toolNames).toEqual([])
    expect(summary.placeholders).toBe(0)
  })

  test('an empty history summarises to zeroes', () => {
    expect(summariseTurn([], 0)).toEqual({ messages: 0, rounds: 0, toolCalls: 0, toolNames: [], placeholders: 0, chars: 0 })
  })

  test('isFlattenedResult recognises every placeholder this repo writes', () => {
    const kinds = [
      '[Tool output processed — 12 chars, see assistant response]',
      '[Tool result cleared — 12 chars]',
      '[Earlier exec result cleared to keep the context small (12 chars). Re-run the tool if you need this output again.]',
      '[File content read — 12 lines, 900 chars]',
      '[round 3/14 · exec · 2,431 chars cleared · args: {}]',
    ]
    for (const kind of kinds) {
      expect(isFlattenedResult({ role: 'toolResult', toolCallId: 'x', toolName: 'exec', content: [{ type: 'text', text: kind }], isError: false, timestamp: 0 } as ToolResultMessage)).toBe(true)
    }
    expect(isFlattenedResult({ role: 'toolResult', toolCallId: 'x', toolName: 'exec', content: [{ type: 'text', text: 'real output' }], isError: false, timestamp: 0 } as ToolResultMessage)).toBe(false)
  })
})

describe('protectedStart', () => {
  test('the finished previous turn is protected whole, however many rounds it had', () => {
    // 12 tool rounds = 25 messages, closed by a final answer.
    const previous = turn('big turn', 12)
    const older = turn('before that', 2)
    const history = [...older, ...previous]

    const start = protectedStart(history, 3)
    expect(start).toBe(older.length)
    expect(history.length - start).toBe(previous.length)
    // The legacy three-assistant-message window would have started inside the turn.
    expect(assistantWindowStart(history, 3)).toBeGreaterThan(start)
  })

  test('while a turn is running, the previous turn is still protected', () => {
    const older = turn('older', 2)
    const previous = turn('previous', 4)
    const inProgress = [...older, ...previous, user('new prompt')]
    expect(protectedStart(inProgress, 3)).toBe(older.length)
  })

  test('a 25-message turn after 60 older messages keeps every message of the turn', () => {
    const older: Message[] = []
    for (let i = 0; i < 15; i++) older.push(...turn(`old ${i}`, 1))
    const previous = turn('the turn', 12)
    const history = [...older, ...previous]
    expect(history.length).toBeGreaterThan(60)

    const start = protectedStart(history, 4)
    expect(start).toBe(older.length)
    expect(history.slice(start)).toEqual(previous)
  })

  test('a single in-progress turn keeps the sliding window (a runaway turn stays bounded)', () => {
    const msgs: Message[] = [user('one long turn')]
    for (let i = 0; i < 10; i++) msgs.push(...toolRound('exec', `t${i}`, 'x'.repeat(50)))
    expect(turnInProgress(msgs)).toBe(true)
    expect(protectedStart(msgs, 3)).toBe(assistantWindowStart(msgs, 3))
  })

  test('never moves backwards when a message is appended (write-once invariant)', () => {
    const history = [...turn('a', 6), ...turn('b', 6)]
    let previous = protectedStart(history, 3)
    const live = [...history]
    for (let i = 0; i < 8; i++) {
      live.push(...toolRound('exec', `n${i}`, 'x'.repeat(10)))
      const now = protectedStart(live, 3)
      expect(now).toBeLessThanOrEqual(previous)
      previous = now
    }
  })

  test('the legacy flag restores the assistant-count boundary', () => {
    const history = [...turn('a', 2), ...turn('b', 8)]
    process.env.AGENT_TURN_AWARE_COMPACTION = '0'
    expect(protectedStart(history, 3)).toBe(assistantWindowStart(history, 3))
    delete process.env.AGENT_TURN_AWARE_COMPACTION
    expect(protectedStart(history, 3)).toBeLessThan(assistantWindowStart(history, 3))
  })
})

describe('foldTurnMiddle', () => {
  test('keeps the opening message, first round, last rounds and final answer', () => {
    const msgs = turn('oversized', 8, 2_000)
    const folded = foldTurnMiddle(msgs, 0, { maxChars: 6_000, keepRounds: 2 })

    // 8 rounds at 2k chars each is 16k > 6k, so `keepRounds` shrinks to 1:
    // the first round and the last one survive, six become one line each.
    expect(folded.foldedRounds).toBe(6)
    expect(folded.messages[0]).toEqual(msgs[0])
    // First round survives verbatim.
    expect((folded.messages[1] as any).content[0].type).toBe('toolCall')
    expect((folded.messages[2] as ToolResultMessage).content[0].text).toBe((msgs[2] as ToolResultMessage).content[0].text)
    // Dropped rounds become one line each, with the real tool name and args.
    const placeholders = folded.messages.filter((m) => (m as any).__shogoRoundPlaceholder)
    expect(placeholders.length).toBe(6)
    expect(String(placeholders[0].content)).toContain('[round 2/8 · exec ·')
    // Final answer survives.
    expect(folded.messages[folded.messages.length - 1]).toEqual(msgs[msgs.length - 1])
    // And the fold actually shrank the turn.
    const before = msgs.reduce((sum, m) => sum + String((m as any).content[0]?.text ?? '').length, 0)
    const after = folded.messages.reduce((sum, m) => sum + String((m as any).content[0]?.text ?? '').length, 0)
    expect(after).toBeLessThan(before)
  })

  test('drops more rounds until the turn fits the budget', () => {
    const msgs = turn('oversized', 8, 2_000)
    const folded = foldTurnMiddle(msgs, 0, { maxChars: 500, keepRounds: 2 })
    expect(folded.foldedRounds).toBeGreaterThanOrEqual(5)
    const kept = folded.messages.filter((m) => !(m as any).__shogoRoundPlaceholder)
    // Opening message, its first round (2 messages) and the final answer.
    expect(kept.length).toBe(4)
  })

  test('does not cut mid-round: every kept toolResult still has its toolCall', () => {
    const msgs = turn('oversized', 6, 1_000)
    const folded = foldTurnMiddle(msgs, 0, { maxChars: 2_000 })
    const calls = new Set<string>()
    for (const msg of folded.messages) {
      if (msg.role !== 'assistant') continue
      for (const block of (msg as AssistantMessage).content) {
        if (block?.type === 'toolCall') calls.add((block as any).id)
      }
    }
    for (const msg of folded.messages) {
      if (msg.role !== 'toolResult') continue
      expect(calls.has((msg as ToolResultMessage).toolCallId)).toBe(true)
    }
  })

  test('a single-round turn is not folded', () => {
    const msgs = turn('small', 1, 10)
    expect(foldTurnMiddle(msgs, 0, { maxChars: 1 }).foldedRounds).toBe(0)
  })

  test('compactToolArgs puts the identity keys first and caps the length', () => {
    expect(compactToolArgs({ other: 1, command: 'bun test' })).toBe('{"command":"bun test","other":1}')
    expect(compactToolArgs({ path: 'a.ts', body: 'x'.repeat(500) }, 60).length).toBeLessThanOrEqual(60)
    expect(compactToolArgs(undefined)).toBe('{}')
  })
})
