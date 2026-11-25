// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-419, SHO-458: a profile opened from a channel offers that channel's
 * "Messages in #<channel>" button — now it filters the timeline in place.
 * Activity channels are left out — they post-filter `canSeeMessage` after
 * the page is taken, so a filtered page can come back short.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import type { ConversationDetail } from '../../../lib/team-chat-api'

const Pressable = ({ onPress, accessibilityLabel, disabled, children }: Record<string, any>) =>
  createElement('button', { 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress }, children as ReactNode)

mock.module('react-native', () => createReactNativeMock({ Pressable }))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module(resolve(import.meta.dir, '../UserProfileBody'), () => ({
  UserProfileBody: () => createElement('div', null, 'profile body'),
}))

const { UserProfilePane } = await import('../UserProfilePane')

const channel = (kind: string) => ({ id: 'c-1', kind, name: 'launch', members: [] }) as unknown as ConversationDetail

const onFilterByMember = mock((_from: string) => {})
const onClose = mock(() => {})

const renderPane = (conversation: ConversationDetail | null) =>
  render(
    <UserProfilePane
      workspaceId="w-1"
      userId="u-ada"
      conversation={conversation}
      onFilterByMember={onFilterByMember}
      onClose={onClose}
    />,
  )

afterEach(cleanup)
beforeEach(() => {
  onFilterByMember.mockClear()
  onClose.mockClear()
})

describe('UserProfilePane', () => {
  test("offers the channel's messages for a person in a public channel", () => {
    renderPane(channel('public'))
    fireEvent.click(screen.getByLabelText('Messages in #launch'))
    expect(onFilterByMember).toHaveBeenCalledWith('user:u-ada')
  })

  test('a private channel offers it too', () => {
    renderPane(channel('private'))
    expect(screen.getByLabelText('Messages in #launch')).toBeTruthy()
  })

  test('an activity channel does not — its filtered pages come back short', () => {
    renderPane(channel('activity'))
    expect(screen.queryByLabelText('Messages in #launch')).toBeNull()
  })

  test('a profile opened outside a channel has no channel to filter', () => {
    renderPane(null)
    expect(screen.queryByLabelText(/Messages in #/)).toBeNull()
  })
})
