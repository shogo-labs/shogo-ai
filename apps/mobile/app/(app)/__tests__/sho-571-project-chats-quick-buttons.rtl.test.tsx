// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-571: an agent's chat list on the phone has quick buttons for that
 * project's Files, Canvas, Plans and Settings.
 *
 * `ProjectSurfaceQuickButtons` is NOT stubbed, so this asserts the row the
 * screen renders and the route each button pushes, through the real
 * `projectSurfaceRoute` helper the project tab bar also uses.
 *
 *   bun test "apps/mobile/app/(app)/__tests__/sho-571-project-chats-quick-buttons.rtl.test.tsx"
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act, createContext, createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const pushes: any[] = []
const replaces: any[] = []

/** The onLayout the header was given, so the test can report a height. */
const layouts: Array<(event: unknown) => void> = []

const flatStyle = (style: any) =>
  Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style

const View = (props: Record<string, any>) => {
  const { children, onLayout, testID, style, ...rest } = props
  if (typeof onLayout === 'function') layouts.push(onLayout)
  return createElement(
    'div',
    { ...rest, 'data-rn-shim': testID, style: flatStyle(style) },
    children as ReactNode,
  )
}

const Pressable = (props: Record<string, any>) => {
  const { children, onPress, accessibilityLabel, accessibilityRole, disabled, style, ...rest } = props
  return createElement(
    'button',
    {
      ...rest,
      'data-rn-shim': props.testID,
      'aria-label': accessibilityLabel,
      role: accessibilityRole,
      onClick: disabled ? undefined : onPress,
      style: flatStyle(style),
    },
    children as ReactNode,
  )
}

/** Renders its rows, which the shared host shim would swallow. */
const FlatList = (props: Record<string, any>) => {
  const { data = [], renderItem, ListFooterComponent, contentContainerStyle, ...rest } = props
  return createElement(
    'div',
    { ...rest, 'data-rn-shim': 'chat-list', style: flatStyle(contentContainerStyle) },
    (data as any[]).map((item, index) =>
      createElement('div', { key: item.id ?? index }, renderItem({ item, index })),
    ),
    ListFooterComponent ?? null,
  )
}

const rnOverrides = {
  View,
  Pressable,
  FlatList,
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  Platform: { ...(createReactNativeMock({}) as any).Platform, OS: 'web' },
} as unknown as Parameters<typeof createReactNativeMock>[0]
mock.module('react-native', () => createReactNativeMock(rnOverrides))

const INSETS = { top: 47, bottom: 34, left: 0, right: 0 }
mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: View,
  SafeAreaInsetsContext: createContext(INSETS),
}))

mock.module(resolve(import.meta.dir, '../../../lib/use-phone-only-route'), () => ({
  usePhoneOnlyRoute: () => true,
}))

mock.module('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'p1' }),
  useRouter: () => ({
    push: (to: any) => pushes.push(to),
    replace: (to: any) => replaces.push(to),
    back: () => {},
    canGoBack: () => true,
  }),
}))

/** What the list fetch returns; `null` keeps it pending (the loading state). */
let sessionItems: any[] | null = []
const requests: string[] = []

mock.module(resolve(import.meta.dir, '../../../contexts/domain'), () => ({
  useProjectCollection: () => ({
    all: [{ id: 'p1', name: 'Atlas' }],
    loadAll: async () => {},
  }),
  useDomainHttp: () => ({
    get: async (url: string) => {
      requests.push(url)
      if (sessionItems === null) return new Promise(() => {})
      return { data: { ok: true, items: sessionItems, total: sessionItems.length } }
    },
  }),
}))

const { default: ProjectChatsPage } = await import('../project-chats')

const button = (label: string) => screen.getByRole('button', { name: label })

/** Mounts the screen; the fetch settles by the awaited query. */
const renderScreen = () => {
  render(createElement(ProjectChatsPage))
}

