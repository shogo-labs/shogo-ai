// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import type { ChannelDoc } from '../team-chat-api'
import {
  baseVersionOf,
  docReducer,
  initialDocState,
  isDirty,
  shouldSave,
  visibleDoc,
  type DocAction,
  type DocState,
} from '../channel-doc-state'

function doc(version: number, content: string, extra: Partial<ChannelDoc> = {}): ChannelDoc {
  return {
    id: 'd1',
    conversationId: 'c1',
    title: 'Plan',
    content,
    version,
    locked: false,
    updatedBy: { type: 'user', id: 'u2', name: 'Sam' },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...extra,
  }
}

function run(...actions: DocAction[]): DocState {
  return actions.reduce(docReducer, initialDocState)
}

const loaded = (d: ChannelDoc | null, canEdit = true): DocAction => ({ type: 'loaded', doc: d, canEdit, canManage: false })

describe('channel doc state', () => {
  test('a new doc is created from version 0 once there is something to save', () => {
    const empty = run(loaded(null))
    expect(baseVersionOf(empty)).toBe(0)
    expect(shouldSave(empty)).toBe(false)
    const typed = docReducer(empty, { type: 'edit', patch: { content: '# Hi' } })
    expect(isDirty(typed)).toBe(true)
    expect(shouldSave(typed)).toBe(true)
    expect(visibleDoc(typed)).toEqual({ title: '', content: '# Hi' })
  })

  test('nothing saves without edit rights or while a save is in flight', () => {
    const readOnly = run(loaded(doc(1, 'a'), false), { type: 'edit', patch: { content: 'b' } })
    expect(shouldSave(readOnly)).toBe(false)
    const saving = run(loaded(doc(1, 'a')), { type: 'edit', patch: { content: 'b' } }, { type: 'save-start' })
    expect(shouldSave(saving)).toBe(false)
  })

  test('a save clears the draft unless more was typed meanwhile', () => {
    const base = run(loaded(doc(1, 'a')), { type: 'edit', patch: { content: 'ab' } }, { type: 'save-start' })
    const clean = docReducer(base, { type: 'save-ok', doc: doc(2, 'ab') })
    expect(clean.draft).toBeNull()
    expect(baseVersionOf(clean)).toBe(2)

    const typedMore = docReducer(base, { type: 'edit', patch: { content: 'abc' } })
    const stillDirty = docReducer(typedMore, { type: 'save-ok', doc: doc(2, 'ab') })
    expect(stillDirty.draft?.content).toBe('abc')
    expect(shouldSave(stillDirty)).toBe(true)
    expect(baseVersionOf(stillDirty)).toBe(2)
  })

  test('remote updates replace a clean doc but conflict with unsaved edits', () => {
    const clean = run(loaded(doc(1, 'a')), { type: 'remote', doc: doc(2, 'theirs') })
    expect(visibleDoc(clean).content).toBe('theirs')
    expect(clean.conflict).toBeNull()

    const dirty = run(loaded(doc(1, 'a')), { type: 'edit', patch: { content: 'mine' } }, { type: 'remote', doc: doc(2, 'theirs') })
    expect(dirty.conflict?.theirs?.content).toBe('theirs')
    expect(visibleDoc(dirty).content).toBe('mine')
    expect(shouldSave(dirty)).toBe(false)
  })

  test('old or echoed remote versions are ignored, and so is anything during a save', () => {
    const state = run(loaded(doc(3, 'a')), { type: 'remote', doc: doc(2, 'older') })
    expect(visibleDoc(state).content).toBe('a')
    const saving = run(loaded(doc(1, 'a')), { type: 'edit', patch: { content: 'b' } }, { type: 'save-start' }, { type: 'remote', doc: doc(2, 'b') })
    expect(saving.conflict).toBeNull()
  })

  test('a lock change while editing updates the doc without a conflict', () => {
    const state = run(loaded(doc(1, 'a')), { type: 'edit', patch: { content: 'mine' } }, { type: 'remote', doc: doc(1, 'a', { locked: true }) })
    expect(state.conflict).toBeNull()
    expect(state.server?.locked).toBe(true)
    expect(visibleDoc(state).content).toBe('mine')
  })

  test('a 409 conflict resolves to theirs, or overwrites from their version', () => {
    const conflicted = run(
      loaded(doc(1, 'a')),
      { type: 'edit', patch: { content: 'mine' } },
      { type: 'save-start' },
      { type: 'save-conflict', theirs: doc(2, 'theirs') },
    )
    expect(conflicted.conflict).not.toBeNull()

    const theirs = docReducer(conflicted, { type: 'resolve', choice: 'theirs' })
    expect(visibleDoc(theirs).content).toBe('theirs')
    expect(isDirty(theirs)).toBe(false)

    const overwrite = docReducer(conflicted, { type: 'resolve', choice: 'overwrite' })
    expect(visibleDoc(overwrite).content).toBe('mine')
    expect(baseVersionOf(overwrite)).toBe(2)
    expect(shouldSave(overwrite)).toBe(true)
  })

  test('a permissions change keeps the loaded doc and any draft', () => {
    const state = run(loaded(doc(2, 'a')), { type: 'edit', patch: { content: 'mine' } }, { type: 'permissions', canEdit: false, canManage: false })
    expect(state.server?.version).toBe(2)
    expect(visibleDoc(state).content).toBe('mine')
    expect(state.canEdit).toBe(false)
    expect(shouldSave(state)).toBe(false)
  })

  test('reset adopts a restored doc and drops local edits', () => {
    const state = run(loaded(doc(1, 'a')), { type: 'edit', patch: { content: 'mine' } }, { type: 'reset', doc: doc(5, 'restored') })
    expect(visibleDoc(state).content).toBe('restored')
    expect(isDirty(state)).toBe(false)
  })
})
