// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { ringFromPushData } from '../native-call-payload'

const ids = { huddleId: 'h-1', conversationId: 'c-1', workspaceId: 'w-1' }

describe('ringFromPushData', () => {
  test('reads a VoIP push, with the caller under from', () => {
    expect(
      ringFromPushData({
        ...ids,
        kind: 'dm',
        from: { userId: 'u-kim', name: 'Kim', image: 'https://img/kim.png' },
      }),
    ).toEqual({
      ...ids,
      kind: 'dm',
      from: { userId: 'u-kim', name: 'Kim', image: 'https://img/kim.png' },
    })
  })

  test('reads an Android data push, which carries the caller name as callerName', () => {
    expect(ringFromPushData({ ...ids, callerName: 'Kim' })).toEqual({
      ...ids,
      kind: 'dm',
      from: { userId: '', name: 'Kim', image: null },
    })
  })

  test('marks a group huddle as group_dm', () => {
    expect(ringFromPushData({ ...ids, kind: 'group_dm', callerName: 'Kim' })?.kind).toBe('group_dm')
  })

  test('falls back to Someone when no name is sent', () => {
    expect(ringFromPushData({ ...ids })?.from.name).toBe('Someone')
  })

  test('is not a ring without the huddle, conversation and workspace ids', () => {
    expect(ringFromPushData({ conversationId: 'c-1', workspaceId: 'w-1' })).toBeNull()
    expect(ringFromPushData({ huddleId: 'h-1', workspaceId: 'w-1' })).toBeNull()
    expect(ringFromPushData({ huddleId: 'h-1', conversationId: 'c-1' })).toBeNull()
    expect(ringFromPushData({ huddleId: '', conversationId: 'c-1', workspaceId: 'w-1' })).toBeNull()
  })
})
