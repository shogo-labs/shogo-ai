// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A shared file as a reader meets it: what the file is, whose name it keeps,
 * and a download in the corner that saves that file.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import type { FileAttachmentCardProps } from '../FileAttachmentCard'

const downloads: Array<{ url: string; name: string }> = []

mock.module(resolve(import.meta.dir, '../../../lib/attachment-download'), () => ({
  attachmentDownloadUrl: (url: string) => url,
  downloadAttachment: async (url: string, name: string) => {
    downloads.push({ url, name })
  },
}))

// The real shared-ui pulls in react-native; only `cn` is needed here.
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// `formatFileSize` comes from a module that also imports icons, so this has to
// answer for the names that graph asks for, not just the one the card draws.
mock.module('lucide-react-native', () => ({
  Download: () => createElement('span', { 'data-icon': 'Download' }),
  File: () => createElement('span', { 'data-icon': 'File' }),
  FileText: () => createElement('span', { 'data-icon': 'FileText' }),
  Image: () => createElement('span', { 'data-icon': 'Image' }),
}))

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: {
      OS: 'web',
      Version: 0,
      isPad: false,
      isTV: false,
      select: <T,>(spec: { web?: T; default?: T }) => spec.web,
    },
    Pressable: (({
      accessibilityLabel,
      accessibilityRole,
      children,
      onPress,
      disabled,
      testID,
      ...props
    }: {
      accessibilityLabel?: string
      accessibilityRole?: string
      children?: ReactNode
      onPress?: () => void
      disabled?: boolean
      testID?: string
    }) =>
      createElement(
        'button',
        {
          ...props,
          role: accessibilityRole,
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

afterEach(cleanup)

describe('what the card says the file is', () => {
  test('names the file and what kind of file it is', () => {
    renderCard()
    expect(screen.getByText(DECK.name)).toBeDefined()
    expect(screen.getByText('PowerPoint Presentation · 2.4 MB')).toBeDefined()
  })

  test('marks the tile with the family it belongs to', () => {
    renderCard()
    expect(screen.getByText('P')).toBeDefined()
  })

  test('reads the kind from the name when the MIME type says nothing', () => {
    renderCard({ mimeType: 'application/octet-stream', name: 'Q3 forecast.xlsx' })
    expect(screen.getByText('Spreadsheet · 2.4 MB')).toBeDefined()
    expect(screen.getByText('X')).toBeDefined()
  })

  test('leaves the size out when the file has none to show', () => {
    renderCard({ size: 0 })
    expect(screen.getByText('PowerPoint Presentation')).toBeDefined()
  })
})

describe('downloading from the card', () => {
  test('offers a download named after the file', () => {
    renderCard()
    expect(screen.getByLabelText(`Download ${DECK.name}`)).toBeDefined()
  })

  test('saves that file when the corner control is pressed', () => {
    renderCard()
    fireEvent.click(screen.getByLabelText(`Download ${DECK.name}`))
    // The URL is the helper's business; what matters here is that the card hands
    // it the file's own link and name.
    expect(downloads).toEqual([{ url: DECK.url, name: DECK.name }])
  })

  test('does not also open the file', () => {
    let opened = 0
    renderCard({ onOpen: () => (opened += 1) })
    fireEvent.click(screen.getByLabelText(`Download ${DECK.name}`))
    expect(opened).toBe(0)
  })
})

describe('opening the file', () => {
  test('keeps the card body opening it, as the old row did', () => {
    let opened = 0
    renderCard({ onOpen: () => (opened += 1) })
    fireEvent.click(screen.getByLabelText(`Open ${DECK.name}`))
    expect(opened).toBe(1)
  })

  test('is not a control at all when the host has nowhere to open it', () => {
    renderCard({ onOpen: undefined })
    expect(screen.queryByLabelText(`Open ${DECK.name}`)).toBe(null)
  })
})
