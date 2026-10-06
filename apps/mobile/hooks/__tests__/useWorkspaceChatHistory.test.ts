// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { selectChatHistory } from '../useWorkspaceChatHistory'

describe('selectChatHistory', () => {
  test('lists side chats newest first, without the main chat, archived or project-pinned chats', () => {
    const rows = [
      { id: 'main', isPrimary: true, lastActiveAt: '2026-10-03T10:00:00Z' },
      { id: 'old', lastActiveAt: '2026-10-01T10:00:00Z' },
      { id: 'new', lastActiveAt: '2026-10-02T10:00:00Z' },
      { id: 'archived', isArchived: true, lastActiveAt: '2026-10-03T09:00:00Z' },
      { id: 'in-project', contextId: 'proj-1', lastActiveAt: '2026-10-03T08:00:00Z' },
    ]
    expect(selectChatHistory(rows).map((r) => r.id)).toEqual(['new', 'old'])
  })
})
