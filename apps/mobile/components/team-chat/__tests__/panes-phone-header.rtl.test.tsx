// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A pane opened full-screen on a phone is a screen you go into: it gets the
 * DM's floating glass header (SHO-490). Beside the timeline on a wide screen it
 * keeps its compact bordered `PaneHeader`, which is the desktop standard.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { createContext, createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const View = (props: Record<string, any>) => {
  const { children, testID, style, ...rest } = props
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style
  return createElement(
    'div',
    { ...rest, 'data-rn-shim': testID, style: flat, className: props.className },
    children as ReactNode,
  )
}

const Pressable = (props: Record<string, any>) => {
  const { children, onPress, accessibilityLabel, disabled } = props
  return createElement(
    'button',
    { 'data-rn-shim': props.testID, 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress },
    children as ReactNode,
  )
}

const FlatList = ({ data, renderItem, ListEmptyComponent, keyExtractor }: Record<string, any>) =>
  createElement(
    'div',
    null,
    (data ?? []).length
      ? (data ?? []).map((item: unknown, index: number) =>
          createElement('div', { key: keyExtractor ? keyExtractor(item) : index }, renderItem({ item, index })),
        )
      : ListEmptyComponent ?? null,
  )

// The shims stand in for host components, so the override slot — typed
// against the real ones — takes one explicit cast rather than a wider mock.
const rnOverrides = { View, Pressable, FlatList } as unknown as Parameters<typeof createReactNativeMock>[0]
mock.module('react-native', () => createReactNativeMock(rnOverrides))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
const INSETS = { top: 47, bottom: 34, left: 0, right: 0 }
// The header reads the inset context (and never throws without a provider), so
// the mock supplies one carrying a phone's insets.
mock.module('react-native-safe-area-context', () => ({
  SafeAreaInsetsContext: createContext(INSETS),
}))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, setParams: () => {}, back: () => {}, canGoBack: () => false }),
}))
mock.module('expo-clipboard', () => ({ setStringAsync: async () => true }))
mock.module(resolve(import.meta.dir, '../../ui/LiquidGlassBackdrop'), () => ({ LiquidGlassBackdrop: () => null }))
mock.module(resolve(import.meta.dir, '../../chat/WebTooltip'), () => ({
  WebTooltip: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}))
mock.module(resolve(import.meta.dir, '../../../lib/attachment-download'), () => ({
  attachmentDownloadUrl: (url: string) => url,
  downloadAttachment: async () => {},
}))
mock.module(resolve(import.meta.dir, '../../../hooks/useConversationFiles'), () => ({
  useConversationFiles: () => ({
    files: [],
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    loadMore: async () => {},
  }),
}))
mock.module(resolve(import.meta.dir, '../../chat/MarkdownText'), () => ({
  MarkdownText: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))
mock.module(resolve(import.meta.dir, '../../../hooks/useConversationDoc'), () => ({
  useConversationDoc: () => ({
    state: {
      loaded: true,
      server: { title: 'DevOps Schedule', content: 'Intro', version: 3, locked: false, updatedBy: null, updatedAt: new Date().toISOString() },
      draft: null,
      saving: null,
      conflict: null,
      error: null,
      canManage: true,
    },
    doc: { title: 'DevOps Schedule', content: 'Intro' },
    dirty: false,
    edit: () => {},
    flush: async () => {},
    resolve: () => {},
    setLocked: async () => {},
    restore: async () => {},
    archiveSection: async () => {},
    restoreArchive: async () => {},
  }),
}))

const { FilesPane } = await import('../FilesPane')
const { DocPane } = await import('../DocPane')

const byTestId = (id: string) => document.querySelector(`[data-rn-shim="${id}"]`) as HTMLElement | null

const conversation = {
  id: 'conv-1',
  workspaceId: 'ws-1',
  kind: 'public',
  name: 'dev',
  members: [],
  starred: false,
} as any

afterEach(() => cleanup())

describe('a phone pane wears the floating glass header', () => {
  test('FilesPane', () => {
    render(
      createElement(FilesPane, {
        workspaceId: 'ws-1',
        conversationId: 'conv-1',
        title: '#dev',
        onClose: () => {},
        onShowInChat: () => {},
        floating: true,
      }),
    )
    expect(byTestId('phone-screen-header')).not.toBeNull()
    expect(byTestId('phone-screen-header')!.className).toContain('absolute')
    expect(document.querySelector('button[aria-label="Close files"]')).not.toBeNull()
  })

  test('DocPane', () => {
    render(
      createElement(DocPane, {
        conversation,
        workspaceId: 'ws-1',
        mentionables: null,
        onClose: () => {},
        floating: true,
      }),
    )
    expect(byTestId('phone-screen-header')).not.toBeNull()
    expect(document.querySelector('button[aria-label="Close doc"]')).not.toBeNull()
  })
})

describe('the same panes beside the timeline keep the desktop header', () => {
  test('FilesPane keeps its own bordered row', () => {
    render(
      createElement(FilesPane, {
        workspaceId: 'ws-1',
        conversationId: 'conv-1',
        title: '#dev',
        onClose: () => {},
        onShowInChat: () => {},
      }),
    )
    expect(byTestId('phone-screen-header')).toBeNull()
    expect(document.body.textContent).toContain('Files in #dev')
  })

  test('DocPane keeps its own bordered row', () => {
    render(
      createElement(DocPane, { conversation, workspaceId: 'ws-1', mentionables: null, onClose: () => {} }),
    )
    expect(byTestId('phone-screen-header')).toBeNull()
    expect(document.body.textContent).toContain('DevOps Schedule')
  })
})
