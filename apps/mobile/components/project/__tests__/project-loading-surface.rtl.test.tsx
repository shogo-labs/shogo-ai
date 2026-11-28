// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-581 — opening a project draws the project, not a spinner.
 *
 * The card's symptom is the one SHO-580 fixed on the projects list, one tap
 * later: the body was replaced by a centred spinner until `GET
 * /api/projects/:id` answered. This renders the surface the screen now draws,
 * through the real `ProjectSurfaceHeader`, and asserts the states the card
 * names: the surface + skeleton while the row loads, the frame for a project
 * this device has never opened, and an error with a retry (never a spinner)
 * when the load failed. Since SHO-605 the runtime is not part of this wait:
 * the right panel draws `RuntimeStartingPane` for that (see
 * `runtime-starting-pane.rtl.test.tsx`), so this surface has no runtime phase.
 *
 *   bun test "apps/mobile/components/project/__tests__/project-loading-surface.rtl.test.tsx"
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act, createContext, createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

/** The onLayout each view was given, so a test can report a real layout. */
const layouts: Array<(event: unknown) => void> = []

const flatStyle = (style: any) =>
  Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style

const View = (props: Record<string, any>) => {
  const { children, onLayout, testID, style, ...rest } = props
  // Collect rather than drop: the surface pads its body from the header's
  // measured height, and a shim that swallowed `onLayout` hid a crash there
  // (QA on #2258 — `onHeight` takes a number, the inset hook takes an event).
  if (typeof onLayout === 'function') layouts.push(onLayout)
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

const rnOverrides = {
  View,
  Pressable,
  // A phone viewport: the surface draws the floating glass header, which is
  // where the project's name lives on a handset.
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  Platform: { ...(createReactNativeMock({}) as any).Platform, OS: 'web' },
} as unknown as Parameters<typeof createReactNativeMock>[0]
mock.module('react-native', () => createReactNativeMock(rnOverrides))

const INSETS = { top: 47, bottom: 34, left: 0, right: 0 }
mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: View,
  SafeAreaInsetsContext: createContext(INSETS),
}))

mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, canGoBack: () => true }),
  useLocalSearchParams: () => ({}),
}))

// The header reads the project's name from the collection; keep it empty so the
// name can only come from the cached row the surface was handed.
mock.module(resolve(import.meta.dir, '../../../contexts/domain'), () => ({
  useProjectCollection: () => ({ all: [] }),
}))

const { ProjectLoadingSurface } = await import('../ProjectLoadingSurface')
const { phoneScreenHeaderHeight } = await import('../../layout/PhoneScreenHeader')

const renderSurface = (props: Record<string, any> = {}) =>
  render(
    createElement(ProjectLoadingSurface, {
      projectId: 'p1',
      title: 'Atlas',
      onBack: () => {},
      ...props,
    }),
  )

beforeEach(() => {
  cleanup()
  layouts.length = 0
})

/** The header's own layout, as React Native would report it after a phone layout. */
const reportHeaderLayout = (height: number) =>
  act(() => [...layouts].forEach((onLayout) => onLayout({ nativeEvent: { layout: { height } } })))

describe('SHO-581 — project open draws its surface', () => {
  test('AC1: the name, the tab strip and the chat panel draw while the row loads', () => {
    renderSurface()

    // The surface itself, not a bare centred spinner.
    expect(screen.getByTestId('project-loading-surface')).toBeTruthy()
    expect(screen.getByTestId('project-loading-skeleton')).toBeTruthy()
    expect(screen.getByText('Loading project...')).toBeTruthy()
    // The name comes from the row the device already had.
    expect(screen.getAllByText('Atlas').length).toBeGreaterThan(0)
  })

  test('SHO-605: a booting runtime is not part of this wait any more', () => {
    renderSurface()

    expect(screen.getByText('Loading project...')).toBeTruthy()
    expect(screen.queryByText('Starting your project…')).toBeNull()
  })

  test('AC2: a project never opened on this device still draws the frame', () => {
    renderSurface({ title: null })

    expect(screen.getByTestId('project-loading-surface')).toBeTruthy()
    expect(screen.getByTestId('project-loading-skeleton')).toBeTruthy()
    expect(screen.getByText('Project')).toBeTruthy()
  })

  test('AC3: a failed load is an error with a retry, not a spinner', () => {
    const retries: number[] = []
    renderSurface({
      loadError: "The project didn't load. Check your connection and try again.",
      onRetryLoad: () => retries.push(1),
    })

    expect(screen.getByTestId('project-load-error')).toBeTruthy()
    expect(screen.getByText("We couldn't open this project")).toBeTruthy()
    expect(screen.queryByTestId('project-loading-skeleton')).toBeNull()
    expect(screen.queryByText('Loading project...')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Try loading the project again' }))
    expect(retries).toHaveLength(1)
  })

  test('the body sits under the glass header, measured or not (QA #2258 regression)', () => {
    renderSurface()

    // First frame: the safe area plus one header row, so the panel never starts
    // under the glass. `onHeight` reports a number, not a LayoutChangeEvent —
    // passing an event handler here crashed every phone-width project open.
    const body = screen.getByTestId('project-loading-body') as HTMLElement
    expect(phoneScreenHeaderHeight(INSETS.top)).toBe(97)
    expect(body.style.paddingTop).toBe('97px')

    reportHeaderLayout(120)
    expect(body.style.paddingTop).toBe('120px')
    // The frame survives the measurement: nothing is lost on re-render.
    expect(screen.getByTestId('project-loading-skeleton')).toBeTruthy()
  })
})
