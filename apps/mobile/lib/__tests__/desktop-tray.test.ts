// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The dropdown's model: status priority, grouping, pinned de-dup, the caps and
 * the "recent" fallback. Pure, so no renderer and no desktop bridge.
 *
 *   bun test apps/mobile/lib/__tests__/desktop-tray.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  TRAY_MAX_GROUPS,
  TRAY_MAX_ROWS_PER_GROUP,
  buildTrayModel,
  trayRowPath,
  type TrayModelInput,
  type TrayRecentChat,
} from '../desktop-tray'

function input(overrides: Partial<TrayModelInput> = {}): TrayModelInput {
  return {
    workspaceChats: [],
    recentChats: [],
    islandSessions: [],
    streamingIds: [],
    completedIds: [],
    wide: true,
    ...overrides,
  }
}

function recent(overrides: Partial<TrayRecentChat> & { chatSessionId: string }): TrayRecentChat {
  return {
    title: overrides.chatSessionId,
    projectId: null,
    agentKey: 'ws',
    agentName: 'Shogo',
    lastActiveAt: new Date('2026-11-24T10:00:00Z').toISOString(),
    isPinned: false,
    running: false,
    ...overrides,
  }
}

describe('trayRowPath', () => {
  test('opens the workspace agent chat with the session', () => {
    expect(trayRowPath({ projectId: null, sessionId: 'abc', wide: true })).toBe(
      '/(app)/agent?chatSessionId=abc',
    )
  })

  test('opens the project route the window is wide or narrow enough for', () => {
    expect(trayRowPath({ projectId: 'p1', sessionId: 'abc', wide: true })).toBe(
      '/(app)/projects/p1?chatSessionId=abc',
    )
    expect(trayRowPath({ projectId: 'p1', sessionId: 'abc', wide: false })).toBe(
      '/(app)/project-chat/p1?chatSessionId=abc',
    )
  })
})

describe('buildTrayModel — status', () => {
  test('needs_you outranks running, which outranks a new reply', () => {
    const model = buildTrayModel(
      input({
        recentChats: [
          recent({ chatSessionId: 'a', running: true }),
          recent({ chatSessionId: 'b', running: true }),
          recent({ chatSessionId: 'c' }),
        ],
        islandSessions: [
          { sessionId: 'a', projectId: 'ws', title: 'a', status: 'needs_approval' },
          { sessionId: 'b', projectId: 'ws', title: 'b', status: 'running' },
          { sessionId: 'c', projectId: 'ws', title: 'c', status: 'done' },
        ],
      }),
    )
    const byId = new Map(model.groups.flatMap((group) => group.rows).map((row) => [row.sessionId, row.status]))
    expect(byId.get('a')).toBe('needs_you')
    expect(byId.get('b')).toBe('running')
    expect(byId.get('c')).toBe('new')
  })

  test('a question and a permission request both read as needing you', () => {
    const model = buildTrayModel(
      input({
        islandSessions: [
          { sessionId: 'q', projectId: 'ws', title: 'Question', status: 'needs_answer' },
          { sessionId: 'p', projectId: 'ws', title: 'Permission', status: 'needs_approval' },
        ],
      }),
    )
    expect(model.groups.flatMap((group) => group.rows).map((row) => row.status)).toEqual([
      'needs_you',
      'needs_you',
    ])
    expect(model.attentionCount).toBe(2)
  })

  test('a workspace chat’s streaming and unopened sets drive its dot', () => {
    const model = buildTrayModel(
      input({
        workspaceChats: [{ id: 'run', name: 'Running chat' }, { id: 'new', name: 'Finished chat' }],
        streamingIds: ['run'],
        completedIds: ['new'],
      }),
    )
    const byId = new Map(model.groups.flatMap((group) => group.rows).map((row) => [row.sessionId, row]))
    expect(byId.get('run')?.status).toBe('running')
    expect(byId.get('new')?.status).toBe('new')
    expect(byId.get('run')?.title).toBe('Running chat')
    // Running does not want the person; the unopened reply does.
    expect(model.attentionCount).toBe(1)
    expect(model.canClear).toBe(true)
  })

  test('archived workspace chats never appear', () => {
    const model = buildTrayModel(
      input({
        workspaceChats: [{ id: 'old', name: 'Archived', isArchived: true }],
        recentChats: [recent({ chatSessionId: 'old' })],
      }),
    )
    expect(model.groups).toEqual([])
  })
})

