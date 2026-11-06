// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Appearance submenu must not open a side flyout at phone width.
 *
 * A 200pt flyout placed beside this 280pt menu cannot fit a 402pt screen.
 * `placement="right top"` + `shouldFlip` correctly refuses to go right, flips
 * to the left of the trigger, and lands the panel's left edge ~99pt past the
 * viewport — measured off a 3x phone capture: submenu right edge at 100.8pt,
 * so a 200pt panel starts at -99.2pt with its labels cut off screen.
 *
 * Phone now expands the theme list in place, the same way Pause notifications
 * already did. Wide keeps the flyout, which has room there.
 */

import { resolve } from 'node:path'
import { describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    Pressable: ({ accessibilityLabel, children, onPress, ...props }: any) =>
      createElement(
        'button',
        { ...props, 'aria-label': accessibilityLabel, onClick: onPress },
        children,
      ),
  }),
)

mock.module('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }))

// ProfileMenu reads these where the avatar is and passes the results down; the
// menu body under test reads none of them itself.
mock.module(resolve(import.meta.dir, '../../../contexts/auth'), () => ({
  useAuth: () => ({ user: null, signOut: async () => {} }),
}))
mock.module(resolve(import.meta.dir, '../../../contexts/theme'), () => ({
  useTheme: () => ({ theme: 'system', setTheme: () => {} }),
  // native-phone-layout reads this for sheet chrome; a partial mock of this
  // module breaks it at import time.
  useResolvedTheme: () => 'light',
}))
mock.module(resolve(import.meta.dir, '../../../contexts/posthog'), () => ({
  usePostHogSafe: () => null,
}))
mock.module(resolve(import.meta.dir, '../../../hooks/useChatPrefs'), () => ({
  useChatSettings: () => ({ settings: null, update: async () => {} }),
}))
mock.module(resolve(import.meta.dir, '../../../hooks/useHasAdminAccess'), () => ({
  useHasAdminAccess: () => false,
}))
mock.module(resolve(import.meta.dir, '../../../hooks/usePresence'), () => ({
  usePresence: () => null,
  useInHuddle: () => false,
}))
mock.module(resolve(import.meta.dir, '../../../lib/platform-config'), () => ({
  usePlatformConfig: () => ({ localMode: false, shogoKeyConnected: true }),
}))
mock.module(resolve(import.meta.dir, '../../../lib/analytics'), () => ({
  EVENTS: { SIGN_OUT: 'sign_out' },
  trackEvent: () => {},
}))
mock.module(resolve(import.meta.dir, '../../team-chat/TeamChatSidebarProvider'), () => ({
  useTeamChatNav: () => ({ enabled: false, workspaceId: 'ws1' }),
}))

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  Avatar: () => null,
}))

mock.module('lucide-react-native', () => {
  const Icon = (name: string) => () => createElement('span', { 'data-icon': name })
  return Object.fromEntries(
    [
      'BellOff',
      'Check',
      'ChevronDown',
      'ChevronRight',
      'Headphones',
      'LogOut',
      'Monitor',
      'Moon',
      'Settings',
      'Shield',
      'SmilePlus',
      'Store',
      'Sun',
      'User',
      'UserRound',
    ].map((name) => [name, Icon(name)]),
  )
})

// PresenceDot reads the presence hooks, which reach for the API client. The
// menu's layout is what this file is about, so it stays out of the graph.
mock.module(resolve(import.meta.dir, '../../team-chat/PresenceDot'), () => ({
  PresenceDot: () => null,
  presenceLabel: () => 'Active',
}))

/**
 * Records that a flyout was opened and where it was asked to go, so "did this
 * render a side panel?" is answerable from the DOM.
 */
mock.module('@/components/ui/popover', () => ({
  Popover: ({ placement, isOpen, trigger, children }: any) =>
    createElement(
      'div',
      { 'data-popover-root': placement },
      trigger({}),
      isOpen ? createElement('div', { 'data-flyout': placement }, children) : null,
    ),
  PopoverBackdrop: () => null,
  PopoverBody: ({ children }: any) => createElement('div', null, children),
  PopoverContent: ({ children }: any) => createElement('div', null, children),
}))

const { ProfileMenuContent } = await import('../ProfileMenu')

function model(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: 'u1', name: 'Eby Paul Daniel', email: 'eby@example.com', image: null },
    chatEnabled: false,
    workspaceId: 'ws1',
    presence: null,
    settings: { dndUntil: null } as any,
    update: async () => {},
    go: () => {},
    theme: 'system' as const,
    setTheme: () => {},
    signOut: () => {},
    ...overrides,
  } as any
}

const LIGHT = 'Light'
const DARK = 'Dark'
const SYSTEM = 'System'

describe('Appearance submenu placement', () => {
  test('phone expands the theme list in place instead of a side flyout', () => {
    render(createElement(ProfileMenuContent, { model: model({ compactMenus: true }) }))

    expect(screen.queryByText(LIGHT)).toBeNull()

    fireEvent.click(screen.getByLabelText('Appearance'))

    // The whole point: the choices are here, and no panel was moved off screen.
    expect(screen.getByText(LIGHT)).toBeTruthy()
    expect(screen.getByText(DARK)).toBeTruthy()
    expect(screen.getByText(SYSTEM)).toBeTruthy()
    expect(document.querySelector('[data-flyout]')).toBeNull()
  })

  test('wide keeps the side flyout', () => {
    render(createElement(ProfileMenuContent, { model: model({ compactMenus: false }) }))

    expect(document.querySelector('[data-flyout]')).toBeNull()
    fireEvent.click(screen.getByLabelText('Appearance'))

    const flyout = document.querySelector('[data-flyout]')
    expect(flyout).toBeTruthy()
    expect(flyout?.getAttribute('data-flyout')).toBe('right top')
    // …and the list is inside the flyout, not the menu body.
    expect(flyout?.textContent).toContain(LIGHT)
  })

  test('picking a theme from the inline list calls the same handler', () => {
    const picks: string[] = []
    render(
      createElement(ProfileMenuContent, {
        model: model({ compactMenus: true, setTheme: (value: string) => picks.push(value) }),
      }),
    )
    fireEvent.click(screen.getByLabelText('Appearance'))
    fireEvent.click(screen.getByLabelText(DARK))

    expect(picks).toEqual(['dark'])
  })

  test('tapping Appearance twice collapses the inline list', () => {
    render(createElement(ProfileMenuContent, { model: model({ compactMenus: true }) }))
    fireEvent.click(screen.getByLabelText('Appearance'))
    expect(screen.getByText(LIGHT)).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Appearance'))
    expect(screen.queryByText(LIGHT)).toBeNull()
  })
})
