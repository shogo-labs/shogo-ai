// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  ACTION_DECLINE,
  ACTION_JOIN,
  HUDDLE_CALLS_CHANNEL,
  HUDDLE_CALL_CATEGORY,
  huddleCallActionFrom,
  huddleCallCategoryActions,
} from '../huddle-call-actions'

const data = { huddleId: 'h-1', conversationId: 'c-1', workspaceId: 'w-1' }

describe('huddle call alert constants', () => {
  test('match the channel and category the API sends', () => {
    expect(HUDDLE_CALLS_CHANNEL).toBe('huddle-calls')
    expect(HUDDLE_CALL_CATEGORY).toBe('huddle-call')
  })
})

describe('huddleCallCategoryActions', () => {
  test('Join opens the app, Decline does not', () => {
    const [join, decline] = huddleCallCategoryActions()
    expect(join).toMatchObject({ identifier: ACTION_JOIN, buttonTitle: 'Join', options: { opensAppToForeground: true } })
    expect(decline).toMatchObject({ identifier: ACTION_DECLINE, buttonTitle: 'Decline', options: { opensAppToForeground: false } })
  })
})

describe('huddleCallActionFrom', () => {
  test('a tap on Join is a join decision, with the caller taken from the alert title', () => {
    expect(
      huddleCallActionFrom({
        actionIdentifier: ACTION_JOIN,
        notification: { request: { content: { title: 'Kim', data } } },
      }),
    ).toEqual({ decision: 'join', ...data, kind: 'dm', callerName: 'Kim' })
  })

  test('a tap on Decline declines it', () => {
    expect(
      huddleCallActionFrom({
        actionIdentifier: ACTION_DECLINE,
        notification: { request: { content: { title: 'Kim', data: { ...data, kind: 'group_dm' } } } },
      })?.decision,
    ).toBe('decline')
  })

  test('a plain tap on the alert is not an action', () => {
    expect(
      huddleCallActionFrom({
        actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
        notification: { request: { content: { title: 'Kim', data } } },
      }),
    ).toBeNull()
  })

  test('needs the huddle, conversation and workspace to act on', () => {
    expect(
      huddleCallActionFrom({
        actionIdentifier: ACTION_JOIN,
        notification: { request: { content: { title: 'Kim', data: { conversationId: 'c-1' } } } },
      }),
    ).toBeNull()
  })

  test('an empty caller title still gives a name', () => {
    expect(
      huddleCallActionFrom({
        actionIdentifier: ACTION_JOIN,
        notification: { request: { content: { title: '  ', data } } },
      })?.callerName,
    ).toBe('Someone')
  })

  test('no response at all is not an action', () => {
    expect(huddleCallActionFrom(null)).toBeNull()
    expect(huddleCallActionFrom(undefined)).toBeNull()
  })
})
