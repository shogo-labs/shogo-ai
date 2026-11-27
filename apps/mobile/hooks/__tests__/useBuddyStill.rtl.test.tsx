// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-600: the buddy must hold a single frame whenever it cannot be seen.
 *
 * On iOS the buddy is a WKWebView. It keeps drawing while its screen is buried
 * under another one (Home sits in the stack behind every channel) and after the
 * app is backgrounded, because WKWebView never reports either as hidden. The
 * host therefore says so: `still` while the screen is not focused, while the
 * app is not active, and whenever Reduce Motion is on.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../test/react-native-mock'

let focused = true
let appState = 'active'
let reduceMotion = false
let appStateListener: ((state: string) => void) | null = null
let reduceMotionListener: ((enabled: boolean) => void) | null = null

mock.module('expo-router', () => ({ useIsFocused: () => focused }))

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    AppState: {
      get currentState() {
        return appState
      },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appStateListener = listener
        return { remove: () => { appStateListener = null } }
      },
    },
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(reduceMotion),
      addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
        reduceMotionListener = listener
        return { remove: () => { reduceMotionListener = null } }
      },
    },
  }),
)

const { useBuddyStill } = await import('../useBuddyStill')

function Probe() {
  return createElement('span', { 'data-testid': 'still' }, String(useBuddyStill()))
}

const still = () => screen.getByTestId('still').textContent === 'true'

beforeEach(() => {
  focused = true
  appState = 'active'
  reduceMotion = false
  appStateListener = null
  reduceMotionListener = null
})

describe('useBuddyStill', () => {
  test('animates only while the screen is on top and the app is in front', async () => {
    const { rerender } = render(createElement(Probe))
    await act(async () => {})
    expect(still()).toBe(false)

    focused = false
    act(() => rerender(createElement(Probe)))
    expect(still()).toBe(true)

    focused = true
    act(() => rerender(createElement(Probe)))
    expect(still()).toBe(false)

    act(() => appStateListener?.('background'))
    expect(still()).toBe(true)

    act(() => appStateListener?.('active'))
    expect(still()).toBe(false)
  })

  test('honours Reduce Motion', async () => {
    reduceMotion = true
    render(createElement(Probe))
    // The accessibility query is async, so the first frame is optimistic.
    await act(async () => {})
    expect(still()).toBe(true)

    act(() => reduceMotionListener?.(false))
    expect(still()).toBe(false)
  })
})
