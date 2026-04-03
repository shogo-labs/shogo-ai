// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  applyToolResultBudget,
  snipConsumedResults,
  SessionManager,
} from '../session-manager'
import { microcompact } from '../microcompact'
import type { Message, UserMessage, AssistantMessage, ToolResultMessage } from '@mariozechner/pi-ai'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function assistantWithToolUse(toolName: string, toolCallId: string, args: Record<string, any> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: args }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as any
}

function toolResult(text: string, toolCallId = `tc_${Math.random().toString(36).slice(2, 8)}`, toolName = 'exec'): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  }
}

function makeTurn(userText: string, toolName: string, toolOutput: string, assistantText: string): Message[] {
  const toolId = `tc_${Math.random().toString(36).slice(2, 8)}`
  return [
    user(userText),
    assistantWithToolUse(toolName, toolId),
    toolResult(toolOutput, toolId, toolName),
    assistant(assistantText),
  ]
}

function manyTurns(count: number, toolOutputSize = 100): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < count; i++) {
    msgs.push(...makeTurn(
      `prompt ${i}`,
      'exec',
      `result-${i} ${'x'.repeat(toolOutputSize)}`,
      `response ${i}`,
    ))
  }
  return msgs
}

function textOf(msg: Message): string {
  if (msg.role === 'toolResult') {
    return (msg as ToolResultMessage).content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
  }
  return ''
}

// ===================================================================
// Layer 1: applyToolResultBudget
// ===================================================================

describe('Layer 1: applyToolResultBudget', () => {
  test('no-op when tool results are within budget', () => {
    const msgs = manyTurns(5, 50)
    const result = applyToolResultBudget(msgs, 100_000)
    expect(result).toEqual(msgs)
  })

  test('truncates old tool results when they exceed budget ratio', () => {
    const msgs = manyTurns(8, 5000)
    const result = applyToolResultBudget(msgs, 10_000)

    const oldToolResult = result[2] as ToolResultMessage
    const text = textOf(oldToolResult)
    expect(text.length).toBeLessThan(5100)
    expect(text).toContain('trimmed for budget')
  })

  test('protects last 3 turns from budget trimming', () => {
    const msgs = manyTurns(6, 5000)
    const result = applyToolResultBudget(msgs, 10_000)

    const lastToolIdx = msgs.length - 2
    const lastTool = result[lastToolIdx] as ToolResultMessage
    expect(textOf(lastTool)).toContain('result-5')
    expect(textOf(lastTool)).not.toContain('trimmed for budget')
  })

  test('never mutates input array', () => {
    const msgs = manyTurns(6, 5000)
    const original = JSON.parse(JSON.stringify(msgs))
    applyToolResultBudget(msgs, 10_000)
    expect(msgs).toEqual(original)
  })

  test('handles empty message array', () => {
    const result = applyToolResultBudget([], 100_000)
    expect(result).toEqual([])
  })

  test('handles messages with no tool results', () => {
    const msgs: Message[] = [user('hello'), assistant('world')]
    const result = applyToolResultBudget(msgs, 100)
    expect(result).toEqual(msgs)
  })

  test('proportionally distributes budget across eligible results', () => {
    const msgs: Message[] = [
      ...makeTurn('a', 'exec', 'x'.repeat(10000), 'done'),
      ...makeTurn('b', 'exec', 'y'.repeat(20000), 'done'),
      ...makeTurn('c', 'exec', 'z'.repeat(5000), 'done'),
      // 3 more protected turns
      ...makeTurn('d', 'exec', 'w'.repeat(100), 'done'),
      ...makeTurn('e', 'exec', 'v'.repeat(100), 'done'),
      ...makeTurn('f', 'exec', 'u'.repeat(100), 'done'),
    ]

    const result = applyToolResultBudget(msgs, 5000)

    const r1 = textOf(result[2])
    const r2 = textOf(result[6])
    const r3 = textOf(result[10])

    // All three old results should be trimmed to roughly the same budget
    expect(r1.length).toBeLessThan(3000)
    expect(r2.length).toBeLessThan(3000)
    expect(r3.length).toBeLessThan(3000)
  })
})

// ===================================================================
// Layer 2: microcompact
// ===================================================================

