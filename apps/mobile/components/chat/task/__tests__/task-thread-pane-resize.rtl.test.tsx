// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The task-thread pane is drag-resizable and remembers its width (SHO-569).
 *
 * `TaskThreadPaneHost` is mounted twice — beside the workspace agent chat and
 * beside the project chat's canvas — so the width, the 420 px floor and the
 * ceiling that keeps the chat column at 480 px all live in the host. The host
 * also reports its live width up (`onWidthChange`) because the workspace chat
 * clamps its own right-hand pane against it: the two panes share one row.
 */
import { afterEach, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

const STORAGE_KEY = 'shogo.taskThreadPaneWidth'

const target = { taskId: 'task-1', title: 'Background task', sessionId: 'session-1' }

mock.module('../../../../lib/task-thread-pane-store', () => ({
  useTaskThreadTarget: () => target,
  taskThreadPane: { close: () => {} },
}))

mock.module('../TaskThreadPane', () => ({
  TaskThreadPane: (props: { embedded?: boolean }) =>
    createElement('div', {
      'data-testid': 'task-thread-pane',
      'data-embedded': String(Boolean(props.embedded)),
    }),
}))

mock.module('../../../phone/NativePhoneSheet', () => ({
  NativePhoneSheet: (props: { children?: unknown }) =>
    createElement('div', { 'data-testid': 'native-phone-sheet' }, props.children as never),
}))

/** A DOM host that publishes a View's `style.width` so the pane can be measured. */
const host = (tag: string) => (props: any) => {
  const { testID, accessibilityLabel, children, className, style, onPointerDown } = props
  const width = Array.isArray(style) ? undefined : style?.width
  return createElement(
    tag,
    {
      'data-testid': testID,
      'aria-label': accessibilityLabel,
      className,
      'data-width': typeof width === 'number' ? String(width) : undefined,
      onPointerDown,
    },
    children,
  )
}

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
    View: host('div'),
  }),
)

const { cleanup, render, screen, within } = await import('@testing-library/react')
const { safeGetItem, safeRemoveItem, safeSetItem } = await import('../../../../lib/safe-storage')
const { TaskThreadPaneHost } = await import('../TaskThreadPaneHost')

afterEach(() => {
  cleanup()
  safeRemoveItem(STORAGE_KEY)
})

test('the task-thread pane carries a resize handle and takes its width from storage', () => {
  safeSetItem(STORAGE_KEY, '560')

  render(createElement(TaskThreadPaneHost))

  const pane = screen.getByTestId('task-thread-pane-host')
  expect(pane.getAttribute('data-width')).toBe('560')
  expect(within(pane).getByLabelText('Resize panel')).toBeInTheDocument()
})

test('with nothing saved it keeps 45% of the row the host was given', () => {
  // The project chat measures its own split row and passes it in; 45 % of 1200
  // is 540, not 45 % of a 1440 px window that still includes the app sidebar.
  render(createElement(TaskThreadPaneHost, { containerWidth: 1200 }))

  expect(screen.getByTestId('task-thread-pane-host').getAttribute('data-width')).toBe('540')
})

test('the pane leaves the chat column 480px and any sibling pane its width', () => {
  // 1200 − 480 chat − 500 for the workspace chat's open right-hand pane leaves
  // 220, below the 420 floor, so the floor wins.
  safeSetItem(STORAGE_KEY, '900')

  render(createElement(TaskThreadPaneHost, { containerWidth: 1200, reservedWidth: 500 }))

  expect(screen.getByTestId('task-thread-pane-host').getAttribute('data-width')).toBe('420')
})

test('it reports its live width up so the sibling pane can clamp against it', () => {
  const widths: (number | null)[] = []
  safeSetItem(STORAGE_KEY, '600')

  const { unmount } = render(
    createElement(TaskThreadPaneHost, { containerWidth: 1200, onWidthChange: (w: number | null) => widths.push(w) }),
  )

  expect(widths.at(-1)).toBe(600)

  // Closing the pane frees the row again: the screen may widen its own pane.
  unmount()
  expect(widths.at(-1)).toBeNull()
})
