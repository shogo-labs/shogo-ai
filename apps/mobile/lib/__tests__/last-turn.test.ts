// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { summarizeLastTurn } from '../last-turn'

const user = (text: string) => ({ id: `u-${text}`, role: 'user', parts: [{ type: 'text', text }] })
const assistant = (id: string, parts: unknown[]) => ({ id, role: 'assistant', parts })

describe('summarizeLastTurn', () => {
  test('is null before anyone has said anything', () => {
    expect(summarizeLastTurn([])).toBeNull()
    expect(summarizeLastTurn([assistant('a', [{ type: 'text', text: 'hi' }])])).toBeNull()
  })

  test('only looks at the newest turn', () => {
    const turn = summarizeLastTurn([
      user('first'),
      assistant('a1', [{ type: 'text', text: 'old answer' }]),
      user('second'),
      assistant('a2', [{ type: 'text', text: 'new answer' }]),
    ])
    expect(turn?.prompt).toBe('second')
    expect(turn?.answer).toBe('new answer')
  })

  test('lists tool calls with a label and the command or path', () => {
    const turn = summarizeLastTurn([
      user('run it'),
      assistant('a', [
        { type: 'tool-exec', toolCallId: 't1', state: 'output-available', input: { command: 'bun test\nmore' }, output: 'ok' },
        { type: 'tool-read_file', toolCallId: 't2', state: 'output-available', input: { path: 'src/a.ts' }, output: '' },
        { type: 'tool-custom_thing', toolCallId: 't3', state: 'input-available', input: {} },
      ]),
    ])
    expect(turn?.steps).toEqual([
      { id: 't1', label: 'Run a command', detail: 'bun test', state: 'done' },
      { id: 't2', label: 'Read a file', detail: 'src/a.ts', state: 'done' },
      { id: 't3', label: 'custom thing', detail: '', state: 'running' },
    ])
    expect(turn?.running).toBe(true)
  })

  test('failed tools are marked failed', () => {
    const turn = summarizeLastTurn([
      user('x'),
      assistant('a', [{ type: 'tool-exec', toolCallId: 't1', state: 'output-error', input: { command: 'false' } }]),
    ])
    expect(turn?.steps[0].state).toBe('failed')
    expect(turn?.running).toBe(false)
  })

  test('collects edits and writes for the diff, not reads', () => {
    const turn = summarizeLastTurn([
      user('fix'),
      assistant('a', [
        { type: 'tool-edit_file', toolCallId: 't1', state: 'output-available', input: { path: 'a.ts', old_string: 'a', new_string: 'b' } },
        { type: 'tool-write_file', toolCallId: 't2', state: 'output-available', input: { path: 'b.ts', content: 'x' } },
        { type: 'tool-read_file', toolCallId: 't3', state: 'output-available', input: { path: 'c.ts' } },
      ]),
    ])
    expect(turn?.changes.map((c) => c.toolName)).toEqual(['edit_file', 'write_file'])
    expect(turn?.changes[0].params.path).toBe('a.ts')
  })

  test('reads dynamic tools by their tool name', () => {
    const turn = summarizeLastTurn([
      user('x'),
      assistant('a', [{ type: 'dynamic-tool', toolName: 'shell', toolCallId: 't1', state: 'output-available', input: { command: 'ls' } }]),
    ])
    expect(turn?.steps[0]).toMatchObject({ label: 'Run a command', detail: 'ls' })
  })

  test('the answer is the last reply text, across several assistant messages', () => {
    const turn = summarizeLastTurn([
      user('x'),
      assistant('a1', [{ type: 'tool-exec', toolCallId: 't1', state: 'output-available', input: { command: 'ls' } }]),
      assistant('a2', [{ type: 'text', text: 'Done.' }, { type: 'text', text: 'All green.' }]),
    ])
    expect(turn?.answer).toBe('Done.\n\nAll green.')
    expect(turn?.steps).toHaveLength(1)
  })

  test('tolerates odd parts', () => {
    const turn = summarizeLastTurn([user('x'), assistant('a', [null, 5, 'str', { type: 'tool-exec' }])])
    expect(turn?.steps).toHaveLength(1)
  })
})
