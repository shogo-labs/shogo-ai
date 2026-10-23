// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-111 acceptance: selection state reaches the DOM on web.
 *
 * `react-native-web` 0.21 has no `accessibilityState` → `aria-*` mapping, so a
 * radio rendered `role="radio"` with no checked state at all. This suite runs
 * against the real `react-native-web` and asserts the four states the card
 * converted end up as DOM attributes, so an upgrade that drops one of them
 * fails here instead of in a screen reader.
 *
 * The last case pins the bug itself: `accessibilityState` is still ignored, so
 * the `aria-*` prop is the only idiom that ships state to the browser.
 */
import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import * as React from 'react'
import * as ReactNativeWeb from 'react-native-web'

mock.module('react-native', () => ReactNativeWeb)

const { Pressable } = ReactNativeWeb

describe('react-native-web turns aria state into DOM state', () => {
  test('a radio publishes both checked values', () => {
    render(
      <>
        <Pressable role="radio" accessibilityLabel="selected row" aria-checked={true} />
        <Pressable role="radio" accessibilityLabel="unselected row" aria-checked={false} />
      </>,
    )
    expect(screen.getByLabelText('selected row').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('unselected row').getAttribute('aria-checked')).toBe('false')
  })

  test('a tab publishes aria-selected', () => {
    render(
      <>
        <Pressable role="tab" accessibilityLabel="active tab" aria-selected={true} />
        <Pressable role="tab" accessibilityLabel="inactive tab" aria-selected={false} />
      </>,
    )
    expect(screen.getByLabelText('active tab').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText('inactive tab').getAttribute('aria-selected')).toBe('false')
  })

  test('an expandable section publishes aria-expanded', () => {
    render(
      <>
        <Pressable role="button" accessibilityLabel="open section" aria-expanded={true} />
        <Pressable role="button" accessibilityLabel="closed section" aria-expanded={false} />
      </>,
    )
    expect(screen.getByLabelText('open section').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('closed section').getAttribute('aria-expanded')).toBe('false')
  })

  test('a busy control publishes aria-busy', () => {
    render(<Pressable role="button" accessibilityLabel="busy control" aria-busy={true} />)
    expect(screen.getByLabelText('busy control').getAttribute('aria-busy')).toBe('true')
  })

  test('accessibilityState is still dropped on web — why the aria props exist', () => {
    render(
      <Pressable
        role="radio"
        accessibilityLabel="legacy state"
        {...({ accessibilityState: { checked: true, selected: true } } as any)}
      />,
    )
    const el = screen.getByLabelText('legacy state')
    expect(el.getAttribute('aria-checked')).toBe(null)
    expect(el.getAttribute('aria-selected')).toBe(null)
  })
})
