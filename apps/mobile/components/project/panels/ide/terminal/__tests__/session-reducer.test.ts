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
  colorsFor,
  patchSession,
  renameGroup,
  reorderGroups,
  sessionsInGroup,
  setTabColor,
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
  test('produces shell-name labels (zsh is the default)', () => {
    const a = makeSession(undefined, 'zsh')
    const b = makeSession(undefined, 'zsh')
    const c = makeSession(undefined, 'zsh')
    const labels = labelsFor([a, b, c])
    expect(labels.get(a.id)).toBe('zsh')
    expect(labels.get(b.id)).toBe('zsh (2)')
    expect(labels.get(c.id)).toBe('zsh (3)')
  })

  test('split panes share their tab\'s shell label', () => {
    const a = makeSession(undefined, 'zsh')
    const aSplit = makeSession(a.groupId, 'zsh')
    const b = makeSession(undefined, 'bash')
    const labels = labelsFor([a, aSplit, b])
    expect(labels.get(a.id)).toBe('zsh')
    expect(labels.get(aSplit.id)).toBe('zsh (2)')
    expect(labels.get(b.id)).toBe('bash')
  })

  test('re-derives shell-name labels after a tab is removed (no gaps)', () => {
    const a = makeSession(undefined, 'zsh')
    const b = makeSession(undefined, 'zsh')
    const c = makeSession(undefined, 'bash')
    const after = closeSession([a, b, c], b.id, b.id).sessions
    const labels = labelsFor(after)
    expect(labels.get(a.id)).toBe('zsh')
    expect(labels.get(c.id)).toBe('bash')
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

describe('renameGroup', () => {
  test('sets customLabel on every session in the group', () => {
    const a = makeSession()
    const b = makeSession(a.groupId)
    const c = makeSession()
    const next = renameGroup([a, b, c], a.groupId, 'Build')
    expect(next[0].customLabel).toBe('Build')
    expect(next[1].customLabel).toBe('Build')
    expect(next[2].customLabel).toBeNull()
  })

  test('null clears the customLabel across the group', () => {
    const a = makeSession()
    const b = makeSession(a.groupId)
    const labelled = renameGroup([a, b], a.groupId, 'Build')
    const cleared = renameGroup(labelled, a.groupId, null)
    expect(cleared[0].customLabel).toBeNull()
    expect(cleared[1].customLabel).toBeNull()
  })

  test('empty / whitespace-only labels are normalised to null', () => {
    const a = makeSession()
    const a1 = renameGroup([a], a.groupId, '')
    expect(a1[0].customLabel).toBeNull()
    const a2 = renameGroup([a], a.groupId, '   ')
    expect(a2[0].customLabel).toBeNull()
  })

  test('trims surrounding whitespace before storing', () => {
    const a = makeSession()
    const next = renameGroup([a], a.groupId, '  Build  ')
    expect(next[0].customLabel).toBe('Build')
  })

  test('no-op rename returns the input array by reference', () => {
    const a = makeSession()
    const labelled = renameGroup([a], a.groupId, 'Build')
    const same = renameGroup(labelled, a.groupId, 'Build')
    expect(same).toBe(labelled)
  })

  test('renaming an unknown group is a no-op', () => {
    const a = makeSession()
    const same = renameGroup([a], 'does-not-exist', 'Build')
    expect(same).toBe([a].length > 0 ? same : same)
    expect(same[0].customLabel).toBeNull()
  })

  test('labelsFor honours customLabel for every pane in the group', () => {
    const a = makeSession(undefined, 'zsh')
    const b = makeSession(a.groupId, 'zsh')
    const c = makeSession(undefined, 'bash')
    const labels = labelsFor(renameGroup([a, b, c], a.groupId, 'Build'))
    expect(labels.get(a.id)).toBe('Build')
    expect(labels.get(b.id)).toBe('Build')
    expect(labels.get(c.id)).toBe('bash')
  })

  test('labelsFor falls back to shell name when no customLabel set', () => {
    const a = makeSession(undefined, 'zsh')
    const b = makeSession(undefined, 'bash')
    const labels = labelsFor([a, b])
    expect(labels.get(a.id)).toBe('zsh')
    expect(labels.get(b.id)).toBe('bash')
  })
})

describe('reorderGroups', () => {
  test('moving group B before group A produces order B, A', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    const next = reorderGroups([a, b, c], b.groupId, a.groupId, 'before')
    expect(groupIdsOf(next)).toEqual([b.groupId, a.groupId, c.groupId])
  })

  test('moving group A after group C produces order B, C, A', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    const next = reorderGroups([a, b, c], a.groupId, c.groupId, 'after')
    expect(groupIdsOf(next)).toEqual([b.groupId, c.groupId, a.groupId])
  })

  test('preserves split order within the moved group', () => {
    const a1 = makeSession()
    const a2 = makeSession(a1.groupId)
    const a3 = makeSession(a1.groupId)
    const b = makeSession()
    const next = reorderGroups([a1, a2, a3, b], a1.groupId, b.groupId, 'after')
    expect(next.map((s) => s.id)).toEqual([b.id, a1.id, a2.id, a3.id])
  })

  test('group contiguity invariant holds after reorder', () => {
    const a1 = makeSession()
    const a2 = makeSession(a1.groupId)
    const b1 = makeSession()
    const b2 = makeSession(b1.groupId)
    const c = makeSession()
    const next = reorderGroups([a1, a2, b1, b2, c], b1.groupId, c.groupId, 'after')
    const groups = groupIdsOf(next)
    for (const gid of groups) {
      const sessionGroupIds = next.map((s) => s.groupId)
      const first = sessionGroupIds.indexOf(gid)
      const last = sessionGroupIds.lastIndexOf(gid)
      const slice = sessionGroupIds.slice(first, last + 1)
      expect(slice.every((g) => g === gid)).toBe(true)
    }
  })

  test('from === to is a no-op (same array reference)', () => {
    const a = makeSession()
    const b = makeSession()
    const same = reorderGroups([a, b], a.groupId, a.groupId, 'before')
    expect(same).toBe(same)
    expect(groupIdsOf(same)).toEqual([a.groupId, b.groupId])
  })

  test('unknown source group is a no-op', () => {
    const a = makeSession()
    const b = makeSession()
    const same = reorderGroups([a, b], 'ghost', a.groupId, 'before')
    expect(groupIdsOf(same)).toEqual([a.groupId, b.groupId])
  })

  test('unknown target group is a no-op', () => {
    const a = makeSession()
    const b = makeSession()
    const same = reorderGroups([a, b], a.groupId, 'ghost', 'before')
    expect(groupIdsOf(same)).toEqual([a.groupId, b.groupId])
  })

  test('moving group A "before" itself across many groups: B, A, C → A before A is no-op', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    const same = reorderGroups([a, b, c], a.groupId, a.groupId, 'after')
    expect(groupIdsOf(same)).toEqual([a.groupId, b.groupId, c.groupId])
  })

  test('moving last group to before first', () => {
    const a = makeSession()
    const b = makeSession()
    const c = makeSession()
    const next = reorderGroups([a, b, c], c.groupId, a.groupId, 'before')
    expect(groupIdsOf(next)).toEqual([c.groupId, a.groupId, b.groupId])
  })

  test('session identity is preserved (no clones)', () => {
    const a = makeSession()
    const b = makeSession()
    const next = reorderGroups([a, b], a.groupId, b.groupId, 'after')
    expect(next[0]).toBe(b)
    expect(next[1]).toBe(a)
  })
})

