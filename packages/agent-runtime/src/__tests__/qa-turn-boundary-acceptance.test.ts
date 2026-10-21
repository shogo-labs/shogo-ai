// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-122 — the composed production path.
 *
 * The card's own specs drive `protectedStart` / `foldTurnMiddle` / `compact()`
 * in isolation. This file enters where the gateway actually does: a session
 * that has run long, a pre-turn `compact()`, and then `buildHistory()` — which
 * is what the next turn's request is built from and which re-runs
 * `pruneToolResults` over the summary prefix + the kept turn. A layer that
 * passes on its own can still flatten the turn here.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SessionManager, applyToolResultBudget, snipConsumedResults } from '../session-manager'
import { microcompact } from '../microcompact'
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai'

const PLACEHOLDER =
  /\[(Tool output processed|Tool result cleared|Earlier .+ result cleared|File content read|[Cc]ontext summarized)/

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

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
    usage: zeroUsage,
    stopReason: 'stop',
    timestamp: Date.now(),
  } as AssistantMessage
}

const toolFor = (i: number) => (i % 3 === 0 ? 'read_file' : i % 3 === 1 ? 'edit_file' : 'exec')

function round(index: number, outputSize = 60): Message[] {
  const name = toolFor(index)
  const args =
    name === 'exec'
      ? { command: `bun test round-${index}` }
      : { path: `src/file-${index}.ts` }
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `call-${index}`, name, arguments: args }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'mock',
      usage: zeroUsage,
      stopReason: 'toolUse',
      timestamp: Date.now(),
    } as unknown as AssistantMessage,
    {
      role: 'toolResult',
      toolCallId: `call-${index}`,
      toolName: name,
      content: [{ type: 'text', text: `result ${index}: ${'y'.repeat(outputSize)}` }],
      isError: false,
      timestamp: Date.now(),
    } as ToolResultMessage,
  ]
}

/** One turn: its user message, `rounds` tool rounds, and a final answer. */
function turn(label: string, rounds = 12, outputSize = 60): Message[] {
  const msgs: Message[] = [user(`${label}: ship the compaction fix`)]
  for (let i = 0; i < rounds; i++) msgs.push(...round(i, outputSize))
  msgs.push(assistant(`${label}: done`))
  return msgs
}

/** 60 older messages: 20 short turns — the part a compaction is meant to fold. */
function olderHistory(): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < 20; i++) {
    msgs.push(user(`older ${i}`), assistant(`did ${i}`), assistant(`did ${i} again`))
  }
  return msgs
}

/** Text of any message, string or block-array content. */
const flat = (msg: Message): string => {
  const content = (msg as any).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'toolCall' ? `toolCall ${c.name}` : ''))
    .join('\n')
}

const textOf = (msg: Message): string => (msg.role === 'toolResult' ? flat(msg) : '')

const toolCallsOf = (messages: readonly Message[]) =>
  messages.flatMap((m) =>
    m.role === 'assistant' && Array.isArray((m as AssistantMessage).content)
      ? (m as AssistantMessage).content.filter((b: any) => b?.type === 'toolCall')
      : [],
  ) as Array<{ name: string; arguments: Record<string, any> }>

const savedFlag = process.env.AGENT_TURN_AWARE_COMPACTION
const savedCap = process.env.AGENT_AUTOCOMPACT_TOKENS

afterEach(() => {
  if (savedFlag === undefined) delete process.env.AGENT_TURN_AWARE_COMPACTION
  else process.env.AGENT_TURN_AWARE_COMPACTION = savedFlag
  if (savedCap === undefined) delete process.env.AGENT_AUTOCOMPACT_TOKENS
  else process.env.AGENT_AUTOCOMPACT_TOKENS = savedCap
})

