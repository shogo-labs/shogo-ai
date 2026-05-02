// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetSessionIdSeqForTest,
  addSession,
  closeSession,
  labelsFor,
  makeSession,
  patchSession,
  type Session,
} from '../session-reducer'

beforeEach(() => {
  __resetSessionIdSeqForTest()
})

function ids(sessions: Session[]): string[] {
  return sessions.map((s) => s.id)
}

describe('makeSession', () => {
  test('returns a session with empty buffers and unique id', () => {
    const a = makeSession()
    const b = makeSession()
    expect(a.id).not.toBe(b.id)
    expect(a.output).toBe('')
    expect(a.runningCmdId).toBeNull()
    expect(a.history).toEqual([])
    expect(a.cwd).toBeNull()
    expect(a.prevCwd).toBeNull()
  })
})

describe('labelsFor', () => {
  test('produces 1-indexed positional labels', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    const labels = labelsFor([a, b, c])
    expect(labels.get(a.id)).toBe('Terminal 1')
    expect(labels.get(b.id)).toBe('Terminal 2')
    expect(labels.get(c.id)).toBe('Terminal 3')
  })

  test('re-derives positional labels after a tab is removed (no gaps)', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    const after = closeSession([a, b, c], b.id, b.id).sessions
    const labels = labelsFor(after)
    expect(labels.get(a.id)).toBe('Terminal 1')
    expect(labels.get(c.id)).toBe('Terminal 2')
    expect(labels.has(b.id)).toBe(false)
  })
})

describe('addSession', () => {
  test('appends the new session to the end and preserves order', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    expect(ids(addSession([a, b], c))).toEqual([a.id, b.id, c.id])
  })
})

describe('closeSession', () => {
  test('returns panelDismissed when the last session is closed', () => {
    const a = makeSession()
    const result = closeSession([a], a.id, a.id)
    expect(result.panelDismissed).toBe(true)
    expect(result.sessions).toEqual([])
    expect(result.nextActiveId).toBeNull()
  })

  test('closing a non-active middle session keeps the active id stable', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    const result = closeSession([a, b, c], b.id, a.id)
    expect(result.panelDismissed).toBe(false)
    expect(result.nextActiveId).toBeNull()
    expect(ids(result.sessions)).toEqual([a.id, c.id])
  })

  test('closing the active session in the middle moves to the right neighbor', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    const result = closeSession([a, b, c], b.id, b.id)
    expect(result.nextActiveId).toBe(c.id)
    expect(ids(result.sessions)).toEqual([a.id, c.id])
  })

  test('closing the active rightmost session moves to the new last session', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    const result = closeSession([a, b, c], c.id, c.id)
    expect(result.nextActiveId).toBe(b.id)
    expect(ids(result.sessions)).toEqual([a.id, b.id])
  })

  test('closing an unknown id is a no-op', () => {
    const a = makeSession()
    const b = makeSession()
    const result = closeSession([a, b], 'does-not-exist', a.id)
    expect(result.panelDismissed).toBe(false)
    expect(result.nextActiveId).toBeNull()
    expect(ids(result.sessions)).toEqual([a.id, b.id])
  })
})

describe('patchSession', () => {
  test('applies the patch immutably to the matching session only', () => {
    const a = makeSession()
    const b = makeSession()
    const next = patchSession([a, b], b.id, (s) => ({ ...s, output: 'hi' }))
    expect(next[0]).toBe(a)
    expect(next[1]).not.toBe(b)
    expect(next[1].output).toBe('hi')
  })

  test('returns the same array reference when the id is missing', () => {
    const a = makeSession()
    const next = patchSession([a], 'missing', (s) => ({ ...s, output: 'x' }))
    expect(next[0]).toBe(a)
  })
})