beforeEach(() => {
  cleanup()
  pushes.length = 0
  replaces.length = 0
  layouts.length = 0
  requests.length = 0
  sessionItems = [
    {
      id: 's1',
      name: 'Release checklist',
      createdAt: '2026-11-20T10:00:00Z',
      lastActiveAt: '2026-11-21T10:00:00Z',
    },
  ]
})

describe('SHO-571 — an agent chat list opens the project', () => {
  test('AC1: Files, Canvas, Plans and Settings sit above the chats', async () => {
    await renderScreen()
    await screen.findByText('Release checklist')

    expect(button('Files in Atlas')).toBeTruthy()
    expect(button('Canvas in Atlas')).toBeTruthy()
    expect(button('Plans in Atlas')).toBeTruthy()
    expect(button('Settings in Atlas')).toBeTruthy()
    // One row, above the list it opens the project from.
    const row = document.querySelector('[data-rn-shim="project-chats-quick-buttons"]') as HTMLElement
    expect(row.className).toContain('flex-row')
    expect(row.children.length).toBe(4)
  })

  test('AC2: each button pushes its surface, so Back returns to this list', async () => {
    await renderScreen()
    await screen.findByText('Release checklist')

    for (const surface of ['files', 'canvas', 'plans', 'settings'] as const) {
      fireEvent.click(
        document.querySelector(`[data-rn-shim="project-chats-quick-${surface}"]`) as HTMLElement,
      )
    }

    expect(pushes).toEqual([
      { pathname: '/(app)/project-surface/[id]', params: { id: 'p1', surface: 'files', navTab: 'files' } },
      { pathname: '/(app)/project-surface/[id]', params: { id: 'p1', surface: 'canvas', navTab: 'canvas' } },
      { pathname: '/(app)/project-surface/[id]', params: { id: 'p1', surface: 'plans', navTab: 'plans' } },
      { pathname: '/(app)/project-surface/[id]', params: { id: 'p1', surface: 'settings', navTab: 'settings' } },
    ])
    // Never a replace: the chat list must stay underneath.
    expect(replaces).toEqual([])
  })

  test('AC3: the buttons are there with no chats, and the list is padded under the header', async () => {
    sessionItems = []
    await renderScreen()
    await screen.findByText('No chats yet')

    expect(button('Files in Atlas')).toBeTruthy()
    expect(button('Settings in Atlas')).toBeTruthy()

    const content = document.querySelector('[data-rn-shim="chat-list"]') ?? null
    // No list when empty; the padding is on the container either way.
    expect(content).toBeNull()
    act(() => [...layouts].forEach((onLayout) => onLayout({ nativeEvent: { layout: { height: 142 } } })))
    const padded = [...document.querySelectorAll('div')].filter(
      (el) => (el as HTMLElement).style.paddingTop === '142px',
    )
    expect(padded.length).toBeGreaterThan(0)
  })

  test('AC3: the buttons are there while the chats load', async () => {
    sessionItems = null
    await renderScreen()

    expect(button('Files in Atlas')).toBeTruthy()
    expect(button('Plans in Atlas')).toBeTruthy()
    expect(screen.queryByText('No chats yet')).toBeNull()
  })

  test('AC4: a chat row and New chat still open the project screen', async () => {
    await renderScreen()
    fireEvent.click(await screen.findByText('Release checklist'))
    expect(pushes).toEqual([
      { pathname: '/(app)/projects/[id]', params: { id: 'p1', chatSessionId: 's1' } },
    ])

    pushes.length = 0
    fireEvent.click(button('New chat in Atlas'))
    expect(pushes).toEqual([
      {
        pathname: '/(app)/projects/[id]',
        params: { id: 'p1', newChat: '1', newChatNonce: expect.any(String) },
      },
    ])
  })

  test('the screen only asks for that project’s chats', async () => {
    await renderScreen()
    await waitFor(() => expect(requests.length).toBe(1))
    expect(requests[0]).toBe('/api/chat-sessions?contextId=p1&limit=50&offset=0')
  })
})