describe('SHO-122 AC1 — the previous turn survives the boundary, structured', () => {
  let sm: SessionManager

  beforeEach(() => {
    delete process.env.AGENT_TURN_AWARE_COMPACTION
    delete process.env.AGENT_AUTOCOMPACT_TOKENS
    sm = new SessionManager({ keepRecentMessages: 10, estimatedTokensPerMessage: 1 })
    sm.setSummarizeFn(async (msgs) => `summary of ${msgs.length} messages`)
  })

  test('buildHistory after a pre-turn compact keeps every toolCall and every original result', async () => {
    const session = sm.getOrCreate('ac1')
    session.messages = [...olderHistory(), ...turn('current', 12)]
    const turnSize = turn('current', 12).length
    expect(turnSize).toBe(26)

    const result = await sm.compact('ac1')
    expect(result).not.toBeNull()

    const history = sm.buildHistory('ac1')
    // The summary prefix is the first message, as the context-usage breakdown expects.
    expect(history[0].role).toBe('user')
    expect(String((history[0] as UserMessage).content)).toContain('[Previous conversation summary]')

    const calls = toolCallsOf(history)
    const results = history.filter((m) => m.role === 'toolResult') as ToolResultMessage[]

    expect(calls.length).toBe(12, { message: 'every toolCall of the turn is still in the request' })
    expect(calls.map((c) => c.name)).toEqual(Array.from({ length: 12 }, (_, i) => toolFor(i)))
    expect(calls[0].arguments).toEqual({ path: 'src/file-0.ts' })
    expect(calls[2].arguments).toEqual({ command: 'bun test round-2' })

    expect(results.length).toBe(12, { message: 'every tool result is still in the request' })
    for (const [i, r] of results.entries()) {
      const text = textOf(r)
      expect(PLACEHOLDER.test(text)).toBe(false)
      expect(text).toContain(`result ${i}:`)
      expect(text.length).toBeGreaterThan(60)
    }

    const userText = history.map(flat).join('\n')
    expect(userText).toContain('current: ship the compaction fix')
    expect(userText).toContain('current: done')

    const kept = history.length - 2 // minus the summary prefix pair
    expect(kept).toBeGreaterThanOrEqual(Math.ceil(turnSize * 0.9))
  })

  test('the FIRST follow-up turn: a session holding one finished turn keeps it whole', () => {
    // The shape at every pre-turn boundary, before the new prompt is appended:
    // `buildHistory` sees exactly one turn — the previous one. It is the turn
    // the boundary exists to protect, and it is the case the production e2e
    // caught: the request carried `[File content read — 6 lines, 85 chars]`
    // for 4 of turn 1's 6 read_file results.
    const session = sm.getOrCreate('ac1c')
    session.messages = turn('only', 6, 400)

    // The gateway's pre-turn stack, in order (gateway.ts, before layer 4):
    // buildHistory → applyToolResultBudget → microcompact → snipConsumedResults.
    let history = sm.buildHistory('ac1c')
    history = applyToolResultBudget(history, sm.contextBudgetChars)
    history = microcompact(history).messages
    history = snipConsumedResults(history)

    const calls = toolCallsOf(history)
    const results = history.filter((m) => m.role === 'toolResult') as ToolResultMessage[]

    expect(calls.length).toBe(6)
    expect(results.length).toBe(6)
    for (const [i, r] of results.entries()) {
      const text = textOf(r)
      expect(PLACEHOLDER.test(text)).toBe(false)
      expect(text).toContain(`result ${i}:`)
    }
  })

  test('buildHistory is deterministic: the same call twice emits identical bytes', async () => {
    const session = sm.getOrCreate('ac1b')
    session.messages = [...olderHistory(), ...turn('current', 12)]
    await sm.compact('ac1b')
    expect(JSON.stringify(sm.buildHistory('ac1b'))).toBe(JSON.stringify(sm.buildHistory('ac1b')))
  })

  test('AC2 — the 516 -> 12 collapse reproduces on the legacy arm and is gone on this one', async () => {
    const build = (): Message[] => {
      const msgs: Message[] = []
      for (let t = 0; t < 60; t++) {
        msgs.push(user(`turn ${t}`), assistant(`did ${t}`), assistant(`more ${t}`), assistant(`and ${t}`))
      }
      msgs.push(...turn('last', 12))
      return msgs
    }

    const aware = new SessionManager({ keepRecentMessages: 10, estimatedTokensPerMessage: 1 })
    aware.setSummarizeFn(async () => 'summary')
    aware.getOrCreate('aware').messages = build()
    await aware.compact('aware')
    const awareHistory = aware.buildHistory('aware')
    const awareKept = awareHistory.length - 2

    process.env.AGENT_TURN_AWARE_COMPACTION = '0'
    const legacy = new SessionManager({ keepRecentMessages: 10, estimatedTokensPerMessage: 1 })
    legacy.setSummarizeFn(async () => 'summary')
    legacy.getOrCreate('legacy').messages = build()
    await legacy.compact('legacy')
    const legacyHistory = legacy.buildHistory('legacy')
    const legacyCalls = toolCallsOf(legacyHistory)

    // The fix keeps the whole 26-message turn …
    expect(awareKept).toBeGreaterThanOrEqual(24)
    // … the old boundary cut it: 'keepRecentMessages' worth of messages only.
    expect(legacyHistory.length).toBeLessThan(awareKept)
    expect(legacyCalls.length).toBeLessThan(12)
  })
})

