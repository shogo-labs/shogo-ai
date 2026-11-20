// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-425: "Running now" used to show six rows that all read the same — the
 * same filler line, the same robot icon, and nothing telling two runs of one
 * agent apart. These pin what a row now carries: the agent's own avatar, the
 * card (or the message) it is running on, and a stop that ends the run without
 * opening the row — which a viewer never sees.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress, testID }: any) =>
      createElement('button', { 'aria-label': accessibilityLabel, 'data-testid': testID, onClick: onPress }, children),
  } as any),
)

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {} }),
  useFocusEffect: () => {},
}))

// The avatar is the per-agent picture; what matters here is that the row asks
// for the right agent's, so it records what it was given.
mock.module('../../team-chat/AgentAvatar', () => ({
  AgentAvatar: ({ name, projectId }: { name: string; projectId: string | null }) =>
    createElement('span', { 'data-testid': `avatar-${name}`, 'data-project': projectId ?? 'workspace' }, name),
}))

mock.module('../RunPeekHover', () => ({
  RunPeekHover: ({ children }: { children: unknown }) => children,
  RunPeekHoverById: ({ children }: { children: unknown }) => children,
  RunPeekHoverTask: ({ children }: { children: unknown }) => children,
}))

const stopRunningChat = mock(async () => true)
mock.module('../../../lib/stop-running-chat', () => ({ stopRunningChat }))

const { RunningNow } = await import('../ActivityFeed')
const { chatEntry } = await import('../../../lib/activity-feed')

const started = '2026-11-18T15:10:00.000Z'

const chatRow = (over: Record<string, unknown> = {}) => chatEntry({
  chatSessionId: 'sess-a',
  turnId: 'turn-a',
  sessionName: '#shogo-dev: @agent fix SHO-421',
  isPrimary: false,
  projectId: 'proj-dev2',
  projectName: 'Shogo Dev 2',
  projectHidden: false,
  startedAt: started,
  agentName: 'Shogo Dev 2',
  conversationId: 'conv-1',
  conversationName: 'shogo-dev',
  conversationKind: 'public',
  threadRootId: 'thread-1',
  messageId: 'msg-a',
  ...over,
} as any)

afterEach(cleanup)

beforeEach(() => {
  stopRunningChat.mockClear()
})

describe('RunningNow', () => {
  test('a row leads with what differs: its card, its agent, its channel, its time', () => {
    render(
      createElement(RunningNow, {
        entries: [chatRow({ card: { key: 'SHO-421', title: 'A full PR from an empty channel' } })],
        onOpen: () => {},
        workspaceId: 'ws-1',
      }),
    )

    expect(screen.getByText('SHO-421 · A full PR from an empty channel')).toBeTruthy()
    expect(screen.getByText(/^Shogo Dev 2 · #shogo-dev · /)).toBeTruthy()
    expect(screen.queryByText(/An agent is responding/)).toBeNull()
  })

  test("each run shows its own agent's avatar, not one robot for all of them", () => {
    render(
      createElement(RunningNow, {
        entries: [chatRow(), chatRow({ chatSessionId: 'sess-b', turnId: 'turn-b', agentName: 'Shogo Dev 1', projectId: 'proj-dev1' })],
        onOpen: () => {},
        workspaceId: 'ws-1',
      }),
    )

    expect(screen.getByTestId('avatar-Shogo Dev 2').getAttribute('data-project')).toBe('proj-dev2')
    expect(screen.getByTestId('avatar-Shogo Dev 1').getAttribute('data-project')).toBe('proj-dev1')
  })

  test('stop ends that run and never opens the row', () => {
    const onOpen = mock(() => {})
    const onStop = mock(() => {})
    render(createElement(RunningNow, { entries: [chatRow()], onOpen, onStop, workspaceId: 'ws-1' }))

    fireEvent.click(screen.getByTestId('stop-chat:sess-a:turn-a'))

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  test('a viewer is offered no stop at all', () => {
    render(
      createElement(RunningNow, {
        entries: [chatRow({ canStop: false })],
        onOpen: () => {},
        onStop: () => {},
        workspaceId: 'ws-1',
      }),
    )

    expect(screen.queryByTestId('stop-chat:sess-a:turn-a')).toBeNull()
  })
})
