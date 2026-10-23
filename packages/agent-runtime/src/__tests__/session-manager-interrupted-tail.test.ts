// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A history whose tail is an unanswered tool call is what a run killed
 * mid-tool leaves behind. pi-ai's own pairing repair fills those gaps with a
 * *success*, which tells the resumed model a tool it never saw finish had run —
 * so the runtime repairs them first, and says it was interrupted (SHO-121).
 */
import { describe, expect, test } from 'bun:test'
import type { Message } from '@mariozechner/pi-ai'
import { repairInterruptedTailMessages } from '../session-manager'

const userTurn = (): Message => ({ role: 'user', content: 'Deploy the app', timestamp: 1 }) as unknown as Message

const assistantWithCalls = (calls: Array<{ id: string; name: string }>, patch: Record<string, any> = {}): Message =>
  ({
    role: 'assistant',
    content: calls.map((call) => ({ type: 'toolCall', id: call.id, name: call.name, arguments: { command: 'x' } })),
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 2,
    ...patch,
  }) as unknown as Message

const toolResult = (toolCallId: string, toolName = 'exec'): Message =>
  ({
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: 'done' }],
    isError: false,
    timestamp: 3,
  }) as unknown as Message

const assistantText = (text: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 3,
  }) as unknown as Message

describe('repairInterruptedTailMessages', () => {
  test('answers a tool call the run never saw return', () => {
    const messages = [userTurn(), assistantWithCalls([{ id: 'tu_1', name: 'exec' }])]
    const { messages: repaired, repaired: calls } = repairInterruptedTailMessages(messages)

    expect(calls).toEqual([{ toolCallId: 'tu_1', toolName: 'exec' }])
    expect(repaired).toHaveLength(messages.length + 1)
    const result = repaired.at(-1) as any
    expect(result.role).toBe('toolResult')
    expect(result.toolCallId).toBe('tu_1')
    // The truth the next turn needs: not a success.
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Interrupted before this tool returned')
  })

  test('answers only the call that is missing from a parallel group', () => {
    const messages = [userTurn(), assistantWithCalls([{ id: 'tu_1', name: 'exec' }, { id: 'tu_2', name: 'read_file' }]), toolResult('tu_1')]
    const { messages: repaired, repaired: calls } = repairInterruptedTailMessages(messages)

    expect(calls).toEqual([{ toolCallId: 'tu_2', toolName: 'read_file' }])
    expect(repaired).toHaveLength(messages.length + 1)
    expect((repaired.at(-1) as any).toolCallId).toBe('tu_2')
    // The real result survives untouched.
    expect(repaired[2]).toBe(messages[2]!)
  })

  test('leaves a finished turn untouched', () => {
    const complete = [userTurn(), assistantWithCalls([{ id: 'tu_1', name: 'exec' }]), toolResult('tu_1'), assistantText('Done.')]
    const { messages: repaired, repaired: calls } = repairInterruptedTailMessages(complete)
    expect(calls).toEqual([])
    expect(repaired).toBe(complete)
  })

  test('leaves a turn that already failed untouched', () => {
    for (const stopReason of ['error', 'aborted']) {
      const messages = [userTurn(), assistantWithCalls([{ id: 'tu_1', name: 'exec' }], { stopReason })]
      const { repaired } = repairInterruptedTailMessages(messages)
      expect(repaired).toEqual([])
    }
  })

  test('leaves an empty or text-only history untouched', () => {
    expect(repairInterruptedTailMessages([]).repaired).toEqual([])
    expect(repairInterruptedTailMessages([userTurn()]).repaired).toEqual([])
    expect(repairInterruptedTailMessages([userTurn(), assistantText('Nothing to do.')]).repaired).toEqual([])
  })
})
