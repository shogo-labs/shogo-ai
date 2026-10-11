// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { channelDispatchOf } from '../message-helpers'

const dispatch = {
  conversationId: 'c1',
  conversationName: 'ops',
  threadRootId: 't1',
  agentName: 'Ops',
  trigger: { authorName: 'member', text: '@Ops run the check' },
  contextMode: 'shared',
}

describe('channelDispatchOf', () => {
  test('reads a data-channel-dispatch part', () => {
    expect(channelDispatchOf({ parts: [{ type: 'text', text: 'wrapper' }, { type: 'data-channel-dispatch', data: dispatch }] })).toEqual(dispatch)
  })

  test('reads the part when parts are still the stored JSON string', () => {
    const parts = JSON.stringify([{ type: 'data-channel-dispatch', data: { ...dispatch, handedOffBy: 'Builder', contextMode: 'isolated' } }])
    expect(channelDispatchOf({ parts })).toMatchObject({ handedOffBy: 'Builder', contextMode: 'isolated', conversationName: 'ops' })
  })

  test('is null when the message has no part', () => {
    expect(channelDispatchOf({ parts: [{ type: 'text', text: 'hello' }] })).toBeNull()
    expect(channelDispatchOf({ parts: undefined })).toBeNull()
    expect(channelDispatchOf(null)).toBeNull()
  })

  test('is null when the part is malformed', () => {
    expect(channelDispatchOf({ parts: [{ type: 'data-channel-dispatch', data: { conversationId: 'c1' } }] })).toBeNull()
    expect(channelDispatchOf({ parts: [{ type: 'data-channel-dispatch', data: 'nope' }] })).toBeNull()
    expect(channelDispatchOf({ parts: 'not json' })).toBeNull()
  })
})
