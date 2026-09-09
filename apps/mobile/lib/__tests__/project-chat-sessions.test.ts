// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { normalizeProjectChatItems, projectChatLabel, visibleProjectChatItems } from '../project-chat-sessions'

describe('project chat sessions', () => {
  test('prefers an explicit name, then inferred, then a dated fallback', () => {
    expect(projectChatLabel({ name: 'Posts', inferredName: 'ignored' })).toBe('Posts')
    expect(projectChatLabel({ name: '  ', inferredName: 'Surfer' })).toBe('Surfer')
    expect(projectChatLabel({ name: '', inferredName: '', createdAt: Date.parse('2026-03-04T00:00:00Z') })).toMatch(/^Chat · /)
  })

  test('normalizes and sorts chats by recent activity', () => {
    const sessions = normalizeProjectChatItems([
      { id: 'a', name: 'Older', lastActiveAt: 100, isPinned: false, isArchived: false },
      { id: 'b', name: 'Newer', lastActiveAt: 200, isPinned: true, isArchived: false },
    ])
    expect(sessions.map((s) => s.id)).toEqual(['b', 'a'])
    expect(sessions[0]?.isPinned).toBe(true)
  })

  test('hides archived chats and keeps pinned rows first', () => {
    const sessions = normalizeProjectChatItems([
      { id: 'a', name: 'Older', lastActiveAt: 100, isPinned: false, isArchived: false },
      { id: 'b', name: 'Newer', lastActiveAt: 200, isPinned: false, isArchived: false },
      { id: 'c', name: 'Pinned older', lastActiveAt: 50, isPinned: true, isArchived: false },
      { id: 'd', name: 'Archived', lastActiveAt: 300, isPinned: false, isArchived: true },
    ])
    expect(visibleProjectChatItems(sessions).map((s) => s.id)).toEqual(['c', 'b', 'a'])
  })
})
