// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () => createReactNativeMock())
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const { InlineMarkdown } = await import('../InlineMarkdown')
const { ConversationRow } = await import('../ConversationRows')

describe('InlineMarkdown', () => {
  test('renders bold and code without the markers', () => {
    render(<InlineMarkdown text="**bold** and `code`" />)
    const bold = screen.getByText('bold')
    const code = screen.getByText('code')
    expect(bold.className).toContain('font-semibold')
    expect(code.className).toContain('font-mono')
    expect(document.body.textContent).not.toContain('**')
    expect(document.body.textContent).not.toContain('`')
  })

  test('a direct message row keeps inline formatting in its preview', () => {
    const { container } = render(
      <ConversationRow
        workspaceId="ws"
        preview
        onPress={() => {}}
        conversation={{
          id: 'dm1',
          workspaceId: 'ws',
          kind: 'dm',
          name: null,
          slug: null,
          topic: null,
          lastSeq: 1,
          lastMessageAt: '2026-10-01T00:00:00.000Z',
          archivedAt: null,
          createdAt: '2026-10-01T00:00:00.000Z',
          joined: true,
          starred: false,
          muted: false,
          notifyLevel: 'all',
          lastReadSeq: 1,
          unreadCount: 0,
          mentionCount: 0,
          participants: [{ type: 'agent', projectId: null, name: 'Ops' }],
          lastMessage: {
            preview: '**Done** — see `src/app.ts`',
            authorId: null,
            authorType: 'agent',
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        }}
      />,
    )
    const preview = container.querySelector('[data-rn-shim="conversation-preview"]')
    expect(preview?.textContent).toBe('Done — see src/app.ts')
    expect(screen.getByText('Done').className).toContain('font-semibold')
    expect(screen.getByText('src/app.ts').className).toContain('font-mono')
    expect(preview?.textContent).not.toContain('**')
    expect(preview?.textContent).not.toContain('`')
  })
})
