// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AC1 / AC2 / AC5 from SHO-122, against `SessionManager.compact()` itself.
 *
 * The shape being pinned is the production one: a long session whose most
 * recent turn is a dozen tool rounds. Before this change the split landed
 * inside that turn (only its last ~10 messages survived) and the turn's
 * `toolCall` blocks were summarized away with it.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SessionManager } from '../session-manager'
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

function round(index: number, outputSize = 60): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `call-${index}`, name: index % 3 === 0 ? 'read_file' : 'exec', arguments: { path: `src/file-${index}.ts`, command: `bun test ${index}` } }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'mock',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    } as any,
    {
      role: 'toolResult',
      toolCallId: `call-${index}`,
      toolName: index % 3 === 0 ? 'read_file' : 'exec',
      content: [{ type: 'text', text: `result ${index}: ${'y'.repeat(outputSize)}` }],
      isError: false,
      timestamp: Date.now(),
    } as ToolResultMessage,
  ]
}

/** A 12-round turn: its user message + 24 round messages + a final answer. */
function bigTurn(label: string, rounds = 12): Message[] {
  const msgs: Message[] = [user(`${label}: ship the compaction fix`)]
  for (let i = 0; i < rounds; i++) msgs.push(...round(i))
  msgs.push(assistant(`${label}: done`))
  return msgs
}

const originalFlag = process.env.AGENT_TURN_AWARE_COMPACTION

afterEach(() => {
  if (originalFlag === undefined) delete process.env.AGENT_TURN_AWARE_COMPACTION
  else process.env.AGENT_TURN_AWARE_COMPACTION = originalFlag
})

describe('compact() at a turn boundary', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ keepRecentMessages: 10, estimatedTokensPerMessage: 1 })
    sm.setSummarizeFn(async (msgs) => `summary of ${msgs.length} messages`)
  })

  test('AC2: a 500-message session keeps ≥90% of the previous turn (today: 10 of them)', async () => {
    const session = sm.getOrCreate('big')
    // 500-message shape: ~60 older turns of 8 messages, then the 25-message turn.
    for (let i = 0; i < 60; i++) {
      session.messages.push(user(`older turn ${i}`))
      for (let r = 0; r < 3; r++) session.messages.push(...round(1000 + i * 10 + r))
      session.messages.push(assistant(`older answer ${i}`))
    }
    const previousTurn = bigTurn('the turn')
    session.messages.push(...previousTurn)
    expect(session.messages.length).toBeGreaterThan(400)

    const result = await sm.compact('big')
    expect(result).not.toBeNull()

    const kept = session.messages
    // AC1: the whole previous turn survives — every message, in order.
    expect(kept.length).toBeGreaterThanOrEqual(Math.ceil(previousTurn.length * 0.9))
    expect(kept[0]).toEqual(previousTurn[0])
    const toolCallIds = new Set(
      kept
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => (m as AssistantMessage).content.filter((b) => b?.type === 'toolCall').map((b: any) => b.id)),
    )
    for (const message of previousTurn) {
      if (message.role !== 'toolResult') continue
      expect(toolCallIds.has((message as ToolResultMessage).toolCallId)).toBe(true)
    }
    // Every result still carries its original text — no placeholder.
    for (const message of kept) {
      if (message.role !== 'toolResult') continue
      expect((message as ToolResultMessage).content[0]).toMatchObject({ type: 'text' })
      expect(String((message as ToolResultMessage).content[0].type === 'text' ? (message as ToolResultMessage).content[0].text : '')).not.toContain('cleared')
    }
    // And the older range is summarized, not kept.
    expect(session.compactedSummary).toContain('summary of')
    expect(kept.some((m) => m.role === 'user' && String(m.content).includes('older turn 0'))).toBe(false)
  })

  test('the split never lands inside the previous turn, whatever the message count', async () => {
    const session = sm.getOrCreate('split')
    for (let i = 0; i < 8; i++) {
      session.messages.push(user(`older ${i}`))
      session.messages.push(assistant(`answer ${i}`))
    }
    const previousTurn = bigTurn('turn')
    session.messages.push(...previousTurn)

    await sm.compact('split')
    expect(session.messages.length).toBeGreaterThanOrEqual(previousTurn.length)
    expect(session.messages[session.messages.length - 1]).toEqual(previousTurn[previousTurn.length - 1])
  })

  test('AC5: a single oversized turn is folded, never summarized away', async () => {
    const tight = new SessionManager({
      keepRecentMessages: 10,
      estimatedTokensPerMessage: 1,
      // 2k tokens ⇒ 8k chars of budget; 40% of it is the turn's share.
      contextWindowTokens: 2_000,
      maxOutputTokens: 0,
      bufferTokens: 0,
    })
    tight.setSummarizeFn(async () => 'I did some stuff.')
    const session = tight.getOrCreate('one-turn')
    const turn = bigTurn('the only turn', 20)
    // Blow past the budget: every result is 2k chars, the turn is ~40k.
    const fat: Message[] = turn.map((m) =>
      m.role === 'toolResult'
        ? { ...m, content: [{ type: 'text', text: 'z'.repeat(2_000) }] } as ToolResultMessage
        : m,
    )
    session.messages.push(...fat)

    const result = await tight.compact('one-turn')
    expect(result).not.toBeNull()
    expect(result!.foldedRounds).toBeGreaterThan(10)

    const kept = session.messages
    // The turn is still one turn: its opening message and final answer survive.
    expect(kept[0]).toEqual(fat[0])
    expect(kept[kept.length - 1]).toEqual(fat[fat.length - 1])
    // Dropped rounds are one line each — tool name and args, no output.
    const lines = kept.filter((m) => (m as any).__shogoRoundPlaceholder)
    expect(lines.length).toBeGreaterThan(10)
    expect(String(lines[0].content)).toMatch(/^\[round \d+\/\d+ · (read_file|exec) · [\d,]+ chars cleared · args: \{/)
    // No keep cut: every surviving toolResult still has its toolCall.
    const ids = new Set<string>()
    for (const m of kept) {
      if (m.role !== 'assistant') continue
      for (const b of (m as AssistantMessage).content) if (b?.type === 'toolCall') ids.add((b as any).id)
    }
    for (const m of kept) {
      if (m.role === 'toolResult') expect(ids.has((m as ToolResultMessage).toolCallId)).toBe(true)
    }
    // The whole thing fits well below where it started.
    expect(kept.length).toBeLessThan(fat.length)
  })

  test('the legacy flag still cuts mid-turn (the A/B arm)', async () => {
    process.env.AGENT_TURN_AWARE_COMPACTION = '0'
    const session = sm.getOrCreate('legacy')
    for (let i = 0; i < 10; i++) {
      session.messages.push(user(`older ${i}`))
      session.messages.push(assistant(`answer ${i}`))
    }
    session.messages.push(...bigTurn('turn'))
    const before = session.messages.length
    const result = await sm.compact('legacy')
    expect(result).not.toBeNull()
    // Legacy keeps `keepRecentMessages` (10) + whatever the split walk found.
    expect(session.messages.length).toBeLessThan(before - 10)
  })
})
