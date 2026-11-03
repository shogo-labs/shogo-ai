// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { currentThreadFocus, openConversationTarget, sessionCrumbs, sessionRoute, setThreadFocus, threadCrumbs, threadNavAction } from '../team-chat-nav'

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

describe('one thread at a time', () => {
  const state = (conversationId: string | null, threadRootId: string | null) => ({ conversationId, threadRootId })

  test('a thread opened on a channel with none pushes, so Back closes it', () => {
    expect(threadNavAction(state('c1', null), { conversationId: 'c1', thread: 'b' })).toBe('push')
  })

  test('a second thread in the same conversation swaps the first out', () => {
    expect(threadNavAction(state('c1', 'a'), { conversationId: 'c1', thread: 'b' })).toBe('swap')
  })

  test('the thread already open is a no-op, not a second history entry', () => {
    expect(threadNavAction(state('c1', 'a'), { conversationId: 'c1', thread: 'a' })).toBe('none')
  })

  test('a thread in another conversation navigates there', () => {
    expect(threadNavAction(state('c1', 'a'), { conversationId: 'c2', thread: 'b' })).toBe('push')
  })

  test('nothing in focus pushes', () => {
    expect(threadNavAction(state(null, null), { conversationId: 'c1', thread: 'b' })).toBe('push')
  })

  test('a target with no thread always pushes', () => {
    expect(threadNavAction(state('c1', 'a'), { conversationId: 'c1' })).toBe('push')
  })
})

describe('openConversationTarget', () => {
  function router() {
    const pushes: unknown[] = []
    const params: unknown[] = []
    return {
      push: (href: unknown) => pushes.push(href),
      setParams: (next: unknown) => params.push(next),
      pushes,
      params,
    }
  }
  const owner = {}

  test('with a thread open, the next thread replaces it in place', () => {
    setThreadFocus({ conversationId: 'c1', threadRootId: 'a' }, owner)
    const nav = router()
    expect(openConversationTarget(nav as any, { conversationId: 'c1', thread: 'b', msg: 'm2' })).toBe('swap')
    expect(nav.pushes).toEqual([])
    // The panes that would hide the thread step aside, so the thread that was
    // asked for is the one on screen.
    expect(nav.params).toEqual([{ thread: 'b', msg: 'm2', project: undefined, files: undefined, doc: undefined, file: undefined, profile: undefined, card: undefined }])
    setThreadFocus(null, owner)
  })

  test('with no thread open the same conversation still pushes, so Back closes the thread', () => {
    setThreadFocus({ conversationId: 'c1', threadRootId: null }, owner)
    const nav = router()
    expect(openConversationTarget(nav as any, { conversationId: 'c1', thread: 'b' })).toBe('push')
    expect(nav.pushes).toEqual([{ pathname: '/(app)/c/[conversationId]', params: { conversationId: 'c1', thread: 'b' } }])
    setThreadFocus(null, owner)
  })

  test('reopening the thread already on screen does nothing at all', () => {
    setThreadFocus({ conversationId: 'c1', threadRootId: 'a' }, owner)
    const nav = router()
    expect(openConversationTarget(nav as any, { conversationId: 'c1', thread: 'a' })).toBe('none')
    expect(nav.pushes).toEqual([])
    expect(nav.params).toEqual([])
    setThreadFocus(null, owner)
  })

  test('a screen being covered cannot clear the focus the new one published', () => {
    const first = {}
    const second = {}
    setThreadFocus({ conversationId: 'c1', threadRootId: 'a' }, first)
    setThreadFocus({ conversationId: 'c1', threadRootId: 'b' }, second)
    setThreadFocus(null, first)
    expect(currentThreadFocus()).toEqual({ conversationId: 'c1', threadRootId: 'b' })
    setThreadFocus(null, second)
    expect(currentThreadFocus()).toEqual({ conversationId: null, threadRootId: null })
  })
})

