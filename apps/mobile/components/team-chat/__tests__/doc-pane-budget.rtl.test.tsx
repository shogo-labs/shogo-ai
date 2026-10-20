// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

let hook: any
const archiveSection = mock(async (_section: string) => ({}))
const here = fileURLToPath(new URL('.', import.meta.url))

mock.module('react-native', () =>
  createReactNativeMock({
    // React Native's Pressable does not bubble like a DOM button, so let a click inside a modal
    // stop at its own handler instead of also closing the modal behind it.
    Pressable: ({ accessibilityLabel, children, onPress }: any) =>
      createElement('button', {
        'aria-label': accessibilityLabel,
        onClick: (event: any) => { event.stopPropagation(); onPress?.(event) },
      }, children),
  } as any),
)
mock.module('expo-router', () => ({ useRouter: () => ({ push: () => {}, setParams: () => {} }) }))
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module(resolve(here, '../../../hooks/useConversationDoc'), () => ({ useConversationDoc: () => hook }))
mock.module(resolve(here, '../../chat/MarkdownText'), () => ({ MarkdownText: () => null }))
mock.module(resolve(here, '../../../lib/team-chat-links'), () => ({ docLink: (id: string) => `shogo://c/${id}?doc=1` }))
mock.module(resolve(here, '../../../lib/team-chat-state'), () => ({
  mentionNames: () => ({}),
  renderMentionsMarkdown: (text: string) => text,
}))
mock.module(resolve(here, '../../../lib/activity-feed'), () => ({ relativeTime: () => 'now' }))
mock.module(resolve(here, '../../../lib/team-chat-api'), () => {
  const api = {
    listDocArchives: async () => [
      { id: 'a-1', conversationId: 'c-1', title: '', heading: 'SHO-26 QA gate', chars: 7688, archivedBy: null, createdAt: '2026-10-19T00:00:00Z' },
    ],
    getDocArchive: async () => ({
      id: 'a-1', conversationId: 'c-1', title: '', heading: 'SHO-26 QA gate', chars: 7688,
      content: 'the story', archivedBy: null, createdAt: '2026-10-19T00:00:00Z',
    }),
    archiveDocSection: async () => ({ doc: {}, archive: {} }),
    restoreDocArchive: async () => ({}),
  }
  return { teamChatApi: () => api, DocConflictError: class extends Error {} }
})

const { DocPane } = await import('../DocPane')

const HEAD = '# How this channel works\n\nPost any idea or bug here.\n\n## Working mode flips\n\nLocal mode is unlimited.\n\n## SHO-26 QA gate\n\nlong story\n\n'
const CONTENT = `${HEAD}${'z'.repeat(175_492 - HEAD.length)}`

function setDoc(content = CONTENT, canEdit = true) {
  hook = {
    state: {
      loaded: true,
      server: { id: 'd1', conversationId: 'c-1', title: 'Doc', content, version: 3, locked: false, updatedBy: null, createdAt: '', updatedAt: '' },
      draft: null,
      saving: null,
      conflict: null,
      error: null,
      canEdit,
      canManage: false,
    },
    doc: { title: 'Doc', content },
    dirty: false,
    edit: () => {},
    flush: () => {},
    resolve: () => {},
    setLocked: async () => {},
    restore: async () => {},
    archiveSection,
    restoreArchive: async () => {},
  }
}

const conversation = { id: 'c-1', name: 'shogo-dev', archivedAt: null } as any

function renderPane() {
  return render(createElement(DocPane, { conversation, workspaceId: 'w-1', mentionables: null, onClose: () => {} }))
}

beforeEach(() => {
  archiveSection.mockClear()
  setDoc()
})

describe('DocPane budget and archive', () => {
  test('the footer meter shows the doc at 87.7% as critical', () => {
    renderPane()
    const meter = screen.getByText('175,492 / 200,000')
    expect(meter.className).toContain('text-destructive')
  })

  test('a small doc reads as ok', () => {
    setDoc('## Decisions\n\n- ship Friday\n')
    renderPane()
    const meter = screen.getByText('28 / 200,000')
    expect(meter.className).toContain('text-muted-foreground')
  })

  test('Archive a section lists the doc headings and archives the picked one', () => {
    renderPane()
    fireEvent.click(screen.getByLabelText('Archive a section'))
    expect(screen.getByLabelText('Archive SHO-26 QA gate').textContent).toContain('SHO-26 QA gate')
    expect(screen.getByLabelText('Archive Working mode flips')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Archive SHO-26 QA gate'))
    fireEvent.click(screen.getByLabelText('Archive section'))
    expect(archiveSection).toHaveBeenCalledWith('SHO-26 QA gate')
  })

  test('Archived sections opens the archive with what can be restored', async () => {
    renderPane()
    fireEvent.click(screen.getByLabelText('Archived sections'))
    await waitFor(() => expect(screen.getByLabelText('Open SHO-26 QA gate').textContent).toContain('7,688 chars'))
  })

  test('a read-only doc gets no archive control but keeps the meter', () => {
    setDoc(CONTENT, false)
    renderPane()
    expect(screen.getByText('175,492 / 200,000')).toBeTruthy()
    expect(screen.queryByLabelText('Archive a section')).toBeNull()
  })
})