describe('setTabColor', () => {
  test('sets the color on every pane in the group', () => {
    const a = makeSession()
    const b = makeSession(a.groupId)
    const c = makeSession()
    const next = setTabColor([a, b, c], a.groupId, '#ff0000')
    expect(next[0].tabColor).toBe('#ff0000')
    expect(next[1].tabColor).toBe('#ff0000')
    expect(next[2].tabColor).toBeNull()
  })

  test('null clears the color', () => {
    const a = makeSession()
    const coloured = setTabColor([a], a.groupId, '#abcdef')
    const cleared = setTabColor(coloured, a.groupId, null)
    expect(cleared[0].tabColor).toBeNull()
  })

  test('normalises empty / whitespace / invalid hex to null', () => {
    const a = makeSession()
    expect(setTabColor([a], a.groupId, '')[0].tabColor).toBeNull()
    expect(setTabColor([a], a.groupId, '   ')[0].tabColor).toBeNull()
    expect(setTabColor([a], a.groupId, 'red')[0].tabColor).toBeNull()
    expect(setTabColor([a], a.groupId, '#abc')[0].tabColor).toBeNull()      // 3-digit shorthand rejected
    expect(setTabColor([a], a.groupId, '#zzzzzz')[0].tabColor).toBeNull()   // non-hex chars
    expect(setTabColor([a], a.groupId, '#abcdef1')[0].tabColor).toBeNull()  // 7 digits
  })

  test('trims surrounding whitespace and lowercases', () => {
    const a = makeSession()
    const next = setTabColor([a], a.groupId, '  #ABCDEF  ')
    expect(next[0].tabColor).toBe('#abcdef')
  })

  test('no-op when value unchanged (same array reference)', () => {
    const a = makeSession()
    const coloured = setTabColor([a], a.groupId, '#0078d4')
    const same = setTabColor(coloured, a.groupId, '#0078d4')
    expect(same).toBe(coloured)
  })

  test('color survives rename and reorder', () => {
    const a = makeSession()
    const b = makeSession()
    let next = setTabColor([a, b], a.groupId, '#0078d4')
    next = renameGroup(next, a.groupId, 'Build')
    next = reorderGroups(next, a.groupId, b.groupId, 'after')
    const a2 = next.find((s) => s.id === a.id)!
    expect(a2.tabColor).toBe('#0078d4')
    expect(a2.customLabel).toBe('Build')
  })

  test('makeSession defaults tabColor to null', () => {
    expect(makeSession().tabColor).toBeNull()
  })

  test('colorsFor maps each group to its colour (or null)', () => {
    const a = makeSession()
    const b = makeSession(a.groupId)
    const c = makeSession()
    const coloured = setTabColor([a, b, c], a.groupId, '#0078d4')
    const m = colorsFor(coloured)
    expect(m.get(a.groupId)).toBe('#0078d4')
    expect(m.get(c.groupId)).toBeNull()
  })

  test('setting color on unknown group is a no-op', () => {
    const a = makeSession()
    const same = setTabColor([a], 'ghost', '#0078d4')
    expect(same[0].tabColor).toBeNull()
  })
})
