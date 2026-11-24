// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the main process accepts from a renderer's tray publish: malformed rows
 * dropped, lengths capped, and the count/flags derived from the rows rather
 * than trusted.
 */

import { describe, expect, test } from 'bun:test'
import {
  EMPTY_TRAY_MODEL,
  TRAY_MAX_GROUPS,
  TRAY_MAX_RECENT,
  TRAY_MAX_ROWS_PER_GROUP,
  TRAY_MAX_TITLE_CHARS,
  parseTrayModel,
  trayModelChanged,
} from '../tray-protocol'

function row(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's-1',
    projectId: null,
    title: 'A chat',
    status: null,
    path: '/(app)/agent?chatSessionId=s-1',
    ...overrides,
  }
}

describe('parseTrayModel', () => {
  test('drops rows without an id, a title or an in-app path', () => {
    const model = parseTrayModel({
      pinned: [
        row({ sessionId: '' }),
        row({ path: 'https://evil.example' }),
        row({ path: '//evil.example' }),
        row({ sessionId: 'ok', title: '' }),
      ],
    })
    expect(model.pinned.map((r) => r.sessionId)).toEqual(['ok'])
    expect(model.pinned[0].title).toBe('Untitled chat')
  })

  test('caps sections, rows and title length', () => {
    const model = parseTrayModel({
      pinned: Array.from({ length: 12 }, (_, i) => row({ sessionId: `p${i}` })),
      groups: Array.from({ length: 10 }, (_, g) => ({
        title: `Agent ${g}`,
        rows: Array.from({ length: 9 }, (_, i) => row({ sessionId: `g${g}-${i}` })),
      })),
      recent: Array.from({ length: 9 }, (_, i) => row({ sessionId: `r${i}`, title: 'x'.repeat(300) })),
    })
    expect(model.pinned).toHaveLength(5)
    expect(model.groups).toHaveLength(TRAY_MAX_GROUPS)
    expect(model.groups[0].rows).toHaveLength(TRAY_MAX_ROWS_PER_GROUP)
    expect(model.recent).toHaveLength(TRAY_MAX_RECENT)
    expect(model.recent[0].title).toHaveLength(TRAY_MAX_TITLE_CHARS)
  })

  test('keeps a chat in one place only (first sighting wins)', () => {
    const model = parseTrayModel({
      pinned: [row({ sessionId: 'dup' })],
      groups: [{ title: 'Shogo', rows: [row({ sessionId: 'dup' }), row({ sessionId: 'other' })] }],
    })
    expect(model.pinned.map((r) => r.sessionId)).toEqual(['dup'])
    expect(model.groups[0].rows.map((r) => r.sessionId)).toEqual(['other'])
  })

  test('derives the attention count and canClear from the rows, not the payload', () => {
    const model = parseTrayModel({
      attentionCount: 99,
      canClear: false,
      groups: [
        {
          title: 'Shogo',
          rows: [row({ sessionId: 'a', status: 'needs_you' }), row({ sessionId: 'b', status: 'running' })],
        },
      ],
      recent: [row({ sessionId: 'c', status: 'new' })],
    })
    // needs_you + new count; a running chat does not want the person.
    expect(model.attentionCount).toBe(2)
    expect(model.canClear).toBe(true)
  })

  test('garbage in, empty model out', () => {
    expect(parseTrayModel(null)).toEqual(EMPTY_TRAY_MODEL)
    expect(parseTrayModel('nope')).toEqual(EMPTY_TRAY_MODEL)
    expect(parseTrayModel({ groups: 'nope', pinned: {} })).toEqual(EMPTY_TRAY_MODEL)
    const skipped = parseTrayModel({ groups: [{ title: '', rows: [row()] }, { title: 'Shogo', rows: [] }] })
    expect(skipped.groups).toEqual([])
  })
})

describe('trayModelChanged', () => {
  test('is false for the same contents and true for a new dot', () => {
    const a = parseTrayModel({ recent: [row()] })
    const b = parseTrayModel({ recent: [row()] })
    expect(trayModelChanged(a, b)).toBe(false)
    const c = parseTrayModel({ recent: [row({ status: 'new' })] })
    expect(trayModelChanged(a, c)).toBe(true)
  })
})
