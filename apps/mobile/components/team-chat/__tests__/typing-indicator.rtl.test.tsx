// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The "Ana is typing" line above the composer. What matters here: the label is
 * readable text, the three dots are decoration the screen reader never reads,
 * and the row still announces the full sentence.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

/** How many times a dot started its loop, so reduced motion can be asserted. */
const loops: { started: number; stopped: number } = { started: 0, stopped: 0 }
/** Flipped by a test to simulate the OS setting. */
const reducedMotion: { value: boolean } = { value: false }

mock.module('react-native', () =>
  createReactNativeMock({
    // Base Platform is already `OS: 'web'` with the full shape.
    View: (({ testID, accessibilityLabel, children, style }: any) =>
      createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel, style }, children)) as any,
    Text: (({ testID, accessibilityLabel, children, style }: any) =>
      createElement('span', { 'data-testid': testID, 'aria-label': accessibilityLabel, style }, children)) as any,
    Animated: {
      // The dot wrapper carries only opacity, so a plain div is enough.
      View: (({ testID, children, style }: any) =>
        createElement('div', { 'data-testid': testID, style }, children)) as any,
      loop: () => ({
        start: () => {
          loops.started += 1
        },
        stop: () => {
          loops.stopped += 1
        },
        reset: () => {},
      }),
      // Merged over the base's Animated, so only the parts a test cares about are here.
    } as any,
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module('../../../hooks/useReducedMotion', () => ({ useReducedMotion: () => reducedMotion.value }))

const { TypingIndicator } = await import('../TypingIndicator')

afterEach(() => {
  cleanup()
  loops.started = 0
  loops.stopped = 0
  reducedMotion.value = false
})

describe('TypingIndicator', () => {
  test('reads as a sentence and draws three dots beside it', () => {
    render(createElement(TypingIndicator, { label: 'Ana is typing', spoken: 'Ana is typing…' }))
    expect(screen.getByText('Ana is typing')).toBeTruthy()
    expect(screen.getByTestId('typing-dot-0')).toBeTruthy()
    expect(screen.getByTestId('typing-dot-1')).toBeTruthy()
    expect(screen.getByTestId('typing-dot-2')).toBeTruthy()
  })

  test('a screen reader gets the finished sentence, not the bare label', () => {
    render(createElement(TypingIndicator, { label: 'Ana is typing', spoken: 'Ana is typing…' }))
    expect(screen.getByLabelText('Ana is typing…')).toBeTruthy()
  })

  test('without a spoken override the label still ends in an ellipsis', () => {
    render(createElement(TypingIndicator, { label: 'Pat and Lee are typing' }))
    expect(screen.getByLabelText('Pat and Lee are typing…')).toBeTruthy()
  })

  test('the dots animate by default', () => {
    render(createElement(TypingIndicator, { label: 'Ana is typing' }))
    expect(loops.started).toBe(3)
  })

  test('reduced motion holds the dots still', () => {
    reducedMotion.value = true
    render(createElement(TypingIndicator, { label: 'Ana is typing' }))
    expect(loops.started).toBe(0)
    // Still three dots — the row looks the same, it just stops moving.
    expect(screen.getByTestId('typing-dot-2')).toBeTruthy()
  })

  test('leaving the timeline stops the loops it started', () => {
    const { unmount } = render(createElement(TypingIndicator, { label: 'Ana is typing' }))
    unmount()
    expect(loops.stopped).toBe(3)
  })
})
