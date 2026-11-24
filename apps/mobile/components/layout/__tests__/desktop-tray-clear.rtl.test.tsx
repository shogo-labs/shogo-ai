// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Clear All Notifications" from the menu-bar dropdown has to reach the model
 * this window published (SHO-555 round 1).
 *
 * QA caught the gap: the publisher was not subscribed to
 * `chatSessionEvents.clearChatCompletions`, so a project chat's blue dot — and
 * the count beside the icon — survived until the next 10 s poll. The real
 * `chat-session-events` module is used here; only the three chat sources are
 * stubbed, so the assertion is the event path, not a mock of it.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { createElement } from 'react'

const RECENT = [
  {
    chatSessionId: 'p-1',
    title: 'Card work',
    projectId: 'proj-1',
    agentKey: 'shogo-dev-5',
    agentName: 'Shogo Dev 5',
    lastActiveAt: '2026-11-24T04:00:00.000Z',
    isPinned: false,
    running: false,
  },
]

let completedProjectIds: string[] = ['p-1']

// Every hook return must be a stable reference: the publisher's poll effect
// depends on the http client, so a fresh object per render would restart it
// forever.
const httpClient = {}
const workspaceChats = {
  sessions: [] as unknown[],
  streamingIds: new Set<string>(),
  completedIds: new Set<string>(),
  createChat: async () => null,
}
const activeWorkspace = { id: 'ws-1' }
const router = { push: () => {} }

mock.module('expo-router', () => ({ useRouter: () => router }))
mock.module('../../../hooks/useActiveWorkspace', () => ({ useActiveWorkspace: () => activeWorkspace }))
mock.module('../../../hooks/useWorkspaceChats', () => ({ useWorkspaceChats: () => workspaceChats }))
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => httpClient }))
mock.module('../../../lib/workspace-activity', () => ({
  workspaceActivity: { recentAgentChats: async () => RECENT },
}))
mock.module('../../../lib/desktop-island', () => ({
  getCompletedChatIds: () => new Set(completedProjectIds),
  getDesktopIslandSnapshot: () => ({ sessions: [] }),
}))

const { chatSessionEvents } = await import('../../../lib/chat-session-events')
const { DesktopTrayPublisher } = await import('../DesktopTrayPublisher')

type Published = {
  pinned: Array<{ sessionId: string; status: string | null }>
  groups: Array<{ title: string; rows: Array<{ sessionId: string; status: string | null }> }>
  recent: Array<{ sessionId: string; status: string | null }>
  attentionCount: number
  canClear: boolean
}

let published: Published[] = []

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 40)))
const latest = (): Published => published[published.length - 1]!
const allRows = (model: Published) => [
  ...model.pinned,
  ...model.groups.flatMap((group) => group.rows),
  ...model.recent,
]

beforeEach(() => {
  published = []
  completedProjectIds = ['p-1']
  ;(window as unknown as { shogoDesktop: unknown }).shogoDesktop = {
    trayUpdate: (model: Published) => {
      published.push(model)
    },
    onTrayAction: () => () => {},
  }
})

describe('DesktopTrayPublisher — Clear All Notifications', () => {
  test('a finished project reply publishes a blue dot and a count', async () => {
    render(createElement(DesktopTrayPublisher))
    await settle()

    const model = latest()
    expect(allRows(model).map((row) => row.status)).toContain('new')
    expect(model.attentionCount).toBe(1)
    expect(model.canClear).toBe(true)
  })

  test('clearing drops the dot and the count at once, not on the next poll', async () => {
    render(createElement(DesktopTrayPublisher))
    await settle()
    expect(latest().attentionCount).toBe(1)

    await act(async () => {
      chatSessionEvents.clearChatCompletions()
    })
    await settle()

    const model = latest()
    expect(allRows(model).every((row) => row.status === null)).toBe(true)
    expect(model.attentionCount).toBe(0)
    expect(model.canClear).toBe(false)
    // Still listed — clearing read state must not empty the menu.
    expect(allRows(model).map((row) => row.sessionId)).toContain('p-1')
  })
})
