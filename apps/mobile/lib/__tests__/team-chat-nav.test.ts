// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { sessionCrumbs, sessionRoute, threadCrumbs } from '../team-chat-nav'

describe('session trail', () => {
  const origin = { conversationId: 'c1', conversationLabel: 'eng', conversationKind: 'channel', threadRootId: 't1', agentName: 'Reviewer' }

  test('the route carries the session and where it was opened from', () => {
    const route = sessionRoute({ projectId: 'p1', sessionId: 's1', origin, wide: false })
    expect(route.pathname).toBe('/(app)/project-chat/[id]')
    expect(route.params).toEqual({ id: 'p1', chatSessionId: 's1', fromConversation: 'c1', fromLabel: 'eng', fromKind: 'channel', fromThread: 't1', fromAgent: 'Reviewer' })
    expect(sessionRoute({ projectId: 'p1', sessionId: 's1', origin: { ...origin, threadRootId: null }, wide: false }).params.fromThread).toBeUndefined()
  })

  test('wide sessions open in the full project surface', () => {
    expect(sessionRoute({ projectId: 'p1', sessionId: 's1', origin, wide: true }).pathname).toBe('/(app)/projects/[id]')
  })

  test('the workspace agent has no project, so its session opens in the workspace agent chat', () => {
    for (const wide of [false, true]) {
      const route = sessionRoute({ projectId: null, sessionId: 's1', origin, wide })
      expect(route.pathname).toBe('/(app)/agent')
      expect(route.params).toEqual({ chatSessionId: 's1', fromConversation: 'c1', fromLabel: 'eng', fromKind: 'channel', fromThread: 't1', fromAgent: 'Reviewer' })
    }
    expect(sessionCrumbs(sessionRoute({ projectId: null, sessionId: 's1', origin, wide: false }).params)!.map((c) => c.label)).toEqual(['#eng', 'Thread', 'Reviewer · session'])
  })

  test('a thread session reads channel › thread › agent, each step back up is a link', () => {
    const crumbs = sessionCrumbs(sessionRoute({ projectId: 'p1', sessionId: 's1', origin, wide: true }).params)!
    expect(crumbs.map((c) => c.label)).toEqual(['#eng', 'Thread', 'Reviewer · session'])
    expect(crumbs[0].to).toEqual({ pathname: '/(app)/c/[conversationId]', params: { conversationId: 'c1' } })
    expect(crumbs[1].to?.params).toEqual({ conversationId: 'c1', thread: 't1' })
    expect(crumbs[2].to).toBeUndefined()
  })

  test('a channel-level reply skips the thread step; sessions opened elsewhere have no trail', () => {
    const params = sessionRoute({ projectId: 'p1', sessionId: 's1', origin: { ...origin, threadRootId: null }, wide: true }).params
    expect(sessionCrumbs(params)!.map((c) => c.label)).toEqual(['#eng', 'Reviewer · session'])
    expect(sessionCrumbs({ id: 'p1', chatSessionId: 's1' })).toBeNull()
  })
})

describe('thread trail', () => {
  test('a thread reads channel › Thread, and the channel steps back up', () => {
    expect(threadCrumbs({ kind: 'channel', label: 'eng' })).toEqual([{ key: 'conversation', label: '#eng', up: true }, { key: 'thread', label: 'Thread' }])
    expect(threadCrumbs({ kind: 'dm', label: 'Ada' })[0].label).toBe('Ada')
  })
})
