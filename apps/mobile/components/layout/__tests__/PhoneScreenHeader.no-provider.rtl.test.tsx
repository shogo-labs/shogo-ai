// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A pane can be rendered on its own — a sheet, a viewer mounted outside the
 * navigator, a test tree — with no `SafeAreaProvider` above it. The header must
 * still draw (padded by the window's insets, or by none) instead of throwing the
 * safe-area library's "No safe area value available" error.
 *
 * Regression guard: the viewer's suites caught this as an unhandled error while
 * rendering, because `useSafeAreaInsets` throws where no provider is mounted.
 */
import { describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { createContext, createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const View = (props: Record<string, any>) => {
  const { children, testID, style, className, ...rest } = props
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style
  return createElement(
    'div',
    { ...rest, 'data-rn-shim': testID, style: flat, className },
    children as ReactNode,
  )
}

const Pressable = (props: Record<string, any>) => {
  const { children, onPress, accessibilityLabel, ...rest } = props
  return createElement(
    'button',
    { ...rest, 'aria-label': accessibilityLabel, onClick: onPress },
    children as ReactNode,
  )
}

const rnOverrides = { Pressable, View } as unknown as Parameters<typeof createReactNativeMock>[0]
mock.module('react-native', () => createReactNativeMock(rnOverrides))
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
// No provider and no window metrics: exactly the state `useSafeAreaInsets` throws on.
mock.module('react-native-safe-area-context', () => ({
  SafeAreaInsetsContext: createContext(null),
  initialWindowMetrics: null,
}))
mock.module(resolve(import.meta.dir, '../../ui/LiquidGlassBackdrop'), () => ({
  LiquidGlassBackdrop: () => null,
}))
mock.module(resolve(import.meta.dir, '../../chat/WebTooltip'), () => ({
  WebTooltip: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}))

const {
  PHONE_SCREEN_HEADER_TOP_GAP,
  PhoneScreenHeader,
  phoneScreenHeaderHeight,
  usePhoneScreenHeaderInset,
} = await import('../PhoneScreenHeader')

describe('PhoneScreenHeader without a SafeAreaProvider', () => {
  test('draws the header instead of throwing, padded by the gap alone', () => {
    render(createElement(PhoneScreenHeader, { title: 'Files', onBack: () => {} }))
    expect(screen.getByLabelText('Back')).toBeTruthy()
    const header = document.querySelector('[data-rn-shim="phone-screen-header"]') as HTMLElement
    expect(header).not.toBeNull()
    expect(header.style.paddingTop).toBe(`${PHONE_SCREEN_HEADER_TOP_GAP}px`)
  })

  test('the inset hook still pads by one row, so content clears the glass', () => {
    let inset: ReturnType<typeof usePhoneScreenHeaderInset> | null = null
    const Probe = () => {
      inset = usePhoneScreenHeaderInset()
      return createElement(View, { onLayout: inset.onLayout } as any)
    }
    render(createElement(Probe))
    expect(inset!.height).toBe(phoneScreenHeaderHeight(0))
    expect(phoneScreenHeaderHeight(0)).toBe(PHONE_SCREEN_HEADER_TOP_GAP + 44)
  })
})
