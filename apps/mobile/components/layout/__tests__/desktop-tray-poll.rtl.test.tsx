// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The menu-bar publisher reads recent chats when they change, not every 10 s
 * (PERF-34).
 *
 * At a 10 s poll one person's desktop sent 7k `agent-chats/recent` requests a
 * day, plus 8.6k for every extra open window. The list now re-reads on the
 * chat events this window already receives and polls only as a 60 s backstop.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { createElement } from 'react'

type Read = { workspaceId: string | undefined; fresh: boolean | undefined }
let reads: Read[] = []

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
  workspaceActivity: {
    recentAgentChats: async (_http: unknown, workspaceId: string | undefined, opts: { fresh?: boolean }) => {
      reads.push({ workspaceId, fresh: opts.fresh })
      return []
    },
  },
}))
mock.module('../../../lib/desktop-island', () => ({
  getCompletedChatIds: () => new Set<string>(),
  getDesktopIslandSnapshot: () => ({ sessions: [] }),
}))

const { chatSessionEvents } = await import('../../../lib/chat-session-events')
const { DesktopTrayPublisher, TRAY_POLL_MS } = await import('../DesktopTrayPublisher')

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

beforeEach(() => {
  reads = []
  ;(window as unknown as { shogoDesktop: unknown }).shogoDesktop = {
    trayUpdate: () => {},
    onTrayAction: () => () => {},
  }
})

describe('DesktopTrayPublisher — recent chats polling (PERF-34)', () => {
  test('the backstop poll is a minute, not 10 s', () => {
    expect(TRAY_POLL_MS).toBe(60_000)
  })

  test('reads once on mount and not again until something changes', async () => {
    const view = render(createElement(DesktopTrayPublisher))
    await settle()
    await settle()
    expect(reads).toHaveLength(1)
    view.unmount()
  })

  test('a created/renamed/deleted chat re-reads at once, bypassing the cache', async () => {
    const view = render(createElement(DesktopTrayPublisher))
    await settle()
    reads = []

    await act(async () => {
      chatSessionEvents.emit({ workspaceId: 'ws-1', refresh: true })
    })
    await settle()

    expect(reads).toEqual([{ workspaceId: 'ws-1', fresh: true }])
    view.unmount()
  })

  test('a send re-reads through the shared cache', async () => {
    const view = render(createElement(DesktopTrayPublisher))
    await settle()
    reads = []

    await act(async () => {
      chatSessionEvents.emit({ touchedSessionId: 'chat-1', lastActiveAt: Date.now() })
    })
    await settle()

    expect(reads).toEqual([{ workspaceId: 'ws-1', fresh: false }])
    view.unmount()
  })

  test('switching the active chat does not fetch', async () => {
    const view = render(createElement(DesktopTrayPublisher))
    await settle()
    reads = []

    await act(async () => {
      chatSessionEvents.emit({ projectId: 'proj-1', activeSessionId: 'chat-2' })
    })
    await settle()

    expect(reads).toHaveLength(0)
    view.unmount()
  })

  test('unmounting stops listening', async () => {
    const view = render(createElement(DesktopTrayPublisher))
    await settle()
    view.unmount()
    reads = []

    await act(async () => {
      chatSessionEvents.emit({ workspaceId: 'ws-1', refresh: true })
    })
    await settle()

    expect(reads).toHaveLength(0)
  })
})
