// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { pruneToolResults } from '../session-manager'
import type { Message, UserMessage, AssistantMessage, ToolResultMessage } from '@mariozechner/pi-ai'

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

function toolResult(text: string, toolName = 'exec'): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: `tc_${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  }
}

function assistantWithTool(toolName: string, args: Record<string, any>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'tc_1', name: toolName, arguments: args }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  }
}

describe('pruneToolResults', () => {
  test('does not modify messages when all within keepLastTurns', () => {
    const messages: Message[] = [
      user('run ls'),
      assistantWithTool('exec', { command: 'ls' }),
      toolResult('file1.txt\nfile2.txt'),
      assistant('Found 2 files.'),
    ]

    const pruned = pruneToolResults(messages, { keepLastTurns: 3 })
    expect(pruned).toEqual(messages)
  })

  test('soft trims oversized tool results beyond keepLastTurns', () => {
    const bigOutput = 'x'.repeat(10000)
    const messages: Message[] = [
      // Old turn
      user('old prompt'),
      assistantWithTool('exec', { command: 'dump' }),
      toolResult(bigOutput),
      assistant('old response'),
      // Recent turn
      user('new prompt'),
      assistant('new response'),
    ]

    const pruned = pruneToolResults(messages, {
      keepLastTurns: 1,
      softTrimMaxChars: 4000,
      hardClearAfterTurns: 10,
    })

    const toolMsg = pruned[2] as ToolResultMessage
    const text = toolMsg.content[0].type === 'text' ? toolMsg.content[0].text : ''
    expect(text.length).toBeLessThan(bigOutput.length)
    expect(text).toContain('chars trimmed')
  })

  test('hard clears very old tool results', () => {
    const messages: Message[] = []

    // 10 turns of user + tool call + tool result + assistant
    for (let i = 0; i < 10; i++) {
      messages.push(user(`prompt ${i}`))
      messages.push(assistantWithTool('exec', { command: `cmd-${i}` }))
      messages.push(toolResult(`result-${i} ${'z'.repeat(100)}`))
      messages.push(assistant(`response ${i}`))
    }

    const pruned = pruneToolResults(messages, {
      keepLastTurns: 2,
      softTrimMaxChars: 4000,
      hardClearAfterTurns: 5,
    })

    // Very old tool results should be replaced with placeholders
    const oldToolMsg = pruned[2] as ToolResultMessage
    const oldText = oldToolMsg.content[0].type === 'text' ? oldToolMsg.content[0].text : ''
    expect(oldText).toContain('Tool result cleared')

    // Recent tool results should be untouched
    const recentIdx = messages.length - 2 // second to last is tool result of last turn
    const recentToolMsg = pruned[recentIdx] as ToolResultMessage
    const recentText = recentToolMsg.content[0].type === 'text' ? recentToolMsg.content[0].text : ''
    expect(recentText).toContain('result-9')
  })

  test('does not modify non-toolResult messages', () => {
    const messages: Message[] = [
      user('hello'),
      assistant('A very long response: ' + 'y'.repeat(10000)),
      user('thanks'),
      assistant('done'),
    ]

    const pruned = pruneToolResults(messages, {
      keepLastTurns: 1,
      softTrimMaxChars: 100,
    })

    const assistantMsg = pruned[1] as AssistantMessage
    const text = assistantMsg.content[0].type === 'text' ? assistantMsg.content[0].text : ''
    expect(text.length).toBeGreaterThan(10000)
  })

  test('preserves tool results within keepLastTurns even if large', () => {
    const bigOutput = 'z'.repeat(20000)
    const messages: Message[] = [
      user('run it'),
      assistantWithTool('exec', { command: 'big' }),
      toolResult(bigOutput),
      assistant('done'),
    ]

    const pruned = pruneToolResults(messages, {
      keepLastTurns: 3,
      softTrimMaxChars: 100,
    })

    const toolMsg = pruned[2] as ToolResultMessage
    const text = toolMsg.content[0].type === 'text' ? toolMsg.content[0].text : ''
    expect(text).toBe(bigOutput)
  })
})
