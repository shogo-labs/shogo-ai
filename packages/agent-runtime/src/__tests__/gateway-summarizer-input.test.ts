// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AC3, second half: the request body the summarizer receives.
 *
 * `renderTranscriptForSummary` is the only thing that builds that body (the
 * gateway's `setSummarizeFn` calls it), so asserting on its output asserts on
 * the request. Three properties matter:
 *   - every tool call appears as `→ tool: name(args)` — the fix for a model
 *     inventing `str_replace` because the transcript had no real tool name;
 *   - the user message is never truncated;
 *   - a 90k-char range is not cut at 12k (the old cap), and past the cap the
 *     OLDEST rounds degrade instead of the tail being chopped.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { renderTranscriptForSummary, compactionSummaryInputChars, DEFAULT_COMPACTION_SUMMARY_INPUT_CHARS } from '../compaction-transcript'
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 0 }
}

function assistantText(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'anthropic', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 } as any
}

function toolCall(id: string, name: string, args: Record<string, any>): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], api: 'anthropic-messages', provider: 'anthropic', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 0 } as any
}

function toolResult(id: string, name: string, text: string, isError = false): ToolResultMessage {
  return { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError, timestamp: 0 } as ToolResultMessage
}

const originalCap = process.env.COMPACTION_SUMMARY_INPUT_CHARS

afterEach(() => {
  if (originalCap === undefined) delete process.env.COMPACTION_SUMMARY_INPUT_CHARS
  else process.env.COMPACTION_SUMMARY_INPUT_CHARS = originalCap
})

describe('renderTranscriptForSummary', () => {
  test('every tool call is a `→ tool:` line with its arguments', () => {
    const out = renderTranscriptForSummary([
      user('fix the tests'),
      toolCall('c1', 'exec', { command: 'bun test' }),
      toolResult('c1', 'exec', 'boom'),
      toolCall('c2', 'edit_file', { path: 'src/a.ts', old_string: 'x', new_string: 'y' }),
      toolResult('c2', 'edit_file', 'ok'),
      assistantText('fixed'),
    ])

    expect(out).toContain('User: fix the tests')
    expect(out).toContain('→ tool: exec({"command":"bun test"})')
    expect(out).toContain('→ tool: edit_file({"path":"src/a.ts"')
    expect(out).toContain('← exec result (4 chars): boom')
    expect(out).toContain('Assistant: fixed')
  })

  test('a failing result is labelled ERROR', () => {
    const out = renderTranscriptForSummary([
      user('run it'),
      toolCall('c1', 'exec', { command: 'false' }),
      toolResult('c1', 'exec', 'exit 1', true),
    ])
    expect(out).toContain('← exec result (6 chars, ERROR): exit 1')
  })

  test('the user message is never truncated', () => {
    const long = 'requirement '.repeat(2_000)
    const out = renderTranscriptForSummary([user(long), assistantText('ok')])
    expect(out.length).toBeGreaterThan(long.length)
    expect(out).toContain(long)
  })

  test('a 90k-char range is not cut — the old 12k cap is gone', () => {
    const requirement = 'the requirement must never be dropped '.repeat(2_500)
    const messages: Message[] = [user(requirement)]
    for (let i = 0; i < 9; i++) {
      messages.push(toolCall(`c${i}`, 'exec', { command: `bun test ${i}` }))
      messages.push(toolResult(`c${i}`, 'exec', 'z'.repeat(10_000)))
    }
    const out = renderTranscriptForSummary(messages)
    expect(out.length).toBeGreaterThan(80_000)
    expect(out).toContain('→ tool: exec({"command":"bun test 8"})')
  })

  test('past the cap the oldest rounds degrade and the tail stays whole', () => {
    const messages: Message[] = [user('big turn')]
    for (let i = 0; i < 10; i++) {
      messages.push(toolCall(`c${i}`, 'exec', { command: `bun test ${i}` }))
      messages.push(toolResult(`c${i}`, 'exec', `result-${i} ` + 'z'.repeat(5_000)))
    }
    messages.push(assistantText('final answer stays'))

    const out = renderTranscriptForSummary(messages, { maxChars: 2_000 })
    expect(out.length).toBeLessThan(6_000)
    // Newest round and the closing answer survive verbatim.
    expect(out).toContain('→ tool: exec({"command":"bun test 9"})')
    expect(out).toContain('result-9')
    expect(out).toContain('Assistant: final answer stays')
    // Oldest rounds became one line each, still naming a real tool.
    expect(out).toContain('[round · → tool: exec')
    expect(out).not.toContain('result-0')
  })

  test('the cap is configurable, defaulting to 120k', () => {
    expect(compactionSummaryInputChars()).toBe(DEFAULT_COMPACTION_SUMMARY_INPUT_CHARS)
    process.env.COMPACTION_SUMMARY_INPUT_CHARS = '5000'
    expect(compactionSummaryInputChars()).toBe(5_000)
    process.env.COMPACTION_SUMMARY_INPUT_CHARS = 'nonsense'
    expect(compactionSummaryInputChars()).toBe(DEFAULT_COMPACTION_SUMMARY_INPUT_CHARS)
  })

  test('is deterministic for the same messages', () => {
    const messages: Message[] = [
      user('hi'),
      toolCall('c1', 'read_file', { path: 'a.ts' }),
      toolResult('c1', 'read_file', 'body'),
    ]
    expect(renderTranscriptForSummary(messages)).toBe(renderTranscriptForSummary(messages))
  })
})
