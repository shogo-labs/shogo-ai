// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { stripOrphanToolParts } from '../strip-orphan-tool-parts'

function msg(parts: any[], id = 'm') {
  return { id, role: 'assistant', parts } as any
}

describe('stripOrphanToolParts', () => {
  it('returns input unchanged when there are no tool parts', () => {
    const input = [msg([{ type: 'text', text: 'hi' }])]
    const r = stripOrphanToolParts(input)
    expect(r.droppedCount).toBe(0)
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0].parts).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('passes through complete tool parts (output-available)', () => {
    const part = { type: 'tool-foo', state: 'output-available', output: 'ok' }
    const r = stripOrphanToolParts([msg([part])])
    expect(r.droppedCount).toBe(0)
    expect(r.messages[0].parts).toEqual([part])
  })

  it('passes through tool parts in output-error and output-denied', () => {
    const a = { type: 'tool-bar', state: 'output-error' }
    const b = { type: 'tool-baz', state: 'output-denied' }
    const r = stripOrphanToolParts([msg([a, b])])
    expect(r.droppedCount).toBe(0)
    expect(r.messages[0].parts).toEqual([a, b])
  })

  it('drops orphan tool parts in non-complete states', () => {
    const orphan = { type: 'tool-x', state: 'input-streaming' }
    const text = { type: 'text', text: 'hello' }
    const r = stripOrphanToolParts([msg([text, orphan])])
    expect(r.droppedCount).toBe(1)
    expect(r.messages[0].parts).toEqual([text])
  })

  it('drops tool parts with no state (undefined)', () => {
    const broken = { type: 'tool-x' }
    const r = stripOrphanToolParts([msg([broken])])
    expect(r.droppedCount).toBe(1)
    expect(r.messages).toHaveLength(0)
  })

  it('drops tool parts with non-string state', () => {
    const broken = { type: 'tool-x', state: 42 }
    const r = stripOrphanToolParts([msg([broken])])
    expect(r.droppedCount).toBe(1)
  })

  it('also strips dynamic-tool parts', () => {
    const orphan = { type: 'dynamic-tool', state: 'pending' }
    const r = stripOrphanToolParts([msg([orphan])])
    expect(r.droppedCount).toBe(1)
  })

  it('drops messages that end up empty after filtering', () => {
    const orphan = { type: 'tool-x', state: 'pending' }
    const r = stripOrphanToolParts([
      msg([orphan], 'first'),
      msg([{ type: 'text', text: 'kept' }], 'second'),
    ])
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0].id).toBe('second')
  })

  it('preserves messages with no parts array (handled as passthrough)', () => {
    const noParts = { id: 'x', role: 'assistant' } as any
    const empty = { id: 'y', role: 'assistant', parts: [] } as any
    const r = stripOrphanToolParts([noParts, empty])
    expect(r.messages).toEqual([noParts, empty])
  })

  it('does NOT mutate the input array', () => {
    const orphan = { type: 'tool-x', state: 'pending' }
    const input = [msg([orphan, { type: 'text', text: 'hi' }])]
    const snapshot = JSON.parse(JSON.stringify(input))
    stripOrphanToolParts(input)
    expect(input).toEqual(snapshot)
  })

  it('treats non-object parts as non-tool passthrough', () => {
    const input = [msg(['raw-string' as any, null as any])]
    const r = stripOrphanToolParts(input)
    expect(r.droppedCount).toBe(0)
    expect(r.messages[0].parts).toEqual(['raw-string', null])
  })

  it('drops parts whose type field is not a string', () => {
    const broken = { type: 123 } as any
    const r = stripOrphanToolParts([msg([broken])])
    expect(r.droppedCount).toBe(0)
    expect(r.messages[0].parts).toEqual([broken])
  })
})
