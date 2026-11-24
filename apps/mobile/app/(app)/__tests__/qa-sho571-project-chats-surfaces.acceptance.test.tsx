// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-571 acceptance (QA): an agent's chat list opens that project's surfaces.
 *
 * The developer's RTL test proves the row renders and pushes the four routes.
 * This file is the gate on the things a wrong-but-green implementation would
 * still pass there:
 *
 *  - the row is a child of `PhoneScreenHeader`, so the `onLayout` the screen
 *    pads from *includes* it (padding the list by a height that omits the row
 *    hides the first chat under the glass);
 *  - it fits at 360 dp — four `flex-1` cells, one row, single-line labels in
 *    `overflow-hidden` pills (bun has no RN layout engine, so the fit is
 *    pinned structurally rather than measured);
 *  - the params it pushes are the ones `project-surface/[id].tsx` actually
 *    reads, and `navTab` names a tab the project dock really has;
 *  - no push carries a `chatSessionId` the list does not hold.
 *
 * Run it from `apps/mobile` (the package's bunfig preloads the DOM shims):
 *
 *   cd apps/mobile && bun --no-env-file --conditions=development \
 *     test "./app/(app)/__tests__/qa-sho571-project-chats-surfaces.acceptance.test.tsx"
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act, createContext, createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

/** 360 dp — the narrowest phone the phone routes have to fit. */
const PHONE_WIDTH = 360

const pushes: any[] = []
const replaces: any[] = []
/** The header's `onLayout`, so the test can report its measured height. */
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

const Text = (props: Record<string, any>) => {
  const { children, numberOfLines, ...rest } = props
  return createElement(
    'span',
    { ...rest, 'data-number-of-lines': numberOfLines ?? null },
    children as ReactNode,
  )
}

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
  Text,
  FlatList,
  useWindowDimensions: () => ({ width: PHONE_WIDTH, height: 800, scale: 1, fontScale: 1 }),
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

/** What `?id=` the screen was opened with; `undefined` is the no-project case. */
let routeParams: Record<string, string | undefined> = { id: 'p1' }

mock.module('expo-router', () => ({
  useLocalSearchParams: () => routeParams,
  useRouter: () => ({
    push: (to: any) => pushes.push(to),
    replace: (to: any) => replaces.push(to),
    back: () => {},
    canGoBack: () => true,
  }),
}))

/** `null` keeps the fetch pending, which is the loading state. */
let sessionItems: any[] | null = []

mock.module(resolve(import.meta.dir, '../../../contexts/domain'), () => ({
  useProjectCollection: () => ({
    all: [{ id: 'p1', name: 'Atlas' }],
    loadAll: async () => {},
  }),
  useDomainHttp: () => ({
    get: async (_url: string) => {
      if (sessionItems === null) return new Promise(() => {})
      return { data: { ok: true, items: sessionItems, total: sessionItems.length } }
    },
  }),
}))

const { default: ProjectChatsPage } = await import('../project-chats')

const SURFACES = [
  ['files', 'Files'],
  ['canvas', 'Canvas'],
  ['plans', 'Plans'],
  ['settings', 'Settings'],
] as const

const header = () =>
  document.querySelector('[data-rn-shim="phone-screen-header"]') as HTMLElement | null
const row = () => document.querySelector('[data-rn-shim="project-chats-quick-buttons"]') as HTMLElement | null
const pill = (surface: string) =>
  document.querySelector(`[data-rn-shim="project-chats-quick-${surface}"]`) as HTMLElement | null

beforeEach(() => {
  cleanup()
  pushes.length = 0
  replaces.length = 0
  layouts.length = 0
  routeParams = { id: 'p1' }
  sessionItems = [
    {
      id: 's1',
      name: 'Release checklist',
      createdAt: '2026-11-20T10:00:00Z',
      lastActiveAt: '2026-11-21T10:00:00Z',
    },
  ]
})

describe('SHO-571 — quick buttons above an agent’s chat list', () => {
  test('AC1: four Files/Canvas/Plans/Settings buttons, one row, at 360dp', async () => {
    render(createElement(ProjectChatsPage))
    await screen.findByText('Release checklist')

    for (const [, label] of SURFACES) {
      expect(screen.getByRole('button', { name: `${label} in Atlas` })).toBeTruthy()
    }

    const quickRow = row()!
    expect(quickRow.className).toContain('flex-row')
    // No wrap: a wrapped row would eat two header rows of the chat list.
    expect(quickRow.className).not.toContain('flex-wrap')
    expect(quickRow.children.length).toBe(4)

    // Equal widths, and each pill clips its own label instead of widening the
    // row — the two properties that make four labelled pills fit at 360.
    for (const [surface] of SURFACES) {
      const button = pill(surface)!
      expect(button.className).toContain('flex-1')
      expect(button.className).toContain('overflow-hidden')
      const label = button.querySelector('[data-number-of-lines="1"]')
      expect(label).not.toBeNull()
    }
  })

  test('AC3: the row is inside the measured header, so the list is padded under it', async () => {
    render(createElement(ProjectChatsPage))
    await screen.findByText('Release checklist')

    const headerEl = header()!
    // `PhoneScreenHeader` measures its own box, children slot included: the
    // row has to be a descendant of it for that height to cover the row.
    expect(headerEl.contains(row()!)).toBe(true)
    expect(row()!.contains(pill('settings')!)).toBe(true)

    act(() => [...layouts].forEach((onLayout) => onLayout({ nativeEvent: { layout: { height: 142 } } })))

    const padded = [...document.querySelectorAll('div')].filter(
      (el) => (el as HTMLElement).style.paddingTop === '142px',
    )
    expect(padded.length).toBe(1)
    // The list sits in the padded container, not beside it.
    expect(padded[0].querySelector('[data-rn-shim="chat-list"]')).not.toBeNull()
  })

  test('AC2: each button pushes the route project-surface/[id] reads, one push a tap', async () => {
    render(createElement(ProjectChatsPage))
    await screen.findByText('Release checklist')

    for (const [surface, label] of SURFACES) {
      fireEvent.click(screen.getByRole('button', { name: `${label} in Atlas` }))
    }

    expect(pushes.length).toBe(4)
    expect(replaces).toEqual([])
    expect(pushes.map((to) => to.params)).toEqual([
      { id: 'p1', surface: 'files', navTab: 'files' },
      { id: 'p1', surface: 'canvas', navTab: 'canvas' },
      { id: 'p1', surface: 'plans', navTab: 'plans' },
      { id: 'p1', surface: 'settings', navTab: 'settings' },
    ])
    for (const to of pushes) expect(to.pathname).toBe('/(app)/project-surface/[id]')
  })

  test('AC2: the destination screen reads the params these buttons send', () => {
    const screenSource = readFileSync(
      resolve(import.meta.dir, '../project-surface/[id].tsx'),
      'utf8',
    )
    // The surface screen takes both from `useLocalSearchParams`, by these names.
    expect(screenSource).toMatch(/id\?:\s*string\s*\|\s*string\[\]/)
    expect(screenSource).toMatch(/surface\?:\s*string\s*\|\s*string\[\]/)
    expect(screenSource).toMatch(/firstParam\(params\.surface\)/)
    expect(screenSource).toMatch(/projectId=\{firstParam\(params\.id\)\}/)
  })

  test('AC5: the project dock has the ⚙️ that navTab=settings lights', () => {
    const navSource = readFileSync(
      resolve(import.meta.dir, '../../../components/layout/MobileBottomNav.tsx'),
      'utf8',
    )
    // The mapping points at "more"; that id has to be a real project-dock item,
    // or the surface is left with nothing lit.
    expect(navSource).toMatch(/if \(tab === "settings"\) return "more";/)
    const projectItems = navSource.slice(navSource.indexOf('const projectItems = ['))
    expect(projectItems.slice(0, projectItems.indexOf(']'))).toContain('projectMoreItem')
    expect(navSource).toMatch(/const projectMoreItem = \{\s*id: "more"/)
  })

  test('AC3: the buttons are there with no chats and while they load', async () => {
    sessionItems = []
    render(createElement(ProjectChatsPage))
    await screen.findByText('No chats yet')
    expect(pill('files')).not.toBeNull()
    expect(pill('canvas')).not.toBeNull()
    expect(pill('plans')).not.toBeNull()
    expect(pill('settings')).not.toBeNull()

    cleanup()
    pushes.length = 0
    sessionItems = null
    render(createElement(ProjectChatsPage))
    expect(pill('files')).not.toBeNull()
    expect(pill('settings')).not.toBeNull()
    expect(screen.queryByText('No chats yet')).toBeNull()
  })

  test('AC4: a chat row and the header’s New chat still open the project screen', async () => {
    render(createElement(ProjectChatsPage))
    fireEvent.click(await screen.findByText('Release checklist'))
    expect(pushes).toEqual([
      { pathname: '/(app)/projects/[id]', params: { id: 'p1', chatSessionId: 's1' } },
    ])

    pushes.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'New chat in Atlas' }))
    expect(pushes).toEqual([
      {
        pathname: '/(app)/projects/[id]',
        params: { id: 'p1', newChat: '1', newChatNonce: expect.any(String) },
      },
    ])
  })

  test('without a project there is no surface to open, so no row', async () => {
    routeParams = {}
    render(createElement(ProjectChatsPage))
    await waitFor(() => expect(screen.queryByText('No chats yet')).not.toBeNull())
    expect(row()).toBeNull()
    expect(pushes).toEqual([])
  })
})
