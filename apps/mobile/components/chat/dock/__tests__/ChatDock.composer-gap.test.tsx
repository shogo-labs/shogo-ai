// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

mock.module('react-native', () => createReactNativeMock({ Platform: { OS: 'ios' } }))
mock.module('@legendapp/motion', () => ({
  Motion: {
    View: React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionView(
      { children },
      ref,
    ) {
      return React.createElement('div', { ref }, children as React.ReactNode)
    }),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const { createChatDockStore, ChatDockStoreContext } = await import('../../../../lib/chat-dock-store')
const { useDockPanel } = await import('../useDockPanel')
const { ChatDock } = await import('../ChatDock')

function DummyIcon() {
  return null
}

function DockHarness({
  kind = 'status',
  title = 'Error',
}: {
  kind?: 'status' | 'blocking'
  title?: string
}) {
  const store = React.useMemo(() => createChatDockStore(), [])
  const descriptor = React.useMemo(
    () => ({
      id: kind,
      kind,
      order: 1,
      title,
      icon: DummyIcon,
      defaultExpanded: true,
      render: () => <div>Connection interrupted. Reconnecting...</div>,
    }),
    [kind, title],
  )
  useDockPanel(descriptor, store)

  return (
    <ChatDockStoreContext.Provider value={store}>
      <ChatDock testID="chat-dock" />
    </ChatDockStoreContext.Provider>
  )
}

describe('ChatDock composer gap', () => {
  test('keeps error banners in the composer column, not over the pill', () => {
    const { container } = render(<DockHarness />)
    const dock = container.querySelector('[data-rn-shim="chat-dock"]')

    expect(dock).toBeTruthy()
    expect(dock?.getAttribute('class')).toBeNull()
    expect((dock as HTMLElement).style.position).not.toBe('absolute')
    expect((dock as HTMLElement).style.bottom).toBe('')
    expect((dock as HTMLElement).style.marginBottom).toBe('12px')
    expect((dock as HTMLElement).style.flexShrink).toBe('0')
    expect(screen.getByText('Error')).toBeTruthy()
    expect(screen.getByText('Connection interrupted. Reconnecting...')).toBeTruthy()
  })

  test('caps an expanded plan so the composer stays on screen', () => {
    render(<DockHarness kind="status" title="Plan" />)
    expect(screen.getByText('Plan')).toBeTruthy()
    expect(screen.getByText('Connection interrupted. Reconnecting...')).toBeTruthy()
  })
})
