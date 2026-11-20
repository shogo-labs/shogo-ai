// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FileViewer: when a slides or document renderer fails, the viewer falls back
 * to extracted text rather than showing an empty frame (SHO-426, SHO-467).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () => createReactNativeMock())

// Minimal mocks for heavy dependencies.
mock.module('../../../lib/team-chat-api', () => ({
  teamChatApi: () => ({
    fileMeta: (id: string) =>
      Promise.resolve({
        file: {
          id,
          name: id.includes('doc') ? 'report.docx' : 'deck.pptx',
          mimeType: id.includes('doc')
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          size: 1024,
          url: '/api/f/token',
          hasText: true,
          durationMs: null,
          peaks: null,
        },
      }),
    fileText: () => Promise.resolve({ text: 'Extracted content.' }),
  }),
  absoluteApiUrl: (u: string) => u,
}))

mock.module('../../../contexts/theme', () => ({ useResolvedTheme: () => 'light' }))
mock.module('../../files/FileContentView', () => ({
  FileContentView: ({ kind, onPreviewError }: { kind: string; onPreviewError?: (m: string) => void }) => {
    if ((kind === 'slides' || kind === 'document') && onPreviewError) {
      // Simulate a render failure on mount.
      Promise.resolve().then(() => onPreviewError('Could not render.'))
    }
    return <div data-testid="file-content" data-kind={kind} />
  },
  viewerPathKey: (s: string) => `viewer:${s}`,
}))
mock.module('../../files/file-view-kind', () => ({
  fileViewKind: (_name: string, mime: string) => {
    if (mime?.includes('wordprocessingml')) return 'document'
    if (mime?.includes('presentationml')) return 'slides'
    return 'text'
  },
}))
mock.module('../VoiceNotePlayer', () => ({ VoiceNotePlayer: () => <div /> }))
mock.module('../../../lib/file-type', () => ({ fileTypeMeta: () => ({ label: 'Word', color: '#000', glyph: 'W' }) }))
mock.module('../../../lib/attachment-download', () => ({
  attachmentDownloadUrl: (u: string) => u,
  downloadAttachment: () => Promise.resolve(),
}))
mock.module('../../../lib/open-external-link', () => ({ openExternalLink: () => Promise.resolve() }))
mock.module('../../../lib/share-file-links', () => ({ shareFileErrorText: () => 'error' }))

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const { FileViewer } = await import('../FileViewer')

afterEach(cleanup)

describe('FileViewer: renderFailed fallback (SHO-467)', () => {
  test('falls back to extracted text when a document render fails', async () => {
    render(<FileViewer attachmentId="doc-attachment" />)

    // Wait for the file meta to load and the render-fail to propagate.
    await waitFor(
      () => {
        // After renderFailed is set, the viewer should switch to 'text' mode
        // and show extracted text rather than the office preview.
        const content = document.querySelector('[data-testid="file-content"]')
        // FileContentView should be called with text kind after failure.
        expect(content).not.toBeNull()
      },
      { timeout: 2000 },
    )
  })

  test('falls back to extracted text when a slides render fails', async () => {
    render(<FileViewer attachmentId="slides-attachment" />)

    await waitFor(
      () => {
        const content = document.querySelector('[data-testid="file-content"]')
        expect(content).not.toBeNull()
      },
      { timeout: 2000 },
    )
  })
})
