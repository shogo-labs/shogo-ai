// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { microcompact } from '../microcompact'
import type { Message, UserMessage, AssistantMessage, ToolResultMessage } from '@mariozechner/pi-ai'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 1 }
}
function assistantWithTool(toolName: string, toolCallId: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: {} }], api: 'anthropic-messages', provider: 'anthropic', model: 'mock', usage: { input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} }, stopReason: 'toolUse', timestamp: 1 } as any
}
function assistantText(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'anthropic', model: 'mock', usage: { input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} }, stopReason: 'stop', timestamp: 1 }
}
function toolResultMsg(toolCallId: string, text: string): ToolResultMessage {
  return { role: 'toolResult', toolCallId, content: [{ type: 'text', text }], isError: false, timestamp: 1 }
}

/** 4 short recent turns placed AFTER the target turn, pushing it outside keepRecentTurns=3 */
function recentPadding(n = 4): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < n; i++) {
    const id = `pad_${i}`
    msgs.push(user(`pad ${i}`), assistantWithTool('exec', id), toolResultMsg(id, 'ok'), assistantText('done'))
  }
  return msgs
}

/** Target turn placed at the START so it is older than keepRecentTurns */
function targetTurn(toolName: string, output: string): { messages: Message[]; id: string } {
  const id = 'target_tc'
  return {
    id,
    messages: [user('go'), assistantWithTool(toolName, id), toolResultMsg(id, output), assistantText('ok')],
  }
}

const LARGE_OUTPUT = Array.from({ length: 60 }, (_, i) => `line-${i}: ${'x'.repeat(50)}`).join('\n')

describe('microcompact — COMPACTABLE_TOOLS allowlist enforcement', () => {
  test('non-allowlisted tool (write_file) with large output is NOT compressed', () => {
    // Target turn first (old), then 4 recent padding turns → target is outside keepRecentTurns=3
    const { messages: tgt, id } = targetTurn('write_file', LARGE_OUTPUT)
    const messages: Message[] = [...tgt, ...recentPadding()]

    const { messages: out, tokensSaved } = microcompact(messages, { threshold: 2000, keepRecentTurns: 3 })

    const result = out.find(m => m.role === 'toolResult' && (m as ToolResultMessage).toolCallId === id) as ToolResultMessage
    expect(result.content[0].text).toBe(LARGE_OUTPUT)
    expect(tokensSaved).toBe(0)
  })

  test('allowlisted tool (exec) with large output IS compressed', () => {
    const { messages: tgt, id } = targetTurn('exec', LARGE_OUTPUT)
    const messages: Message[] = [...tgt, ...recentPadding()]

    const { messages: out, tokensSaved } = microcompact(messages, { threshold: 2000, keepRecentTurns: 3 })

    const result = out.find(m => m.role === 'toolResult' && (m as ToolResultMessage).toolCallId === id) as ToolResultMessage
    expect(result.content[0].text).not.toBe(LARGE_OUTPUT)
    expect(result.content[0].text).toContain('lines omitted')
    expect(tokensSaved).toBeGreaterThan(0)
  })

  test('unknown tool (broken chain — toolName null) is NOT compressed', () => {
    // orphan toolResult: no matching assistantWithTool in the chain
    const orphanId = 'orphan_tc'
    const messages: Message[] = [
      user('go'),
      // deliberate gap: no assistantWithTool with orphanId
      toolResultMsg(orphanId, LARGE_OUTPUT),
      assistantText('ok'),
      ...recentPadding(),
    ]

    const { messages: out, tokensSaved } = microcompact(messages, { threshold: 2000, keepRecentTurns: 3 })

    const result = out.find(m => m.role === 'toolResult' && (m as ToolResultMessage).toolCallId === orphanId) as ToolResultMessage
    expect(result.content[0].text).toBe(LARGE_OUTPUT)
    expect(tokensSaved).toBe(0)
  })

  test('custom compactableTools via config overrides default allowlist', () => {
    // write_file is not in the default allowlist — but we pass it explicitly
    const { messages: tgt, id } = targetTurn('write_file', LARGE_OUTPUT)
    const messages: Message[] = [...tgt, ...recentPadding()]

    const { messages: out, tokensSaved } = microcompact(messages, {
      threshold: 2000,
      keepRecentTurns: 3,
      compactableTools: new Set(['write_file']),
    })

    const result = out.find(m => m.role === 'toolResult' && (m as ToolResultMessage).toolCallId === id) as ToolResultMessage
    expect(result.content[0].text).not.toBe(LARGE_OUTPUT)
    expect(result.content[0].text).toContain('lines omitted')
    expect(tokensSaved).toBeGreaterThan(0)
  })
})
