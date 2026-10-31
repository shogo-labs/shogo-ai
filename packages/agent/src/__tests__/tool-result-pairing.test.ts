// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai'
import { convertMessages } from '@mariozechner/pi-ai/openai-completions'
import { defaultConvertToLlm, repairToolResultPairing, resolveModel, sanitizeToolCallIds } from '../pi-adapter'

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 0 }
}

function calls(ids: string[], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return {
    role: 'assistant',
    content: ids.map((id) => ({ type: 'toolCall' as const, id, name: 'exec', arguments: { command: id } })),
    api: 'openai-completions',
    provider: 'openai',
    model: 'deepseek-flash',
    usage,
    stopReason,
    timestamp: 0,
  }
}

function text(t: string): AssistantMessage {
  return { ...calls([], 'stop'), content: [{ type: 'text', text: t }] }
}

function result(id: string): ToolResultMessage {
  return { role: 'toolResult', toolCallId: id, toolName: 'exec', content: [{ type: 'text', text: `out ${id}` }], isError: false, timestamp: 0 }
}

/** The OpenAI chat-completions request body pi-ai would send for `messages`. */
function toOpenAi(messages: Message[]) {
  const model = resolveModel('custom', 'deepseek-flash') as any
  const compat = {
    supportsDeveloperRole: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: true,
    requiresToolResultName: false,
  } as any
  return convertMessages(model, { messages }, compat) as any[]
}

/** Every `tool` message must answer a call in the run of messages just before it. */
function strayToolMessages(params: any[]): string[] {
  const stray: string[] = []
  let open = new Set<string>()
  for (const p of params) {
    if (p.role === 'assistant') {
      open = new Set((p.tool_calls ?? []).map((tc: any) => tc.id))
    } else if (p.role === 'tool') {
      if (!open.has(p.tool_call_id)) stray.push(p.tool_call_id)
    } else {
      open = new Set()
    }
  }
  return stray
}

describe('repairToolResultPairing', () => {
  it('returns well-formed history untouched', () => {
    const history = [user('a'), calls(['x', 'y']), result('y'), result('x'), text('done'), user('b')]
    const repaired = repairToolResultPairing(history)
    expect(repaired.messages).toBe(history)
    expect(repaired.moved).toBe(0)
    expect(repaired.dropped).toBe(0)
  })

  it('moves a stopped turn\'s late result back next to its call', () => {
    const late = result('x2')
    const history = [
      user('a'), calls(['x1', 'x2']), result('x1'),
      user('b'), text('reply b'),
      late,
    ]
    expect(strayToolMessages(toOpenAi(history))).toEqual(['x2'])

    const repaired = repairToolResultPairing(history)
    expect(repaired.messages.map((m) => m.role)).toEqual([
      'user', 'assistant', 'toolResult', 'toolResult', 'user', 'assistant',
    ])
    expect(repaired.messages[3]).toBe(late)
    expect(repaired.moved).toBe(1)
    expect(strayToolMessages(toOpenAi(repaired.messages))).toEqual([])
  })

  it('moves a late result out of the next turn\'s tool group', () => {
    const history = [
      user('a'), calls(['x']),
      user('b'), calls(['y']), result('y'), result('x'), text('reply b'),
    ]
    const repaired = repairToolResultPairing(history)
    expect(repaired.messages.map((m) => (m.role === 'toolResult' ? m.toolCallId : m.role))).toEqual([
      'user', 'assistant', 'x', 'user', 'assistant', 'y', 'assistant',
    ])
    expect(strayToolMessages(toOpenAi(repaired.messages))).toEqual([])
  })

  it('drops results with no call, and results of errored or aborted calls', () => {
    const history = [
      user('a'), result('ghost'),
      calls(['e'], 'error'), result('e'),
      calls(['ab'], 'aborted'), result('ab'),
      user('b'),
    ]
    const repaired = repairToolResultPairing(history)
    expect(repaired.dropped).toBe(3)
    expect(repaired.messages.some((m) => m.role === 'toolResult')).toBe(false)
    expect(strayToolMessages(toOpenAi(repaired.messages))).toEqual([])
  })

  it('pairs a reused call id with the most recent call', () => {
    const first = result('toolu_0')
    const second = result('toolu_0')
    const history = [user('a'), calls(['toolu_0']), first, user('b'), calls(['toolu_0']), second]
    const repaired = repairToolResultPairing(history)
    expect(repaired.messages).toBe(history)
  })
})

describe('defaultConvertToLlm', () => {
  it('repairs pairing on the way to the model', () => {
    const history = [user('a'), calls(['x']), user('b'), text('reply b'), result('x')]
    const converted = defaultConvertToLlm(history)
    expect(strayToolMessages(toOpenAi(converted))).toEqual([])
    expect(converted[2]).toMatchObject({ role: 'toolResult', toolCallId: 'x' })
  })

  // A hydrated/compacted session can carry an assistant message whose content
  // is a plain string. Id normalisation and pairing must not assume blocks.
  it('passes a string-content assistant message through untouched', () => {
    const hydrated = { ...text('hydrated reply'), content: 'hydrated reply' } as unknown as AssistantMessage
    const history = [user('a'), hydrated, result('x')]
    expect(() => defaultConvertToLlm(history)).not.toThrow()
    expect(() => repairToolResultPairing([user('a'), hydrated])).not.toThrow()
    expect(() => sanitizeToolCallIds([user('a'), hydrated])).not.toThrow()
    expect(defaultConvertToLlm(history)[1]).toBe(hydrated)
  })
})
