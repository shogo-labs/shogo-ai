// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A file in the conversation's Files tab opens in the app's own viewer. On web
 * `Linking.openURL` is `window.open(..., '_blank')`, so the row must ask the
 * nearest share-file opener instead of navigating to the API (SHO-80).
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import type { ConversationFile } from '../../../lib/team-chat-api'

const openedUrls: string[] = []
const downloads: string[] = []

const file: ConversationFile = {
  id: 'att-1',
  conversationId: 'conv-1',
  messageId: 'm-1',
  threadRootId: null,
  name: 'Q4 forecast.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  kind: 'document',
  size: 20_480,
  width: null,
  height: null,
  uploadedBy: { id: 'u-russell', name: 'Russell' },
  createdAt: '2026-10-19T18:00:00.000Z',
  url: '/api/conversation-files/att-1?t=sig',
}

mock.module(resolve(import.meta.dir, '../../../lib/attachment-download'), () => ({
  attachmentDownloadUrl: (url: string) => url,
  downloadAttachment: async (_url: string, name: string) => {
    downloads.push(name)
  },
}))

// The real shared-ui pulls in react-native by a path the preload's shim does
// not cover; only `cn` is needed here.
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

mock.module(resolve(import.meta.dir, '../../../hooks/useConversationFiles'), () => ({
  useConversationFiles: () => ({
    files: [file],
    loading: false,
    loadingMore: false,
    error: null as string | null,
    hasMore: false,
    loadMore: async () => {},
  }),
}))

// The shim renders hosts as real DOM, so a list has to draw its own rows and a
// press has to be clickable with the label it exposes to a screen reader.
const FlatList = ({ data, renderItem, keyExtractor }: Record<string, any>) =>
  createElement(
    'div',
    null,
    (data ?? []).map((item: unknown, index: number) =>
      createElement(
        'div',
        { key: keyExtractor ? keyExtractor(item) : index },
        renderItem({ item, index }),
      ),
    ),
  )

const Pressable = ({ onPress, accessibilityLabel, children }: Record<string, any>) =>
  createElement('button', { n: accessibilityLabel, onClick: onPress }, children as ReactNode)

const rn = createReactNativeMock({ FlatList, Pressable })
rn.Linking = {
  openURL: (url: string) => {
    openedUrls.push(url)
    return Promise.resolve()
  },
} as unknown as typeof rn.Linking
mock.module('react-native', () => rn)

const { FilesPane } = await import('../FilesPane')
const { ShareFileProvider } = await import('../../chat/share-file-context')
const { absoluteApiUrl } = await import('../../../lib/team-chat-api')

afterEach(() => {
  cleanup()
  openedUrls.length = 0
  downloads.length = 0
})

function renderPane(opened: Array<Record<string, unknown>>) {
  return render(
    <ShareFileProvider open={(target) => opened.push(target as Record<string, unknown>)}>
      <FilesPane
        workspaceId="ws-1"
        conversationId="conv-1"
        title="#shogo-dev"
        onClose={() => {}}
        onShowInChat={() => {}}
      />
    </ShareFileProvider>,
  ).container
}

describe('the conversation Files tab', () => {
  test('opens a shared file in the app, not in a browser tab', () => {
    const opened: Array<Record<string, unknown>> = []
    const container = renderPane(opened)

    fireEvent.click(container.querySelector('[n="Open Q4 forecast.xlsx"]') as HTMLElement)

    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      kind: 'stored',
      href: absoluteApiUrl(file.url),
      name: 'Q4 forecast.xlsx',
    })
    expect(openedUrls).toEqual([])
  })

  test('download still saves the file and opens nothing', () => {
    const opened: Array<Record<string, unknown>> = []
    const container = renderPane(opened)

    fireEvent.click(container.querySelector('[n="Download Q4 forecast.xlsx"]') as HTMLElement)

    expect(downloads).toEqual(['Q4 forecast.xlsx'])
    expect(opened).toEqual([])
  })
})
