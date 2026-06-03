// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { createTurnStore, type Entry, type StreamEvent } from '../terminal-writer'

describe('terminal-writer / createTurnStore', () => {
  test('accumulates text deltas into a single text entry', () => {
    const store = createTurnStore()
    store.write({ type: 'text-start', id: 't1' })
    store.write({ type: 'text-delta', id: 't1', delta: 'Hello' })
    store.write({ type: 'text-delta', id: 't1', delta: ', world' })
    store.write({ type: 'text-end', id: 't1' })

    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'text', id: 't1', text: 'Hello, world' })
    expect(store.assistantText()).toBe('Hello, world')
    expect(store.hadError()).toBe(false)
  })

  test('tool row transitions running -> done', () => {
    const store = createTurnStore()
    store.write({ type: 'tool-input-start', toolCallId: 'c1', toolName: 'read_file', dynamic: true })
    let tool = store.getEntries().find((e) => e.kind === 'tool') as Extract<Entry, { kind: 'tool' }>
    expect(tool.status).toBe('running')
    expect(tool.toolName).toBe('read_file')

    store.write({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.ts' } })
    store.write({ type: 'tool-output-available', toolCallId: 'c1', output: { content: 'ok' } })

    tool = store.getEntries().find((e) => e.kind === 'tool') as Extract<Entry, { kind: 'tool' }>
    expect(tool.status).toBe('done')
    expect(tool.input).toEqual({ path: 'a.ts' })
    expect(tool.output).toEqual({ content: 'ok' })
    expect(store.hadError()).toBe(false)
  })

  test('tool output with {error} marks the row as error and sets hadError', () => {
    const store = createTurnStore()
    store.write({ type: 'tool-input-start', toolCallId: 'c2', toolName: 'exec' })
    store.write({ type: 'tool-output-available', toolCallId: 'c2', output: { error: 'boom' } })
    const tool = store.getEntries().find((e) => e.kind === 'tool') as Extract<Entry, { kind: 'tool' }>
    expect(tool.status).toBe('error')
    expect(store.hadError()).toBe(true)
  })

  test('error chunk appends an error entry and flips hadError', () => {
    const store = createTurnStore()
    store.write({ type: 'text-delta', id: 't1', delta: 'partial' })
    store.write({ type: 'error', errorText: 'model unavailable' })
    const entries = store.getEntries()
    expect(entries.at(-1)).toMatchObject({ kind: 'error', text: 'model unavailable' })
    expect(store.hadError()).toBe(true)
  })

  test('emits granular onEvent for streaming consumers, in order', () => {
    const events: StreamEvent[] = []
    const store = createTurnStore({ onEvent: (e) => events.push(e) })
    store.write({ type: 'text-delta', id: 't1', delta: 'A' })
    store.write({ type: 'tool-input-start', toolCallId: 'c1', toolName: 'search' })
    store.write({ type: 'tool-output-available', toolCallId: 'c1', output: { hits: 2 } })
    store.write({ type: 'text-delta', id: 't1', delta: 'B' })

    expect(events).toEqual([
      { type: 'text-delta', id: 't1', delta: 'A' },
      { type: 'tool-start', toolCallId: 'c1', toolName: 'search' },
      { type: 'tool-end', toolCallId: 'c1', status: 'done', output: { hits: 2 } },
      { type: 'text-delta', id: 't1', delta: 'B' },
    ])
  })

  test('reasoning deltas land in a dim reasoning entry', () => {
    const store = createTurnStore()
    store.write({ type: 'reasoning-start', id: 'r1' })
    store.write({ type: 'reasoning-delta', id: 'r1', delta: 'thinking' })
    const entry = store.getEntries()[0] as Extract<Entry, { kind: 'reasoning' }>
    expect(entry).toMatchObject({ kind: 'reasoning', text: 'thinking' })
  })

  test('notifies subscribers and supports unsubscribe', () => {
    const store = createTurnStore()
    let calls = 0
    const unsub = store.subscribe(() => { calls++ })
    store.write({ type: 'text-delta', id: 't1', delta: 'x' })
    expect(calls).toBe(1)
    unsub()
    store.write({ type: 'text-delta', id: 't1', delta: 'y' })
    expect(calls).toBe(1)
  })

  test('ignores unknown / non-rendered data chunks', () => {
    const store = createTurnStore()
    store.write({ type: 'data-context-usage', data: { tokens: 10 } })
    store.write({ type: 'data-routing-decision', data: {} })
    expect(store.getEntries()).toHaveLength(0)
  })
})
