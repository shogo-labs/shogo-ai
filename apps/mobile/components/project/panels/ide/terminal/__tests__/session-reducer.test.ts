// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetSessionIdSeqForTest,
  addSession,
  addSplit,
  closeGroup,
  closeSession,
  groupIdsOf,
  labelsFor,
  makeSession,
  patchSession,
  sessionsInGroup,
  type Session,
} from '../session-reducer'

beforeEach(() => {
  __resetSessionIdSeqForTest()
})

function ids(sessions: Session[]): string[] {
  return sessions.map((s) => s.id)
}

describe('makeSession', () => {
  test('returns a session in the "creating" state with no PTY yet', () => {
    const a = makeSession()
    const b = makeSession()
    expect(a.id).not.toBe(b.id)
    expect(a.ptySessionId).toBeNull()
    expect(a.client).toBeNull()
    expect(a.status).toBe('creating')
    expect(a.errorMessage).toBeNull()
    expect(a.exit).toBeNull()
  })
})

describe('groups', () => {
  test('makeSession mints a fresh group id per call by default', () => {
    const a = makeSession()
    const b = makeSession()
    expect(a.groupId).not.toBe(b.groupId)
  })

  test('makeSession reuses a passed group id (split pane)', () => {
    const a = makeSession()
    const split = makeSession(a.groupId)
    expect(split.groupId).toBe(a.groupId)
  })

  test('groupIdsOf returns ordered, de-duplicated group ids', () => {
    const a = makeSession()
    const b = makeSession(a.groupId) // split of a
    const c = makeSession() // new tab
    expect(groupIdsOf([a, b, c])).toEqual([a.groupId, c.groupId])
  })

  test('sessionsInGroup returns only the group members', () => {
    const a = makeSession()
    const b = makeSession(a.groupId)
    const c = makeSession()
    expect(ids(sessionsInGroup([a, b, c], a.groupId))).toEqual([a.id, b.id])
    expect(ids(sessionsInGroup([a, b, c], c.groupId))).toEqual([c.id])
  })
})

describe('addSplit', () => {
  test('inserts the split right after the last member of its group', () => {
    const a = makeSession() // group A
    const b = makeSession() // group B
    const splitA = makeSession(a.groupId)
    // a, b currently; split of A should land after a, keeping A contiguous.
    expect(ids(addSplit([a, b], splitA))).toEqual([a.id, splitA.id, b.id])
  })

  test('falls back to append when the group is not present', () => {
    const a = makeSession()
    const orphanSplit = makeSession('g-unknown')
    expect(ids(addSplit([a], orphanSplit))).toEqual([a.id, orphanSplit.id])
  })
})

describe('closeGroup', () => {
  test('removes every pane in the group', () => {
    const a = makeSession()
    const aSplit = makeSession(a.groupId)
    const b = makeSession()
    const result = closeGroup([a, aSplit, b], a.groupId, a.id)
    expect(ids(result.sessions)).toEqual([b.id])
    expect(result.nextActiveId).toBe(b.id)
    expect(result.panelDismissed).toBe(false)
  })

  test('dismisses the panel when closing the only group', () => {
    const a = makeSession()
    const aSplit = makeSession(a.groupId)
    const result = closeGroup([a, aSplit], a.groupId, aSplit.id)
    expect(result.sessions).toEqual([])
    expect(result.panelDismissed).toBe(true)
  })

  test('keeps the active id when closing a non-active group', () => {
    const a = makeSession()
    const b = makeSession()
    const result = closeGroup([a, b], b.groupId, a.id)
    expect(ids(result.sessions)).toEqual([a.id])
    expect(result.nextActiveId).toBeNull()
    expect(result.panelDismissed).toBe(false)
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

  test('split panes share their tab\'s positional label', () => {
    const a = makeSession()
    const aSplit = makeSession(a.groupId)
    const b = makeSession()
    const labels = labelsFor([a, aSplit, b])
    expect(labels.get(a.id)).toBe('Terminal 1')
    expect(labels.get(aSplit.id)).toBe('Terminal 1')
    expect(labels.get(b.id)).toBe('Terminal 2')
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
    const next = patchSession([a, b], b.id, (s) => ({
      ...s,
      status: 'ready',
    }))
    expect(next[0]).toBe(a)
    expect(next[1]).not.toBe(b)
    expect(next[1].status).toBe('ready')
  })

  test('returns the same array reference shape when the id is missing', () => {
    const a = makeSession()
    const next = patchSession([a], 'missing', (s) => ({
      ...s,
      status: 'ready',
    }))
    expect(next[0]).toBe(a)
  })
})
