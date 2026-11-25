// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle notes: the glass header on a phone, today's bordered row everywhere
 * else.
 *
 * QA's SHO-490 round 1 caught this file rendering `PhoneScreenHeader`
 * unconditionally — the one migrated screen with no `isPhoneLayout` branch — so
 * a tablet or wide-web page, which is not on the phone navigation standard, lost
 * the row it had. Both branches are asserted here, because the wide one is only
 * reachable off-phone and no phone case would notice it going missing.
 */

import { describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { createContext, createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../../../test/react-native-mock'

const mobile = resolve(import.meta.dir, '../../../../..')

let window = { width: 390, height: 844 }

const View = (props: Record<string, any>) => {
  const { children, testID, style, ...rest } = props
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style
  return createElement(
    'div',
    { ...rest, 'data-rn-shim': testID, style: flat, className: props.className },
    children as ReactNode,
  )
}

const Pressable = (props: Record<string, any>) => {
  const { children, onPress, accessibilityLabel, disabled } = props
  return createElement(
    'button',
    { 'data-rn-shim': props.testID, 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress },
    children as ReactNode,
  )
}

const rnOverrides = {
  View,
  Pressable,
  useWindowDimensions: () => window,
} as unknown as Parameters<typeof createReactNativeMock>[0]

mock.module('react-native', () => createReactNativeMock(rnOverrides))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
// The header reads the inset context and never throws without a provider.
mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: View,
  SafeAreaInsetsContext: createContext({ top: 47, bottom: 34, left: 0, right: 0 }),
}))
mock.module('expo-router', () => ({
  useLocalSearchParams: () => ({ huddleId: 'h1' }),
  useRouter: () => ({ back: () => undefined, push: () => undefined, replace: () => undefined }),
}))
mock.module(resolve(mobile, 'lib/team-chat-api'), () => ({
  teamChatApi: () => ({
    huddleNotes: async () => ({
      meeting: { title: 'Standup huddle', duration: 600, enhanceStatus: 'ready', enhancedNotes: 'Summary' },
      transcript: { segments: [{ speaker: 'Ada', text: 'hello' }] },
      actionItems: [],
    }),
    deleteHuddleNotes: async () => undefined,
  }),
}))
mock.module(resolve(mobile, 'components/chat/MarkdownText'), () => ({
  MarkdownText: ({ children }: { children?: unknown }) => createElement('div', null, children as ReactNode),
}))
mock.module(resolve(mobile, 'components/meetings/MeetingTranscript'), () => ({
  MeetingTranscript: () => createElement('div', null, 'transcript'),
}))

const HuddleNotesScreen = (await import('../notes')).default

const byTestId = (id: string) => document.querySelector(`[data-rn-shim="${id}"]`) as HTMLElement | null

describe('huddle notes keep the standard on a phone and their own row elsewhere', () => {
  test('a phone gets the floating glass header', async () => {
    window = { width: 390, height: 844 }
    render(createElement(HuddleNotesScreen))

    const header = await waitForHeader()
    expect(header).not.toBeNull()
    expect(header!.className).toContain('absolute')
    expect(document.querySelector('button[aria-label="Back"]')).not.toBeNull()
  })

  test('a wide page keeps its bordered row and gets no phone header', async () => {
    window = { width: 1440, height: 900 }
    render(createElement(HuddleNotesScreen))

    expect(await screenText('Standup huddle')).toBe(true)
    expect(byTestId('phone-screen-header')).toBeNull()
    // The row's own Back control is still there — the thing a wide page lost
    // when this screen rendered the phone header unconditionally.
    expect(document.querySelector('button[aria-label="Back"]')).not.toBeNull()
  })
})

async function waitForHeader(): Promise<HTMLElement | null> {
  for (let i = 0; i < 50; i += 1) {
    const header = byTestId('phone-screen-header')
    if (header) return header
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  return null
}

async function screenText(text: string): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if ((document.body.textContent ?? '').includes(text)) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  return false
}
