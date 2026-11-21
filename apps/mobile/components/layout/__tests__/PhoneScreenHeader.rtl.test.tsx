// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The phone navigation standard (SHO-490): one floating glass header — Back (or
 * Close for a pane), a glass title pill, glass trailing actions — with nothing
 * behind it, so the screen's content scrolls under the glass.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act, createContext, createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

/** The onLayout each header view was given, so the test can report a height. */
const layouts: Array<(event: unknown) => void> = []

const View = (props: Record<string, any>) => {
  const { children, onLayout, testID, style, ...rest } = props
  if (typeof onLayout === 'function') layouts.push(onLayout)
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style
  return createElement(
    'div',
    { ...rest, 'data-rn-shim': testID, style: flat, className: props.className },
    children as ReactNode,
  )
}

const Pressable = (props: Record<string, any>) => {
  const { children, onPress, accessibilityLabel, disabled, style, ...rest } = props
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style
  return createElement(
    'button',
    {
      ...rest,
      'data-rn-shim': props.testID,
      'aria-label': accessibilityLabel,
      onClick: disabled ? undefined : onPress,
      style: { width: flat?.width, height: flat?.height },
    },
    children as ReactNode,
  )
}

// The shims stand in for host components, so the override slot — typed
// against the real ones — takes one explicit cast rather than a wider mock.
const rnOverrides = { Pressable, View } as unknown as Parameters<typeof createReactNativeMock>[0]
mock.module('react-native', () => createReactNativeMock(rnOverrides))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
const INSETS = { top: 47, bottom: 34, left: 0, right: 0 }
// The header reads the inset context (and never throws without a provider), so
// the mock supplies one carrying a phone's insets.
mock.module('react-native-safe-area-context', () => ({
  SafeAreaInsetsContext: createContext(INSETS),
}))
mock.module(resolve(import.meta.dir, '../../ui/LiquidGlassBackdrop'), () => ({
  LiquidGlassBackdrop: () => null,
}))
mock.module(resolve(import.meta.dir, '../../chat/WebTooltip'), () => ({
  WebTooltip: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}))

const { PhoneScreenHeader, usePhoneScreenHeaderInset, phoneScreenHeaderHeight } = await import(
  '../PhoneScreenHeader'
)

const byTestId = (id: string) => document.querySelector(`[data-rn-shim="${id}"]`) as HTMLElement | null

beforeEach(() => {
  cleanup()
  layouts.length = 0
})

describe('PhoneScreenHeader', () => {
  test('floats over the content, below the status bar, with nothing behind it', () => {
    render(createElement(PhoneScreenHeader, { title: 'Notifications', onBack: () => {} }))
    const header = byTestId('phone-screen-header')
    expect(header).not.toBeNull()
    // Absolute over the content, and no bar: no fill, no border.
    expect(header!.className).toContain('absolute')
    expect(header!.className).toContain('px-3')
    expect(header!.className).not.toContain('bg-')
    expect(header!.className).not.toContain('border')
    expect(header!.style.paddingTop).toBe('53px') // 47pt safe area + 6
  })

  test('Back is the 44px glass button, and it calls onBack', () => {
    let back = 0
    render(createElement(PhoneScreenHeader, { title: 'Chats', onBack: () => back++ }))
    const control = screen.getByLabelText('Back') as HTMLElement
    expect(control.style.width).toBe('44px')
    expect(control.style.height).toBe('44px')
    expect(control.className).toContain('rounded-full')
    fireEvent.click(control)
    expect(back).toBe(1)
  })

  test('a pane gets a glass Close instead of Back, labelled by the pane', () => {
    let closed = 0
    render(
      createElement(PhoneScreenHeader, {
        title: 'Files in #dev',
        closeLabel: 'Close files',
        closeTestID: 'files-close',
        onClose: () => closed++,
      }),
    )
    expect(screen.queryByLabelText('Back')).toBeNull()
    fireEvent.click(screen.getByLabelText('Close files'))
    expect(closed).toBe(1)
    expect(byTestId('files-close')).not.toBeNull()
  })

  test('the title pill is glass, states the title and subtitle, and is tappable when asked', () => {
    let pressed = 0
    render(
      createElement(PhoneScreenHeader, {
        title: 'Design review',
        subtitle: '3 members',
        titleLabel: 'Design review details',
        onTitlePress: () => pressed++,
      }),
    )
    const pill = screen.getByLabelText('Design review details')
    expect(pill.className).toContain('rounded-full')
    expect(pill.className).toContain('overflow-hidden')
    expect(pill.textContent).toContain('Design review')
    expect(pill.textContent).toContain('3 members')
    fireEvent.click(pill)
    expect(pressed).toBe(1)
  })

  test('a pill with no handler is a plain label, not a button', () => {
    render(createElement(PhoneScreenHeader, { title: 'Starred', onBack: () => {} }))
    expect(byTestId('phone-screen-header-title')!.getAttribute('role')).toBeNull()
  })

  test('trailing actions render on the right', () => {
    render(
      createElement(PhoneScreenHeader, {
        title: 'Chats',
        onBack: () => {},
        actions: createElement('button', { 'aria-label': 'New chat' }, '+'),
      }),
    )
    expect(screen.getByLabelText('New chat')).toBeTruthy()
  })

  test('onLayout reports the measured height, so the screen pads under the glass', () => {
    const heights: number[] = []
    render(
      createElement(PhoneScreenHeader, {
        title: 'Chats',
        onBack: () => {},
        onLayout: (event: any) => heights.push(Math.round(event.nativeEvent.layout.height)),
      }),
    )
    act(() => [...layouts].forEach((onLayout) => onLayout({ nativeEvent: { layout: { height: 97 } } })))
    expect(heights).toEqual([97])
  })

  test('the inset hook starts at the unmeasured height, never at zero', () => {
    let inset: ReturnType<typeof usePhoneScreenHeaderInset> | null = null
    const Probe = () => {
      inset = usePhoneScreenHeaderInset()
      return createElement(View, { onLayout: inset.onLayout } as any)
    }
    render(createElement(Probe))
    // Before the first measurement: the safe area plus one 44pt row, so content
    // never jumps up under the glass on the first frame.
    expect(inset!.height).toBe(phoneScreenHeaderHeight(47))
    expect(phoneScreenHeaderHeight(47)).toBe(97)
    expect(typeof inset!.onLayout).toBe('function')
  })
})
