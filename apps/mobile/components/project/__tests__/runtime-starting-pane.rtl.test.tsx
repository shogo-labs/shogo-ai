// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-605 — the right panel while a project runtime boots.
 *
 * The whole page used to wait for `/sandbox/url`; now only the panels that
 * take `agentUrl` wait, and this pane stands in for them. These tests pin the
 * two things the page relies on: the booting/remote decision (a remote
 * instance never shows the pane) and the recovery UI (stalled or errored
 * boots keep their capacity card / retry card instead of an endless spinner).
 *
 *   bun test "apps/mobile/components/project/__tests__/runtime-starting-pane.rtl.test.tsx"
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createContext, createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

/**
 * RN-web shims that keep `testID` and `accessibilityLabel` addressable the way
 * the app's other surface tests do: `testID` → `data-testid`, `onPress` →
 * `click`, `accessibilityLabel` → `aria-label`.
 */
const flatStyle = (style: any) =>
  Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style

const View = (props: Record<string, any>) => {
  const { children, testID, style, ...rest } = props
  return createElement(
    'div',
    { ...rest, 'data-rn-shim': testID, 'data-testid': testID, style: flatStyle(style) },
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

mock.module('react-native', () =>
  createReactNativeMock({ View, Pressable } as unknown as Parameters<
    typeof createReactNativeMock
  >[0]),
)

mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaView: ({ children }: any) => createElement('div', null, children),
  SafeAreaProvider: ({ children }: any) => createElement('div', null, children),
  SafeAreaConsumer: ({ children }: any) =>
    children({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaInsetsContext: createContext(null),
  initialWindowMetrics: null,
}))

mock.module('expo-router', () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    canGoBack: () => true,
  }),
}))

const { RuntimeStartingPane, isRuntimeBooting } = await import(
  '../RuntimeStartingPane'
)

const renderPane = (props: Record<string, any> = {}) =>
  render(
    createElement(RuntimeStartingPane, {
      onRetry: () => {},
      onBack: () => {},
      onOpenWeb: () => {},
      ...props,
    }),
  )

beforeEach(() => {
  cleanup()
})

describe('SHO-605 — isRuntimeBooting', () => {
  test('a local runtime that is not ready is booting', () => {
    expect(isRuntimeBooting({ remoteAgentBaseUrl: null, runtimeReady: false })).toBe(true)
  })

  test('a ready runtime is not booting', () => {
    expect(isRuntimeBooting({ remoteAgentBaseUrl: null, runtimeReady: true })).toBe(false)
  })

  test('AC4: a remote instance renders as today — never the pane', () => {
    expect(
      isRuntimeBooting({
        remoteAgentBaseUrl: 'http://127.0.0.1:4141/api/projects/p1/agent-proxy',
        runtimeReady: false,
      }),
    ).toBe(false)
  })
})

describe('SHO-605 — RuntimeStartingPane', () => {
  test('AC2: a booting runtime says so and draws no recovery UI', () => {
    renderPane()

    expect(screen.getByTestId('runtime-starting-pane')).toBeTruthy()
    expect(screen.getByText('Starting your project…')).toBeTruthy()
    expect(screen.queryByText('This is taking longer than expected')).toBeNull()
  })

  test('AC2: a stalled boot keeps Try again / Go back / Open on web', () => {
    const calls: string[] = []
    renderPane({
      stalled: true,
      onRetry: () => calls.push('retry'),
      onBack: () => calls.push('back'),
      onOpenWeb: () => calls.push('web'),
    })

    expect(screen.getByText('This is taking longer than expected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry connecting to your project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go back to projects list' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open this project on the web' }))
    expect(calls).toEqual(['retry', 'back', 'web'])
  })

  test('an error names the last runtime status instead of "warming up"', () => {
    renderPane({ error: 'connection refused', lastStatus: 'starting' })

    expect(
      screen.getByText(
        "We couldn't reach your project's runtime (starting). Check your connection or try again.",
      ),
    ).toBeTruthy()
  })

  test('a workspace out of compute room shows the capacity card', () => {
    renderPane({
      stalled: true,
      capacity: {
        message: 'All 2 GB of your workspace compute is in use.',
        instanceSize: 'small',
        instanceLabel: 'Small',
        budgetGb: 2,
        runningCount: 2,
        projects: [{ id: 'p1', name: 'Atlas' }],
        canUpgrade: false,
      },
    })

    expect(
      screen.getByText('Your workspace is out of room for running projects'),
    ).toBeTruthy()
    expect(screen.queryByText('This is taking longer than expected')).toBeNull()
  })
})
