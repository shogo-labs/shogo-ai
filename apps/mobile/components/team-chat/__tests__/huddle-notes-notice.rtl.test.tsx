// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a guest is promised before they join, and what the call's wake channel is
 * allowed to say. A guest's words are transcribed but never wake the agent, so
 * the guest form of the notice must not invite them to say "hey Shogo".
 */
import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () => createReactNativeMock())
mock.module('lucide-react-native', () => ({
  NotebookPen: () => null,
}))
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('../../../lib/huddle-call', () => ({
  setHuddleNotesEnabled: async () => {},
}))

const { HuddleNotesNotice } = await import('../HuddleNotesPill')
const { parseHuddleWake } = await import('../../../lib/huddle-room')

const body = () => document.querySelector('[data-rn-shim="huddle-notes-notice"]')?.textContent ?? ''
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('HuddleNotesNotice', () => {
  test('a member is told about captions, notes and the phrase', () => {
    render(createElement(HuddleNotesNotice, {}))
    expect(body()).toContain('live captions')
    expect(body()).toContain('hey Shogo')
  })

  test('a guest is told what they get, and not offered the wake', () => {
    render(createElement(HuddleNotesNotice, { guest: true }))
    expect(body()).toContain('live captions')
    expect(body()).toContain('notes')
    expect(body()).not.toContain('hey Shogo')
    expect(body()).toContain('wake nothing')
  })
})

describe('parseHuddleWake', () => {
  test('reads every status the server sends, including the cap', () => {
    expect(parseHuddleWake(bytes({ type: 'wake', by: 'Ada', messageId: 'm1', status: 'running' }))).toMatchObject({
      by: 'Ada',
      status: 'running',
      messageId: 'm1',
    })
    // The cap notice carries no note: there is nothing to open.
    expect(parseHuddleWake(bytes({ type: 'wake', by: 'Ada', status: 'limit' }))).toEqual({
      by: 'Ada',
      messageId: null,
      status: 'limit',
    })
  })

  test('ignores anything else on the topic', () => {
    expect(parseHuddleWake(bytes({ type: 'reaction', emoji: '🎉' }))).toBeNull()
    expect(parseHuddleWake(bytes({ type: 'wake', by: 'Ada', status: 'dancing' }))).toBeNull()
    expect(parseHuddleWake(bytes('not json'))).toBeNull()
  })
})
