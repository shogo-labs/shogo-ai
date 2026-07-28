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

  test('ranks title matches above frequent message-content matches', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z')
    const titleSession = {
      id: 'session-title',
      name: 'Error message',
      inferredName: 'Error message',
      contextType: 'project',
      contextId: 'project-title',
      workspaceId: null,
      updatedAt: new Date(now.getTime() - 20_000),
      lastActiveAt: new Date(now.getTime() - 20_000),
      createdAt: new Date(now.getTime() - 20_000),
      project: { id: 'project-title', name: 'shogo phase1 UI', workspaceId: 'workspace-1' },
      workspace: null,
      attachedProjects: [],
    }
    const noisySession = {
      id: 'session-noisy',
      name: 'airtable_logger',
      inferredName: 'airtable_logger',
      contextType: 'project',
      contextId: 'project-noisy',
      workspaceId: null,
      updatedAt: new Date(now.getTime() - 1_000),
      lastActiveAt: new Date(now.getTime() - 1_000),
      createdAt: new Date(now.getTime() - 1_000),
      project: { id: 'project-noisy', name: 'New Project', workspaceId: 'workspace-1' },
      workspace: null,
      attachedProjects: [],
    }
    const messages = Array.from({ length: 6 }, (_, index) => ({
      id: `message-${index}`,
      content: 'error error error from missing base/table',
      createdAt: new Date(now.getTime() - index * 1000),
      session: noisySession,
    }))

    const prisma = {
      chatMessage: {
        findMany: async () => messages,
      },
      chatSession: {
        findMany: async () => [titleSession],
      },
    }

    const result = await searchWorkspaceChats({
      prisma,
      workspaceId: 'workspace-1',
      query: 'error',
      limit: 10,
      offset: 0,
    })

    expect(result.conversations[0].conversationId).toBe('session-title')
    expect(result.conversations[0].hits[0].field).toBe('title')
  })

  test('orders message-only matches by recent activity before noisy frequency', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z')
    const recentSession = {
      id: 'session-recent',
      name: 'scrollable chats',
      inferredName: 'scrollable chats',
      contextType: 'project',
      contextId: 'project-recent',
      workspaceId: null,
      updatedAt: new Date(now.getTime() - 1_000),
      lastActiveAt: new Date(now.getTime() - 1_000),
      createdAt: new Date(now.getTime() - 1_000),
      project: { id: 'project-recent', name: 'shogo phase1 UI', workspaceId: 'workspace-1' },
      workspace: null,
      attachedProjects: [],
    }
    const noisyOldSession = {
      id: 'session-old-noisy',
      name: 'Stage Ask Shogo',
      inferredName: 'Stage Ask Shogo',
      contextType: 'project',
      contextId: 'project-old',
      workspaceId: null,
      updatedAt: new Date(now.getTime() - 30 * 86_400_000),
      lastActiveAt: new Date(now.getTime() - 30 * 86_400_000),
      createdAt: new Date(now.getTime() - 30 * 86_400_000),
      project: { id: 'project-old', name: 'Product Delivery Manager', workspaceId: 'workspace-1' },
      workspace: null,
      attachedProjects: [],
    }
    const messages = [
      {
        id: 'recent-message',
        content: 'working on scroll behavior',
        createdAt: recentSession.lastActiveAt,
        session: recentSession,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `old-message-${index}`,
        content: 'working working working across many API endpoints',
        createdAt: new Date(now.getTime() - 30 * 86_400_000 - index * 1000),
        session: noisyOldSession,
      })),
    ]

    const prisma = {
      chatMessage: {
        findMany: async () => messages,
      },
      chatSession: {
        findMany: async () => [],
      },
    }

    const result = await searchWorkspaceChats({
      prisma,
      workspaceId: 'workspace-1',
      query: 'working',
      limit: 10,
      offset: 0,
    })

    expect(result.conversations[0].conversationId).toBe('session-recent')
  })
})