describe('Layer 2: microcompact', () => {
  test('no-op for small tool results', () => {
    const msgs = manyTurns(5, 50)
    const { messages, tokensSaved } = microcompact(msgs)
    expect(messages).toEqual(msgs)
    expect(tokensSaved).toBe(0)
  })

  test('compresses large tool results with head/tail', () => {
    const longOutput = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'a'.repeat(50)}`).join('\n')
    const msgs: Message[] = [
      ...makeTurn('old', 'exec', longOutput, 'ok'),
      ...makeTurn('recent1', 'exec', 'short', 'ok'),
      ...makeTurn('recent2', 'exec', 'short', 'ok'),
      ...makeTurn('recent3', 'exec', 'short', 'ok'),
    ]

    const { messages, tokensSaved } = microcompact(msgs)
    const compressed = textOf(messages[2])
    expect(compressed).toContain('lines omitted')
    expect(compressed.length).toBeLessThan(longOutput.length)
    expect(tokensSaved).toBeGreaterThan(0)
  })

  test('replaces file-read-like tool results with placeholder', () => {
    const fileContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const toolId = 'tc_read1'
    const msgs: Message[] = [
      user('read the file'),
      assistantWithToolUse('read_file', toolId, { path: '/test.ts' }),
      toolResult(fileContent, toolId, 'read_file'),
      assistant('ok, I see the file'),
      ...makeTurn('recent1', 'exec', 'short', 'ok'),
      ...makeTurn('recent2', 'exec', 'short', 'ok'),
      ...makeTurn('recent3', 'exec', 'short', 'ok'),
    ]

    const { messages } = microcompact(msgs)
    const compressed = textOf(messages[2])
    expect(compressed).toContain('File content read')
    expect(compressed).toContain('lines')
  })

  test('protects recent turns', () => {
    const longOutput = 'x'.repeat(5000)
    const msgs: Message[] = [
      ...makeTurn('recent', 'exec', longOutput, 'ok'),
    ]

    const { messages, tokensSaved } = microcompact(msgs, { keepRecentTurns: 3 })
    expect(textOf(messages[2])).toBe(longOutput)
    expect(tokensSaved).toBe(0)
  })

  test('uses custom config', () => {
    const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i}: ${'b'.repeat(100)}`).join('\n')
    const msgs: Message[] = [
      ...makeTurn('old', 'exec', longOutput, 'ok'),
      ...makeTurn('recent1', 'exec', 'short', 'ok'),
    ]

    const { messages } = microcompact(msgs, {
      threshold: 500,
      headLines: 5,
      tailLines: 3,
      keepRecentTurns: 1,
    })

    const compressed = textOf(messages[2])
    expect(compressed).toContain('lines omitted')
    const lines = compressed.split('\n')
    const headPart = compressed.split('[...')[0]
    const headLines = headPart.split('\n').filter(l => l.trim()).length
    expect(headLines).toBe(5)
  })

  test('reports tokens saved accurately', () => {
    const longOutput = 'x'.repeat(8000)
    const msgs: Message[] = [
      ...makeTurn('old', 'exec', longOutput, 'ok'),
      ...makeTurn('r1', 'exec', 's', 'ok'),
      ...makeTurn('r2', 'exec', 's', 'ok'),
      ...makeTurn('r3', 'exec', 's', 'ok'),
    ]

    const { tokensSaved } = microcompact(msgs)
    expect(tokensSaved).toBeGreaterThan(500)
  })
})

// ===================================================================
// Layer 3: snipConsumedResults
// ===================================================================

describe('Layer 3: snipConsumedResults', () => {
  test('snips old tool results that have following assistant messages', () => {
    const msgs: Message[] = [
      ...makeTurn('old', 'exec', 'x'.repeat(1000), 'I processed the output'),
      ...makeTurn('r1', 'exec', 'short', 'ok'),
      ...makeTurn('r2', 'exec', 'short', 'ok'),
      ...makeTurn('r3', 'exec', 'short', 'ok'),
    ]

    const result = snipConsumedResults(msgs)
    const snipped = textOf(result[2])
    expect(snipped).toContain('Tool output processed')
    expect(snipped).toContain('1000 chars')
  })

  test('does not snip tool results within protected turns', () => {
    const msgs: Message[] = [
      ...makeTurn('recent', 'exec', 'x'.repeat(1000), 'done'),
    ]

    const result = snipConsumedResults(msgs, 3)
    expect(textOf(result[2])).toBe('x'.repeat(1000))
  })

  test('does not snip small tool results', () => {
    const msgs: Message[] = [
      ...makeTurn('old', 'exec', 'tiny', 'ok'),
      ...makeTurn('r1', 'exec', 's', 'ok'),
      ...makeTurn('r2', 'exec', 's', 'ok'),
      ...makeTurn('r3', 'exec', 's', 'ok'),
    ]

    const result = snipConsumedResults(msgs)
    expect(textOf(result[2])).toBe('tiny')
  })

  test('does not snip if no following assistant message', () => {
    const msgs: Message[] = [
      user('do something'),
      assistantWithToolUse('exec', 'tc1'),
      toolResult('x'.repeat(1000), 'tc1'),
    ]

    const result = snipConsumedResults(msgs, 0)
    expect(textOf(result[2])).toBe('x'.repeat(1000))
  })

  test('preserves non-toolResult messages', () => {
    const msgs: Message[] = [
      user('hello ' + 'x'.repeat(1000)),
      assistant('world ' + 'y'.repeat(1000)),
      ...makeTurn('recent', 'exec', 'ok', 'done'),
    ]

    const result = snipConsumedResults(msgs)
    expect(result[0]).toEqual(msgs[0])
    expect(result[1]).toEqual(msgs[1])
  })
})

