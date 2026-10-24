// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The viewer end of a shared file: it asks the metadata route what the file is
 * and renders it, and a file the server won't hand over gets a sentence rather
 * than a storage URL.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import * as lucideStub from '../../../test/stubs/lucide-react-native'

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// The shared stub, not a hand-picked subset: a partial mock here leaks into
// every other file in the same test process and takes its icons with it.
mock.module('lucide-react-native', () => lucideStub)

// Downloading reaches expo-file-system and the share sheet; the viewer only has
// to offer the button, so the press is recorded rather than performed.
const downloads: Array<{ url: string; name: string }> = []
mock.module(resolve(import.meta.dir, '../../../lib/attachment-download'), () => ({
  attachmentDownloadUrl: (url: string) => `${url}&dl=1`,
  downloadAttachment: async (url: string, name: string) => {
    downloads.push({ url, name })
  },
}))

// Monaco tries to load its AMD bundle under happy-dom; the body's job is to
// hand it the text, which the stub renders.
mock.module(resolve(import.meta.dir, '../../project/panels/ide/CodeEditor'), () => ({
  CodeEditor: ({ value }: { value: string }) => createElement('div', { 'data-testid': 'code-editor' }, value),
}))

mock.module(resolve(import.meta.dir, '../VoiceNotePlayer'), () => ({
  VoiceNotePlayer: () => createElement('div', { 'data-rn-shim': 'voice-note-player' }),
}))

const api = {
  fileMeta: async (id: string) => {
    if (id === 'gone') throw Object.assign(new Error('HTTP 404'), { status: 404 })
    if (id === 'zip') {
      return {
        file: { ...baseFile, id, name: 'bundle.zip', mimeType: 'application/zip', hasText: false },
        conversation: { id: 'conv-1', name: 'general', kind: 'public' },
      }
    }
    if (id === 'video') {
      return {
        file: { ...baseFile, id, name: 'clip.mp4', mimeType: 'application/octet-stream', hasText: false },
        conversation: { id: 'conv-1', name: 'general', kind: 'public' },
      }
    }
    return { file: { ...baseFile, id }, conversation: { id: 'conv-1', name: 'general', kind: 'public' } }
  },
  fileText: async () => ({ fileId: 'att-1', name: 'notes.txt', mimeType: 'text/plain', text: 'line one', offset: 0, totalChars: 8, nextOffset: null }),
}

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

mock.module(resolve(import.meta.dir, '../../../lib/team-chat-api'), () => ({
  teamChatApi: () => api,
  absoluteApiUrl: (url: string) => url,
  // This replacement is process-wide, so keep the rest of the surface a sibling
  // suite in the same run expects; nothing here calls it.
  message: async () => {
    throw Object.assign(new Error('HTTP 404'), { status: 404 })
  },
}))

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: (({ children, onPress, disabled, testID, ...props }: {
      children?: ReactNode
      onPress?: () => void
      disabled?: boolean
      testID?: string
    }) =>
      createElement(
        'button',
        { ...props, 'data-rn-shim': testID, disabled, onClick: () => { if (!disabled) onPress?.() } },
        children,
      )) as never,
  }),
)

const { FileViewer } = await import('../FileViewer')

afterEach(cleanup)

describe('opening a shared file', () => {
  test('renders a text file’s own text', async () => {
    render(createElement(FileViewer, { attachmentId: 'att-1' }))

    await screen.findByText('line one')
    expect(screen.getByText('line one')).toBeDefined()
  })

  test('plays a video, even when the server only says octet-stream', async () => {
    const { container } = render(createElement(FileViewer, { attachmentId: 'video' }))

    const video = await waitFor(() => {
      const node = container.querySelector('video')
      expect(node).not.toBeNull()
      return node!
    })
    expect(video.getAttribute('src')).toBe('/api/conversation-files/att-1?t=sig')
  })

  test('offers a download for a file nothing can show', async () => {
    render(createElement(FileViewer, { attachmentId: 'zip' }))

    await screen.findByText("This file can't be previewed here. Download it to open it in its own app.")
    expect(screen.getByText('bundle.zip')).toBeDefined()
    expect(screen.getByText('Download')).toBeDefined()
  })

  test('a file it may not open says so, without a storage URL', async () => {
    const { container } = render(createElement(FileViewer, { attachmentId: 'gone' }))

    await screen.findByText(/This file isn't available/)
    expect(container.textContent).not.toContain('/api/conversation-files')
  })
})
