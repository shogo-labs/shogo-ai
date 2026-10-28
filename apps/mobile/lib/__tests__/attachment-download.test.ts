// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Saving a chat file. The URL has to ask for the download (the route serves
 * pictures, video, audio and PDFs `inline` so they can be previewed), and the
 * browser has to be handed a link that names the file.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('react-native', () => ({
  Platform: { OS: 'web' },
  Linking: { openURL: async () => undefined },
  InteractionManager: { runAfterInteractions: (task: () => void) => task() },
}))

const { attachmentDownloadUrl, downloadAttachment } = await import('../attachment-download')

const anchors: HTMLAnchorElement[] = []
const clicked: string[] = []

beforeEach(() => {
  anchors.length = 0
  clicked.length = 0
  const createElement = document.createElement.bind(document)
  document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = createElement(tagName, options)
    if (tagName.toLowerCase() === 'a') {
      const anchor = element as HTMLAnchorElement
      // jsdom would otherwise try to navigate on click.
      anchor.click = () => {
        clicked.push(anchor.href)
      }
      anchors.push(anchor)
    }
    return element
  }) as typeof document.createElement
})

afterEach(() => {
  // @ts-expect-error handing the original back
  delete document.createElement
})

describe('asking the route for a download', () => {
  test('adds the flag to a capability URL, keeping its token', () => {
    expect(attachmentDownloadUrl('https://api.test/api/conversation-files/att-1?t=sig')).toBe(
      'https://api.test/api/conversation-files/att-1?t=sig&dl=1',
    )
  })

  test('uses a query separator when the URL has none', () => {
    expect(attachmentDownloadUrl('https://api.test/api/conversation-files/att-1')).toBe(
      'https://api.test/api/conversation-files/att-1?dl=1',
    )
  })

  test('does not add the flag twice', () => {
    const once = attachmentDownloadUrl('https://api.test/api/conversation-files/att-1?t=sig')
    expect(attachmentDownloadUrl(once)).toBe(once)
  })

  test('keeps a fragment at the end, where it belongs', () => {
    expect(attachmentDownloadUrl('https://api.test/file?t=sig#page=2')).toBe('https://api.test/file?t=sig&dl=1#page=2')
  })
})

describe('handing the file to the browser', () => {
  test('clicks a link that names the file, so it is saved and not opened', async () => {
    await downloadAttachment('https://api.test/api/conversation-files/att-1?t=sig', 'EM Onboarding Guide - KM.pptx')

    expect(clicked).toHaveLength(1)
    expect(clicked[0]).toBe('https://api.test/api/conversation-files/att-1?t=sig&dl=1')
    expect(anchors[0]?.download).toBe('EM Onboarding Guide - KM.pptx')
    // Nothing is left behind in the page.
    expect(document.querySelector('a[download]')).toBe(null)
  })

  test('saves under the file name alone, not a path from elsewhere', async () => {
    await downloadAttachment('https://api.test/api/conversation-files/att-2?t=sig', 'conversations/ws-1/conv-1/report.pdf')
    expect(anchors[0]?.download).toBe('report.pdf')
  })

  test('falls back to a usable name when the file has none', async () => {
    await downloadAttachment('https://api.test/api/conversation-files/att-3?t=sig', '   ')
    expect(anchors[0]?.download).toBe('download')
  })
})