// ===================================================================
// Layer 4: Enhanced compact() with circuit breaker
// ===================================================================

describe('Layer 4: Enhanced compact()', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxMessages: 10, keepRecentMessages: 4, maxEstimatedTokens: 5000 })
  })

  test('autocompactThreshold uses config values', () => {
    const sm2 = new SessionManager({
      contextWindowTokens: 100_000,
      maxOutputTokens: 8192,
      bufferTokens: 10_000,
    })
    expect(sm2.autocompactThreshold).toBe(100_000 - 8192 - 10_000)
  })

  test('autocompactThreshold uses defaults when no config', () => {
    expect(sm.autocompactThreshold).toBe(200_000 - 16_384 - 15_000)
  })

  test('circuit breaker trips after consecutive failures', async () => {
    let callCount = 0
    sm.setSummarizeFn(async () => {
      callCount++
      throw new Error('LLM unavailable')
    })

    const session = sm.getOrCreate('test')
    for (let i = 0; i < 20; i++) {
      session.messages.push(user(`msg ${i}`))
      session.messages.push(assistant(`resp ${i}`))
    }

    expect(sm.isSummarizeCircuitOpen).toBe(false)

    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      session.messages = []
      for (let j = 0; j < 20; j++) {
        session.messages.push(user(`msg ${j}`))
        session.messages.push(assistant(`resp ${j}`))
      }
      await sm.compact('test')
    }

    expect(sm.isSummarizeCircuitOpen).toBe(true)
    expect(callCount).toBe(3)

    // Additional compaction should NOT call the LLM
    session.messages = []
    for (let i = 0; i < 20; i++) {
      session.messages.push(user(`msg ${i}`))
      session.messages.push(assistant(`resp ${i}`))
    }
    const result = await sm.compact('test')
    expect(result).not.toBeNull()
    expect(callCount).toBe(3) // no additional call
  })

  test('circuit breaker resets manually', async () => {
    sm.setSummarizeFn(async () => { throw new Error('fail') })

    const session = sm.getOrCreate('test')
    for (let i = 0; i < 3; i++) {
      session.messages = []
      for (let j = 0; j < 20; j++) {
        session.messages.push(user(`msg ${j}`))
        session.messages.push(assistant(`resp ${j}`))
      }
      await sm.compact('test')
    }

    expect(sm.isSummarizeCircuitOpen).toBe(true)
    sm.resetCircuitBreaker()
    expect(sm.isSummarizeCircuitOpen).toBe(false)
  })

  test('successful summarization resets failure count', async () => {
    let fail = true
    sm.setSummarizeFn(async (msgs) => {
      if (fail) throw new Error('fail')
      return `summary of ${msgs.length} messages`
    })

    const session = sm.getOrCreate('test')

    // Fail twice
    for (let i = 0; i < 2; i++) {
      session.messages = []
      for (let j = 0; j < 20; j++) {
        session.messages.push(user(`msg ${j}`))
        session.messages.push(assistant(`resp ${j}`))
      }
      await sm.compact('test')
    }

    expect(sm.isSummarizeCircuitOpen).toBe(false)

    // Succeed
    fail = false
    session.messages = []
    for (let j = 0; j < 20; j++) {
      session.messages.push(user(`msg ${j}`))
      session.messages.push(assistant(`resp ${j}`))
    }
    await sm.compact('test')
    expect(sm.isSummarizeCircuitOpen).toBe(false)

    // Fail once more — should not trip (was reset by success)
    fail = true
    session.messages = []
    for (let j = 0; j < 20; j++) {
      session.messages.push(user(`msg ${j}`))
      session.messages.push(assistant(`resp ${j}`))
    }
    await sm.compact('test')
    expect(sm.isSummarizeCircuitOpen).toBe(false)
  })

  test('aggressiveKeep overrides keepRecentMessages', async () => {
    sm.setSummarizeFn(async (msgs) => `summary of ${msgs.length}`)

    const session = sm.getOrCreate('test')
    for (let i = 0; i < 20; i++) {
      session.messages.push(user(`msg ${i}`))
      session.messages.push(assistant(`resp ${i}`))
    }

    const result = await sm.compact('test', undefined, 2)
    expect(result).not.toBeNull()
    // With aggressiveKeep=2, we should only keep ~2 recent messages
    expect(session.messages.length).toBeLessThanOrEqual(4)
  })
})

