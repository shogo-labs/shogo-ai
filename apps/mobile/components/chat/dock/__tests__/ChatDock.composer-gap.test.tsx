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

function DockHarness() {
  const store = React.useMemo(() => createChatDockStore(), [])
  const descriptor = React.useMemo(
    () => ({
      id: 'status',
      kind: 'blocking' as const,
      order: 1,
      title: 'Status',
      icon: DummyIcon,
      render: () => <div>Banner</div>,
    }),
    [],
  )
  useDockPanel(descriptor, store)

  return (
    <ChatDockStoreContext.Provider value={store}>
      <ChatDock testID="chat-dock" />
    </ChatDockStoreContext.Provider>
  )
}

describe('ChatDock composer gap', () => {
  test('keeps status banners above the native composer pill', () => {
    const { container } = render(<DockHarness />)
    const dock = container.querySelector('[data-rn-shim="chat-dock"]')

    expect(dock).toBeTruthy()
    expect(dock).toHaveStyle({ paddingBottom: 12 })
    expect(screen.getByText('Banner')).toBeTruthy()
  })
})
