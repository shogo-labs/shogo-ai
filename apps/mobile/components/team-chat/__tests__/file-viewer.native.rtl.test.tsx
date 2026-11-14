// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The same viewer on a phone, where the IDE's previews don't exist. A PDF keeps
 * its preview through the native PDF view, and anything that genuinely can't be
 * shown still offers its own download — the two things a host can quietly drop
 * when it hands the body to the shared view.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, useEffect, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import * as lucideStub from '../../../test/stubs/lucide-react-native'

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

mock.module('lucide-react-native', () => lucideStub)

const downloads: Array<{ url: string; name: string }> = []
mock.module(resolve(import.meta.dir, '../../../lib/attachment-download'), () => ({
  attachmentDownloadUrl: (url: string) => `${url}&dl=1`,
  downloadAttachment: async (url: string, name: string) => {
    downloads.push({ url, name })
  },
}))

mock.module('react-native-webview', () => ({
  default: ({ source, testID }: { source: { uri: string }; testID?: string }) =>
    createElement('div', { 'data-testid': testID, 'data-uri': source.uri }),
}))

mock.module(resolve(import.meta.dir, '../../project/panels/ide/CodeEditor'), () => ({
  CodeEditor: ({ value }: { value: string }) => createElement('div', { 'data-testid': 'code-editor' }, value),
}))

// The native Markdown body reaches the agent/auth graph, which wants a real
// window; this file only ever hands it the fallback's copy.
mock.module(resolve(import.meta.dir, '../../chat/MarkdownText'), () => ({
  MarkdownText: ({ children }: { children: string }) =>
    createElement('div', { 'data-testid': 'markdown-body' }, children),
}))

// The player is a native module (`expo-video`); the test only has to see what
// the viewer hands it, and to be able to make it fail.
let nativeVideoFails = false
mock.module(resolve(import.meta.dir, '../../chat/NativeVideoView'), () => ({
  default: ({ url, onError }: { url: string; onError?: () => void }) => {
    useEffect(() => {
      if (nativeVideoFails) onError?.()
    }, [onError])
    return createElement('div', { 'data-testid': 'native-video-view', 'data-uri': url })
  },
}))

mock.module(resolve(import.meta.dir, '../VoiceNotePlayer'), () => ({
  VoiceNotePlayer: () => createElement('div', { 'data-rn-shim': 'voice-note-player' }),
}))

const baseFile = {
  id: 'att-1',
  conversationId: 'conv-1',
  messageId: 'm-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  size: 8,
  width: null,
  height: null,
  durationMs: null,
  peaks: null,
  preview: null,
  createdAt: '2026-10-19T17:00:00.000Z',
  url: '/api/conversation-files/att-1?t=sig',
  hasText: true,
}

const files: Record<string, Partial<typeof baseFile>> = {
  video: { id: 'video', name: 'clip.mp4', mimeType: 'video/mp4', hasText: false },
  pdf: { id: 'pdf', name: 'report.pdf', mimeType: 'application/pdf', hasText: false },
  zip: { id: 'zip', name: 'bundle.zip', mimeType: 'application/zip', hasText: false },
}

const api = {
  fileMeta: async (id: string) => ({
    file: { ...baseFile, ...(files[id] ?? { id }) },
    conversation: { id: 'conv-1', name: 'general', kind: 'public' },
  }),
  fileText: async () => ({
    fileId: 'att-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    text: 'line one',
    offset: 0,
    totalChars: 8,
    nextOffset: null,
  }),
}

mock.module(resolve(import.meta.dir, '../../../lib/team-chat-api'), () => ({
  teamChatApi: () => api,
  absoluteApiUrl: (url: string) => url,
  message: async () => {
    throw Object.assign(new Error('HTTP 404'), { status: 404 })
  },
}))

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'ios' } as never,
    Pressable: (({
      children,
      onPress,
      disabled,
      testID,
      ...props
    }: {
      children?: ReactNode
      onPress?: () => void
      disabled?: boolean
      testID?: string
    }) =>
      createElement(
        'button',
        {
          ...props,
          'data-testid': testID,
          disabled,
          onClick: () => {
            if (!disabled) onPress?.()
          },
        },
        children,
      )) as never,
  }),
)

const { FileViewer } = await import('../FileViewer')

afterEach(() => {
  cleanup()
  downloads.length = 0
  nativeVideoFails = false
})

function query(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe('opening a shared file on a phone', () => {
  test('a PDF renders in the native PDF view instead of the fallback', async () => {
    render(createElement(FileViewer, { attachmentId: 'pdf' }))

    const frame = await waitFor(() => {
      const node = query('file-viewer-content')
      expect(node).not.toBeNull()
      return node!
    })
    expect(frame.getAttribute('data-uri')).toBe('/api/conversation-files/att-1?t=sig')
    expect(query('file-viewer-download')).toBeNull()
  })

  test('a video plays in the app\'s own player, streamed from its link', async () => {
    render(createElement(FileViewer, { attachmentId: 'video' }))

    // The lazy player resolves one tick later; what matters is that the link
    // goes to expo-video rather than to the "no preview, use Download" card
    // (SHO-387).
    const player = await waitFor(() => {
      const node = query('native-video-view')
      expect(node).not.toBeNull()
      return node!
    })
    expect(player.getAttribute('data-uri')).toBe('/api/conversation-files/att-1?t=sig')
    expect(screen.queryByText('No preview for this file type.')).toBeNull()
  })

  test('a video the player cannot show still offers its own download', async () => {
    nativeVideoFails = true
    render(createElement(FileViewer, { attachmentId: 'video' }))

    await screen.findByText('Could not play this video.')
    fireEvent.click(screen.getByText('Download'))

    await waitFor(() =>
      expect(downloads).toEqual([{ url: '/api/conversation-files/att-1?t=sig', name: 'clip.mp4' }]),
    )
  })

  test('a file nothing can show keeps the download card', async () => {
    render(createElement(FileViewer, { attachmentId: 'zip' }))

    await screen.findByText("This file can't be previewed here. Download it to open it in its own app.")
    fireEvent.click(screen.getByText('Download'))

    await waitFor(() =>
      expect(downloads).toEqual([{ url: '/api/conversation-files/att-1?t=sig', name: 'bundle.zip' }]),
    )
  })
})