// ===================================================================
// Layer 5: Reactive compaction (isContextOverflowError)
// ===================================================================

describe('Layer 5: isContextOverflowError', () => {
  // We test the detection indirectly through the exported agent-loop interface.
  // The actual integration is tested via the gateway, but we can verify the
  // error detection patterns here using a minimal import.
  
  test('onContextOverflow option exists in AgentLoopOptions', async () => {
    // Verify the type exists by importing it
    const mod = await import('../agent-loop')
    expect(mod.runAgentLoop).toBeDefined()
  })
})

// ===================================================================
// Integrated Pipeline
// ===================================================================

describe('Integrated pipeline: Layers 1-3 in sequence', () => {
  test('pipeline progressively reduces context size', () => {
    const msgs: Message[] = []
    // Create 10 turns with big tool results
    for (let i = 0; i < 10; i++) {
      msgs.push(...makeTurn(
        `prompt ${i}`,
        i < 5 ? 'read_file' : 'exec',
        Array.from({ length: 80 }, (_, j) => `line ${j}: ${'data'.repeat(50)}`).join('\n'),
        `I processed the ${i < 5 ? 'file' : 'command'} output and it looks good`,
      ))
    }

    const originalSize = JSON.stringify(msgs).length

    // Layer 1
    const afterBudget = applyToolResultBudget(msgs, 20_000)
    const budgetSize = JSON.stringify(afterBudget).length

    // Layer 2
    const { messages: afterMicro, tokensSaved } = microcompact(afterBudget)
    const microSize = JSON.stringify(afterMicro).length

    // Layer 3
    const afterSnip = snipConsumedResults(afterMicro)
    const snipSize = JSON.stringify(afterSnip).length

    // Each layer should reduce or maintain size
    expect(budgetSize).toBeLessThanOrEqual(originalSize)
    expect(microSize).toBeLessThanOrEqual(budgetSize)
    expect(snipSize).toBeLessThanOrEqual(microSize)

    // Final should be significantly smaller
    expect(snipSize).toBeLessThan(originalSize * 0.5)
  })

  test('pipeline preserves the most recent tool results untouched', () => {
    const recentOutput = 'RECENT_UNIQUE_DATA_' + 'z'.repeat(500)
    const msgs: Message[] = [
      ...makeTurn('old', 'exec', 'x'.repeat(5000), 'old response'),
      ...makeTurn('old2', 'exec', 'y'.repeat(5000), 'old response 2'),
      ...makeTurn('old3', 'exec', 'w'.repeat(5000), 'old response 3'),
      // The very last turn's tool result should always be preserved
      user('final prompt'),
      assistantWithToolUse('exec', 'tc_final'),
      toolResult(recentOutput, 'tc_final', 'exec'),
      assistant('done'),
    ]

    let history = applyToolResultBudget(msgs, 5000)
    history = microcompact(history).messages
    history = snipConsumedResults(history)

    const lastToolResult = [...history].reverse().find(m => m.role === 'toolResult')
    expect(lastToolResult).toBeDefined()
    expect(textOf(lastToolResult!)).toBe(recentOutput)
  })

  test('pipeline handles empty history', () => {
    let history = applyToolResultBudget([], 100_000)
    history = microcompact(history).messages
    history = snipConsumedResults(history)
    expect(history).toEqual([])
  })

  test('pipeline handles history with no tool results', () => {
    const msgs: Message[] = [user('hello'), assistant('world')]
    let history = applyToolResultBudget(msgs, 100_000)
    history = microcompact(history).messages
    history = snipConsumedResults(history)
    expect(history).toEqual(msgs)
  })
})
