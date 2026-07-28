// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { searchWorkspaceChats } from '../chat-search.service'

describe('searchWorkspaceChats pagination', () => {
  test('returns one page and a nextOffset for additional matches', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z')
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      id: `session-${index}`,
      name: `Chat ${index}`,
      inferredName: `Chat ${index}`,
      contextType: 'project',
      contextId: `project-${index}`,
      workspaceId: null,
      updatedAt: new Date(now.getTime() - index * 1000),
      lastActiveAt: new Date(now.getTime() - index * 1000),
      createdAt: new Date(now.getTime() - index * 1000),
      project: { id: `project-${index}`, name: `Project ${index}`, workspaceId: 'workspace-1' },
      workspace: null,
      attachedProjects: [],
    }))

    const prisma = {
      chatMessage: {
        findMany: async () => [],
      },
      chatSession: {
        findMany: async () => sessions,
      },
    }

    const first = await searchWorkspaceChats({
      prisma,
      workspaceId: 'workspace-1',
      query: 'chat',
      limit: 10,
      offset: 0,
    })

    expect(first.conversations).toHaveLength(10)
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBe(10)

    const second = await searchWorkspaceChats({
      prisma,
      workspaceId: 'workspace-1',
      query: 'chat',
      limit: 10,
      offset: first.nextOffset ?? 0,
    })

    expect(second.conversations).toHaveLength(2)
    expect(second.hasMore).toBe(false)
    expect(second.nextOffset).toBeNull()
  })
})