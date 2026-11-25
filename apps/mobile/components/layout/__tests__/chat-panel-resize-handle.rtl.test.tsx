// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The project chat's chat/canvas splitter restores the default chat width on a
 * double-click (SHO-576).
 *
 * The reset used to ride on `onDoubleClick`, which react-native-web never
 * forwards to a View, and `click`/`dblclick` cannot carry it either: the handle
 * appends a full-viewport overlay on pointerdown, so the overlay takes the
 * pointerup that would let the browser count a second click. The presses are
 * counted instead (`usePressCounter`), which is what these cases drive.
 */
import { afterEach, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

/** Only the pointer handlers react-native-web actually forwards are published. */
const host = (tag: string) => (props: any) => {
  const { accessibilityLabel, children, className, style, onPointerDown, onPointerEnter, onPointerLeave } = props
  const width = Array.isArray(style) ? undefined : style?.width
  return createElement(
    tag,
    {
      'aria-label': accessibilityLabel,
      className,
      'data-width': typeof width === 'number' ? String(width) : undefined,
      onPointerDown,
      onPointerEnter,
      onPointerLeave,
    },
    children,
  )
}

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    View: host('div'),
  } as any),
)

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ChatPanelResizeHandle } = await import('../ChatPanelResizeHandle')

const MIN = 320
const MAX = 720
const DEFAULT = 480

type Calls = { resized: number[]; ended: number[]; reset: number }

function renderHandle(width = DEFAULT) {
  const calls: Calls = { resized: [], ended: [], reset: 0 }
  // The handle measures the split row: 280px of history sidebar, then the chat.
  const container = document.createElement('div')
  container.getBoundingClientRect = () =>
    ({ left: 280, top: 0, right: 2000, bottom: 900, width: 1720, height: 900, x: 280, y: 0 } as DOMRect)
  const splitRowRef = { current: container as unknown as never }

  render(
    createElement(ChatPanelResizeHandle, {
      splitRowRef,
      chatPanelWidth: width,
      minWidth: MIN,
      maxWidth: MAX,
      onResize: (w: number) => calls.resized.push(w),
      onResizeEnd: (w: number) => calls.ended.push(w),
      onReset: () => {
        calls.reset += 1
      },
      leftOffset: 280,
    }),
  )

  return { calls, handle: screen.getByLabelText('Resize chat panel') }
}

afterEach(() => cleanup())

test('two press/release pairs restore the default width', () => {
  const { calls, handle } = renderHandle()

  fireEvent.pointerDown(handle, { clientX: 1040 })
  fireEvent.pointerUp(document)
  fireEvent.pointerDown(handle, { clientX: 1040 })

  expect(calls.reset).toBe(1)
  // A double-click is not a resize: it commits no width of its own.
  expect(calls.resized).toEqual([])
  expect(calls.ended).toEqual([])
})

test('a drag released in place is not the first half of a double-click', () => {
  const { calls, handle } = renderHandle()

  fireEvent.pointerDown(handle, { clientX: 1040 })
  fireEvent.pointerMove(document, { clientX: 900 })
  expect(calls.resized).toEqual([340])
  fireEvent.pointerUp(document)
  expect(calls.ended).toEqual([340])

  // Pressing straight after a drag starts a new drag; it never resets.
  fireEvent.pointerDown(handle, { clientX: 900 })
  expect(calls.reset).toBe(0)
})

test('a click carrying a couple of pixels of trackpad drift is still a click', () => {
  const { calls, handle } = renderHandle(560)

  fireEvent.pointerDown(handle, { clientX: 1040 })
  fireEvent.pointerMove(document, { clientX: 1038 })
  fireEvent.pointerUp(document)
  // 2px is tremor, not a drag: nothing resized, and the press counts as a click.
  expect(calls.resized).toEqual([])

  fireEvent.pointerDown(handle, { clientX: 1040 })
  expect(calls.reset).toBe(1)
})

test('the press that reset is consumed, so the next press starts a drag', () => {
  const { calls, handle } = renderHandle()

  fireEvent.pointerDown(handle, { clientX: 1040 })
  fireEvent.pointerUp(document)
  fireEvent.pointerDown(handle, { clientX: 1040 })
  fireEvent.pointerUp(document)
  expect(calls.reset).toBe(1)

  // Without clearing the counter, this third press would reset a second time.
  fireEvent.pointerDown(handle, { clientX: 1040 })
  expect(calls.reset).toBe(1)

  fireEvent.pointerMove(document, { clientX: 900 })
  fireEvent.pointerUp(document)
  expect(calls.ended).toEqual([340])
})