describe('SHO-122 AC3 — the persisted summary cannot lie about files or tools', () => {
  test('a stub summarizer saying "I did some stuff." still lists the edited paths and the real tool names', async () => {
    delete process.env.AGENT_TURN_AWARE_COMPACTION
    const sm = new SessionManager({ keepRecentMessages: 10, estimatedTokensPerMessage: 1 })
    sm.setSummarizeFn(async () => 'I did some stuff.')
    const session = sm.getOrCreate('ac3')
    // Tool rounds inside the range that gets summarized away — the facts block
    // describes the compacted range, which is exactly where the files and tool
    // names were lost before.
    session.messages = [...olderHistory(), ...turn('old-work', 6), ...turn('current', 12)]

    await sm.compact('ac3')
    const summary = sm.getOrCreate('ac3').compactedSummary

    expect(summary).toContain('## Files touched')
    expect(summary).toContain('## Tools used')
    expect(summary).toContain('src/file-0.ts` — read') // read_file
    expect(summary).toContain('src/file-4.ts` — edited') // edit_file
    expect(summary).toContain('`read_file`')
    expect(summary).toContain('`edit_file`')
    expect(summary).toContain('`exec`')
    expect(summary).not.toContain('str_replace')
    expect(summary).toContain('<!-- ground truth, generated -->')
  })
})

describe('SHO-122 AC5 — an oversized turn is folded, never summarized away or cut mid-round', () => {
  test('compact() folds the middle of the only turn, keeping its first and last round', async () => {
    delete process.env.AGENT_TURN_AWARE_COMPACTION
    process.env.AGENT_AUTOCOMPACT_TOKENS = '400' // budget 1600 chars, a turn's share = 640
    const sm = new SessionManager({ keepRecentMessages: 10, estimatedTokensPerMessage: 1 })
    sm.setSummarizeFn(async () => 'summary')
    const session = sm.getOrCreate('ac5')
    session.messages = turn('huge', 14, 400)

    const result = await sm.compact('ac5')
    expect(result).not.toBeNull()
    expect(result!.foldedRounds).toBeGreaterThan(0)

    const messages = sm.getOrCreate('ac5').messages
    const text = messages.map(flat).join('\n')

    // One line per dropped round, carrying the tool name and its arguments.
    expect(text).toMatch(/\[round \d+\/14 · (read_file|edit_file|exec) · [\d,]+ chars cleared · args: \{/)
    // The opening message and the final answer survive.
    expect(text).toContain('huge: ship the compaction fix')
    expect(text).toContain('huge: done')
    // Nothing is cut mid-round: every kept toolResult still has its toolCall.
    const callIds = new Set(
      toolCallsOf(messages).map((c: any) => c.id),
    )
    for (const m of messages) {
      if (m.role !== 'toolResult') continue
      expect(callIds.has((m as ToolResultMessage).toolCallId)).toBe(true)
    }
    for (const call of toolCallsOf(messages)) {
      expect(['read_file', 'edit_file', 'exec']).toContain(call.name)
    }
  })
})

describe('SHO-122 AC4 — the layers still compact what is genuinely old', () => {
  test('a big result in an older turn is still flattened (the fix is not a no-op)', () => {
    delete process.env.AGENT_TURN_AWARE_COMPACTION
    const sm = new SessionManager({ keepRecentMessages: 10, estimatedTokensPerMessage: 1 })
    const session = sm.getOrCreate('ac4')
    const old = turn('old', 4, 9000)
    session.messages = [...old, ...turn('a', 3), ...turn('b', 3), ...turn('c', 3)]

    const history = sm.buildHistory('ac4')
    const oldResults = history.slice(0, old.length).filter((m) => m.role === 'toolResult') as ToolResultMessage[]
    expect(oldResults.length).toBeGreaterThan(0)
    expect(oldResults.some((r) => PLACEHOLDER.test(textOf(r)) || /chars trimmed/.test(textOf(r)))).toBe(true)

    // … while the most recent turn is untouched.
    const recent = history.slice(-(turn('c', 3).length))
    for (const m of recent) {
      if (m.role !== 'toolResult') continue
      expect(textOf(m)).toContain('result')
      expect(PLACEHOLDER.test(textOf(m))).toBe(false)
    }
  })
})
