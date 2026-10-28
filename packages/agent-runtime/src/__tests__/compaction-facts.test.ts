// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AC3: the summary cannot lie about files or tools.
 *
 * The model here is a stub that answers "I did some stuff." — the worst
 * plausible summarizer — and the persisted summary must still name every
 * edited path and every real tool. This is the guard against `str_replace`.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { SessionManager } from '../session-manager'
import {
  GROUND_TRUTH_MARKER,
  collectCompactionFacts,
  renderCompactionFacts,
} from '../compaction-facts'
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function call(name: string, id: string, args: Record<string, any>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as any
}

function result(id: string, text: string, isError = false): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'x',
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  } as ToolResultMessage
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

describe('collectCompactionFacts', () => {
  test('lists read vs edited files, tools with counts, and the last error line', () => {
    const messages: Message[] = [
      user('do the work'),
      call('read_file', 'c1', { path: 'src/a.ts' }),
      result('c1', 'file body'),
      call('edit_file', 'c2', { path: 'src/a.ts' }),
      result('c2', 'edited'),
      call('write_file', 'c3', { file_path: 'src/b.ts' }),
      result('c3', 'ok'),
      call('exec', 'c4', { command: 'bun test' }),
      result('c4', 'TypeError: boom\n  at line 2', true),
      call('exec', 'c5', { command: 'bun test' }),
      result('c5', 'pass'),
    ]

    const facts = collectCompactionFacts(messages)
    expect(facts.files).toEqual([
      { path: 'src/a.ts', read: true, edited: true },
      { path: 'src/b.ts', read: false, edited: true },
    ])
    expect(facts.tools).toEqual([
      { name: 'exec', count: 2 },
      { name: 'edit_file', count: 1 },
      { name: 'read_file', count: 1 },
      { name: 'write_file', count: 1 },
    ])
    expect(facts.lastError).toBe('TypeError: boom')
  })

  test('an edited-never-read file is still listed', () => {
    const facts = collectCompactionFacts([
      user('write it'),
      call('write_file', 'c1', { path: 'fresh.ts' }),
      result('c1', 'ok'),
    ])
    expect(facts.files).toEqual([{ path: 'fresh.ts', read: false, edited: true }])
  })

  test('an empty range renders empty sections rather than nothing', () => {
    const block = renderCompactionFacts(collectCompactionFacts([]))
    expect(block).toContain(GROUND_TRUTH_MARKER)
    expect(block).toContain('## Files touched\n- (none)')
    expect(block).toContain('## Tools used\n- (none)')
    expect(block).toContain('## Current state')
  })
})

describe('the facts block is appended by code, not by the model', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ keepRecentMessages: 4, estimatedTokensPerMessage: 1 })
  })

  test('a stub summarizer ("I did some stuff.") still yields files + real tool names', async () => {
    sm.setSummarizeFn(async () => 'I did some stuff.')
    const session = sm.getOrCreate('facts')

    session.messages.push(user('fix the bug'))
    session.messages.push(call('read_file', 'a1', { path: 'packages/agent/src/microcompact.ts' }))
    session.messages.push(result('a1', 'source'))
    session.messages.push(call('edit_file', 'a2', { path: 'packages/agent/src/microcompact.ts' }))
    session.messages.push(result('a2', 'edited'))
    session.messages.push(call('exec', 'a3', { command: 'bun test' }))
    session.messages.push(result('a3', 'pass'))
    session.messages.push(assistant('done'))
    // A new turn began: everything above is the compacted range.
    session.messages.push(user('and now the next thing'))

    const compaction = await sm.compact('facts')
    expect(compaction).not.toBeNull()

    const summary = session.compactedSummary ?? ''
    expect(summary).toContain('I did some stuff.')
    expect(summary).toContain(GROUND_TRUTH_MARKER)
    expect(summary).toContain('## Files touched')
    expect(summary).toContain('`packages/agent/src/microcompact.ts` — edited, read')
    expect(summary).toContain('## Tools used')
    expect(summary).toContain('`read_file` ×1')
    expect(summary).toContain('`edit_file` ×1')
    expect(summary).toContain('`exec` ×1')
    expect(summary).not.toContain('str_replace')
  })
})