describe('buildTrayModel — sections', () => {
  test('one section per agent, newest agent first', () => {
    const model = buildTrayModel(
      input({
        recentChats: [
          recent({
            chatSessionId: 'ws-1',
            running: true,
            lastActiveAt: new Date('2026-11-24T09:00:00Z').toISOString(),
          }),
          recent({
            chatSessionId: 'p-1',
            projectId: 'p1',
            agentKey: 'p1',
            agentName: 'Shogo Dev 5',
            running: true,
            lastActiveAt: new Date('2026-11-24T11:00:00Z').toISOString(),
          }),
        ],
      }),
    )
    expect(model.groups.map((group) => group.title)).toEqual(['Shogo Dev 5', 'Shogo'])
  })

  test('a pinned chat is not repeated under its agent', () => {
    const model = buildTrayModel(
      input({
        workspaceChats: [{ id: 'pin', name: 'Pinned chat', isPinned: true }],
        recentChats: [recent({ chatSessionId: 'pin', isPinned: true, title: 'Pinned chat' })],
        completedIds: ['pin'],
      }),
    )
    expect(model.pinned.map((row) => row.sessionId)).toEqual(['pin'])
    expect(model.groups).toEqual([])
    // Its blue dot still counts and is still clearable.
    expect(model.attentionCount).toBe(1)
    expect(model.canClear).toBe(true)
  })

  test('with no dots the 5 newest chats are listed instead', () => {
    const recentChats = Array.from({ length: 8 }, (_, i) =>
      recent({
        chatSessionId: `c${i}`,
        title: `Chat ${i}`,
        lastActiveAt: new Date(Date.parse('2026-11-24T10:00:00Z') - i * 60_000).toISOString(),
      }),
    )
    const model = buildTrayModel(input({ recentChats }))
    expect(model.groups).toEqual([])
    expect(model.recent.map((row) => row.sessionId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(model.recent.every((row) => row.status === null)).toBe(true)
    expect(model.attentionCount).toBe(0)
    expect(model.canClear).toBe(false)
  })

  test('caps sections and rows per section', () => {
    const recentChats: TrayRecentChat[] = []
    for (let agent = 0; agent < 8; agent++) {
      for (let i = 0; i < 7; i++) {
        recentChats.push(
          recent({
            chatSessionId: `a${agent}-${i}`,
            projectId: `p${agent}`,
            agentKey: `p${agent}`,
            agentName: `Agent ${agent}`,
            running: true,
            lastActiveAt: new Date(Date.parse('2026-11-24T10:00:00Z') - agent * 60_000 - i * 1_000).toISOString(),
          }),
        )
      }
    }
    const model = buildTrayModel(input({ recentChats }))
    expect(model.groups).toHaveLength(TRAY_MAX_GROUPS)
    expect(model.groups.every((group) => group.rows.length === TRAY_MAX_ROWS_PER_GROUP)).toBe(true)
  })

  test('a chat open in the window but missing from both lists still appears', () => {
    const model = buildTrayModel(
      input({
        islandSessions: [
          { sessionId: 'fresh', projectId: 'p1', projectName: 'Shogo Dev 5', title: 'Brand new', status: 'running' },
        ],
      }),
    )
    expect(model.groups).toEqual([
      {
        title: 'Shogo Dev 5',
        rows: [
          {
            sessionId: 'fresh',
            projectId: 'p1',
            title: 'Brand new',
            status: 'running',
            path: '/(app)/projects/p1?chatSessionId=fresh',
          },
        ],
      },
    ])
  })

  test('an unopened project reply the island knows about shows as new', () => {
    const model = buildTrayModel(
      input({
        recentChats: [recent({ chatSessionId: 'proj-chat', projectId: 'p1', agentName: 'Shogo Dev 5', title: 'Card' })],
        completedProjectSessionIds: ['proj-chat'],
      }),
    )
    expect(model.groups[0].rows[0].status).toBe('new')
    expect(model.canClear).toBe(true)
  })
})
