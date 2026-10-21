// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityRole, accessibilityLabel, accessibilityState, testID, children, disabled, onPress }: any) =>
      createElement(
        'div',
        {
          role: accessibilityRole ?? 'button',
          'aria-label': accessibilityLabel,
          'aria-checked': accessibilityState?.checked,
          'data-testid': testID,
          'aria-disabled': disabled ? 'true' : undefined,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
    View: ({ children }: any) => createElement('div', null, children),
    Text: ({ children }: any) => createElement('span', null, children),
    TextInput: ({ value, onChangeText, placeholder, accessibilityLabel }: any) =>
      createElement('input', {
        value,
        placeholder,
        'aria-label': accessibilityLabel,
        onChange: (e: any) => onChangeText?.(e.target.value),
      }),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => {
  const passthrough = ({ children }: any) => createElement('div', null, children)
  return {
    Card: passthrough,
    CardContent: passthrough,
    Button: ({ children, onPress, disabled, accessibilityLabel }: any) =>
      createElement(
        'button',
        { type: 'button', onClick: disabled ? undefined : onPress, disabled: !!disabled, 'aria-label': accessibilityLabel },
        children,
      ),
    Switch: ({ checked, onCheckedChange, disabled }: any) =>
      createElement('input', {
        type: 'checkbox',
        checked: !!checked,
        disabled: !!disabled,
        onChange: () => onCheckedChange?.(!checked),
      }),
    cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  }
})
mock.module('../account-sheet-chrome', () => ({
  Text: ({ children }: any) => createElement('span', null, children),
  TextInput: ({ value, onChangeText, placeholder, accessibilityLabel, onBlur }: any) =>
    createElement('input', {
      value,
      placeholder,
      'aria-label': accessibilityLabel,
      onChange: (e: any) => onChangeText?.(e.target.value),
      onBlur: () => onBlur?.(),
    }),
}))
mock.module('../../../contexts/theme', () => ({ useResolvedTheme: () => 'light' }))
mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'ws-1', name: 'Acme' }),
}))
let experience: { resolved: boolean; kind: string } = { resolved: true, kind: 'team' }
mock.module('../../../hooks/useWorkspaceExperience', () => ({
  useWorkspaceExperience: () => experience,
}))
mock.module('../../../hooks/useTeamChat', () => ({ useMentionables: () => null }))
mock.module('../../../hooks/useCustomEmoji', () => ({ useCustomEmojiFeed: () => {} }))
mock.module('../../team-chat/WorkspaceChatAdmin', () => ({
  UserGroupsCard: () => createElement('div', { 'data-testid': 'user-groups' }),
  CustomEmojiCard: () => createElement('div', { 'data-testid': 'custom-emoji' }),
}))
mock.module('../../../lib/notification-sound', () => ({ previewMessageSound: () => {} }))
mock.module('../../../lib/huddle-ringtone', () => ({ previewHuddleSound: () => {} }))
mock.module('../../../lib/notifications/device-alert-prefs', () => ({
  readDeviceAlertPrefs: () => ({ dockBounce: 'off', flashTaskbar: false }),
  writeDeviceAlertPrefs: (patch: any) => ({ dockBounce: 'off', flashTaskbar: false, ...patch }),
}))
mock.module('../../../lib/notifications/huddle-call-prefs', () => ({
  getAnnounceHuddleCalls: () => true,
  setAnnounceHuddleCallsPreference: async () => {},
  subscribeAnnounceHuddleCalls: () => () => {},
}))

const updates: Array<Record<string, unknown>> = []
const chatSettings: Record<string, unknown> = {
  statusEmoji: null,
  statusText: null,
  statusExpiresAt: null,
  keywords: [],
  quietHours: null,
  timezone: null,
  notifyDefault: 'mentions',
  messageSound: 'default',
  huddleSound: 'ring',
  dndUntil: null,
  emailDigest: 'off',
  dmInActivity: true,
  threadRepliesInBadge: true,
  mobilePushDelay: 'inactive',
}
mock.module('../../../hooks/useChatPrefs', () => ({
  useChatSettings: () => ({
    settings: chatSettings,
    error: null,
    saving: false,
    update: async (patch: Record<string, unknown>) => {
      updates.push(patch)
      Object.assign(chatSettings, patch)
    },
  }),
}))

const { ChatPreferencesTab } = await import('../ChatPreferencesTab')

beforeEach(() => {
  updates.length = 0
  experience = { resolved: true, kind: 'team' }
  chatSettings.messageSound = 'default'
  chatSettings.huddleSound = 'ring'
})

afterEach(cleanup)

describe('ChatPreferencesTab', () => {
  test('renders the message-sound choices as radio rows and saves Off', () => {
    render(createElement(ChatPreferencesTab))

    const off = screen.getByTestId('chat-message-sound-off')
    expect(off.getAttribute('role')).toBe('radio')
    expect(off.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('chat-message-sound-default').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(off)
    expect(updates).toEqual([{ messageSound: 'off' }])
  })

  test('renders every control the old Chat preferences page had', () => {
    render(createElement(ChatPreferencesTab))

    for (const heading of [
      'Status',
      'Do Not Disturb',
      'Notify me about',
      'Quiet hours',
      'Sounds',
      'Activity',
      'Phone notifications',
      'Email',
      'User groups',
      'Custom emoji',
      'Desktop notifications',
    ]) {
      expect(screen.getByText(heading)).toBeTruthy()
    }
    expect(screen.getByLabelText('Status emoji')).toBeTruthy()
    expect(screen.getByLabelText('Notification keywords')).toBeTruthy()
    expect(screen.getByLabelText('Quiet hours start')).toBeTruthy()
    expect(screen.getByTestId('chat-huddle-sound-off')).toBeTruthy()
    expect(screen.getByTestId('chat-push-delay-inactive')).toBeTruthy()
  })

  test('keeps the iPhone and Electron blocks off a plain web tab', () => {
    render(createElement(ChatPreferencesTab))

    expect(screen.queryByText('This iPhone')).toBeNull()
    expect(screen.queryByText('This computer')).toBeNull()
    expect(screen.queryByTestId('chat-dock-bounce-off')).toBeNull()
  })

  test('asks for a team workspace when there is none', () => {
    experience = { resolved: true, kind: 'personal' }
    render(createElement(ChatPreferencesTab))

    expect(screen.getByText('Team chat is available in team workspaces.')).toBeTruthy()
    expect(screen.queryByText('Sounds')).toBeNull()
  })
})
