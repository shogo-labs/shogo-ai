// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The + menu's items (SHO-454): "Invite people" appears only when the caller
 * may invite, and it comes last so the ways to start work stay on top.
 */
import { describe, expect, test } from 'bun:test'
import { createMenuItems } from '../create-menu-items'

describe('createMenuItems', () => {
  const startCreate = () => {}

  test('offers Invite people when the caller may invite', () => {
    const items = createMenuItems({ teamChat: true, startCreate, onInvite: () => {} })
    expect(items.map((i) => i.id)).toContain('invite-people')
    expect(items.find((i) => i.id === 'invite-people')?.label).toBe('Invite people')
  })

  test('hides Invite people when the caller may not invite', () => {
    const items = createMenuItems({ teamChat: true, startCreate })
    expect(items.map((i) => i.id)).not.toContain('invite-people')
  })

  test('keeps the invite item last, after the ways to start work', () => {
    const items = createMenuItems({ teamChat: true, startCreate, onInvite: () => {} })
    expect(items[items.length - 1]?.id).toBe('invite-people')
  })

  test('runs the invite handler when the item is chosen', () => {
    let opened = 0
    const items = createMenuItems({ teamChat: false, startCreate, onInvite: () => (opened += 1) })
    items.find((i) => i.id === 'invite-people')?.run?.()
    expect(opened).toBe(1)
  })
})
