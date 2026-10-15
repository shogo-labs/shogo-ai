// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a reader sees inside a shared file: the sample of its content, and what
 * happens when there is none.
 *
 * The "none" case is the one worth guarding — most files in the wild are
 * unreadable to us, and a preview that arrives late (after the message was
 * posted) must grow the card rather than replace what was already there.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import type { AttachmentPreview } from '../../../lib/team-chat-api'
import type { FileAttachmentCardProps } from '../FileAttachmentCard'

const downloads: Array<{ url: string; name: string }> = []

mock.module(resolve(import.meta.dir, '../../../lib/attachment-download'), () => ({
  attachmentDownloadUrl: (url: string) => url,
  downloadAttachment: async (url: string, name: string) => {
    downloads.push({ url, name })
  },
}))

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

mock.module('lucide-react-native', () => ({
  Download: () => createElement('span', { 'data-icon': 'Download' }),
  File: () => createElement('span', { 'data-icon': 'File' }),
  FileText: () => createElement('span', { 'data-icon': 'FileText' }),
  Image: () => createElement('span', { 'data-icon': 'Image' }),
}))

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: (({ accessibilityLabel, children, onPress, disabled, testID, ...props }: {
      accessibilityLabel?: string
      children?: ReactNode
      onPress?: () => void
      disabled?: boolean
      testID?: string
    }) =>
      createElement(
        'button',
        {
          ...props,
          'aria-label': accessibilityLabel,
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

const { AttachmentPreviewBody } = await import('../AttachmentPreviewBody')
const { FileAttachmentCard } = await import('../FileAttachmentCard')

const DECK: FileAttachmentCardProps = {
  name: 'EM Onboarding Guide - KM.pptx',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  size: 2_500_000,
  url: 'https://api.test/api/conversation-files/att-1?t=sig',
}

function renderCard(overrides: Partial<FileAttachmentCardProps> = {}) {
  return render(createElement(FileAttachmentCard, { ...DECK, ...overrides }))
}

function renderBody(preview: AttachmentPreview | null | undefined) {
  return render(createElement(AttachmentPreviewBody, { preview }))
}

/**
 * The mock's host elements carry `testID` as `data-rn-shim`, not `data-testid`
 * (see `test/react-native-mock.ts`), so the preview container is found here.
 */
const previewNode = (kind: string) => document.querySelector(`[data-rn-shim="attachment-preview-${kind}"]`)
const anyPreviewNode = () => document.querySelector('[data-rn-shim^="attachment-preview-"]')

afterEach(cleanup)

describe('a document preview', () => {
  test('shows its opening lines', () => {
    renderBody({ v: 1, kind: 'text', lines: ['Renewal terms net 30', 'Second para'] })
    expect(previewNode('text')!.textContent).toBe('Renewal terms net 30\nSecond para')
  })

  test('a page count appears in the card subtitle, beside the type and size', () => {
    renderCard({ preview: { v: 1, kind: 'text', lines: ['First page'], pages: 12 } })
    expect(screen.getByText('PowerPoint Presentation · 12 pages · 2.4 MB')).toBeDefined()
  })

  test('a single-page file is not announced as "1 pages"', () => {
    renderCard({ preview: { v: 1, kind: 'text', lines: ['Only page'], pages: 1 } })
    expect(screen.getByText('PowerPoint Presentation · 2.4 MB')).toBeDefined()
  })
})

describe('a deck preview', () => {
  test('shows slide 1 and where it sits in the deck', () => {
    renderBody({ v: 1, kind: 'slides', title: 'Kickoff', bullets: ['Goals', 'Owners'], count: 12 })
    expect(screen.getByText('Kickoff')).toBeDefined()
    expect(screen.getByText('• Goals')).toBeDefined()
    expect(screen.getByText('• Owners')).toBeDefined()
    expect(screen.getByText('Slide 1 of 12')).toBeDefined()
  })

  test('a one-slide deck does not claim a position', () => {
    renderBody({ v: 1, kind: 'slides', title: 'Solo', bullets: [], count: 1 })
    expect(screen.getByText('Solo')).toBeDefined()
    expect(screen.queryByText('Slide 1 of 1')).toBe(null)
  })
})

describe('a spreadsheet preview', () => {
  test('draws the grid, names the sheet, and says when it is only a sample', () => {
    renderBody({
      v: 1, kind: 'table', sheet: 'Q3', truncated: true,
      rows: [['Region', 'Revenue'], ['EMEA', '1200']],
    })
    expect(screen.getByText('Q3')).toBeDefined()
    expect(screen.getByText('Region')).toBeDefined()
    expect(screen.getByText('1200')).toBeDefined()
    expect(screen.getByText('Showing the first rows')).toBeDefined()
  })

  test('says nothing about sampling when the whole grid fits', () => {
    renderBody({ v: 1, kind: 'table', truncated: false, rows: [['Region'], ['EMEA']] })
    expect(screen.queryByText('Showing the first rows')).toBe(null)
  })
})

describe('a code preview', () => {
  test('keeps the indentation it was given', () => {
    renderBody({ v: 1, kind: 'code', lang: 'ts', lines: ['function a() {', '  return 1', '}'] })
    const rendered = previewNode('code')!.textContent ?? ''
    expect(rendered).toContain('function a() {\n  return 1\n}')
    // The leading spaces survive; the tidied search text would have collapsed them.
    expect(rendered).toContain('  return 1')
  })
})

describe('a file with nothing to show', () => {
  test('draws no preview at all, and leaves the card as it was', () => {
    renderCard({ preview: null })
    expect(anyPreviewNode()).toBe(null)
    expect(screen.getByText(DECK.name)).toBeDefined()
    expect(screen.getByText('PowerPoint Presentation · 2.4 MB')).toBeDefined()
  })

  test('is the same card whether the preview is null or simply absent', () => {
    const withNull = renderCard({ preview: null })
    expect(anyPreviewNode()).toBe(null)
    withNull.unmount()
    renderCard()
    expect(anyPreviewNode()).toBe(null)
  })

  test('the body on its own draws nothing for an absent preview', () => {
    const { container } = renderBody(undefined)
    expect(container.textContent).toBe('')
  })
})

describe('the download control with a preview alongside it', () => {
  test('is still there, and still saves the file', () => {
    renderCard({ preview: { v: 1, kind: 'text', lines: ['Body text'], pages: 3 } })
    fireEvent.click(screen.getByLabelText(`Download ${DECK.name}`))
    expect(downloads).toEqual([{ url: DECK.url, name: DECK.name }])
  })
})
