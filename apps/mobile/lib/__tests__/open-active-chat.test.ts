// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { openActiveChat, openAgentWork } from '../open-active-chat'

function router() {
  const pushes: unknown[] = []
  return { push: (href: unknown) => pushes.push(href), pushes }
}

describe('openActiveChat', () => {
  test('a team-chat reply opens that conversation, thread, and message', () => {
    const nav = router()
    openActiveChat(nav as any, {
      conversationId: 'conv-ops',
      threadRootId: 'thread-1',
      messageId: 'msg-1',
      projectId: 'devops',
      chatSessionId: 'session-ops',
    })
    expect(nav.pushes).toEqual([
      { pathname: '/(app)/c/[conversationId]', params: { conversationId: 'conv-ops', thread: 'thread-1', msg: 'msg-1' } },
    ])
  })

  test('a workspace session opens in the workspace agent, even when it was the old primary chat', () => {
    const nav = router()
    openActiveChat(nav as any, { chatSessionId: 'session-1', isPrimary: true })
    expect(nav.pushes).toEqual([
      { pathname: '/(app)/agent', params: { chatSessionId: 'session-1' } },
    ])
  })

  test('a project session still opens in the project', () => {
    const nav = router()
    openActiveChat(nav as any, { projectId: 'project-1', chatSessionId: 'session-1' })
    expect(nav.pushes).toEqual([
      { pathname: '/(app)/projects/[id]', params: { id: 'project-1', chatSessionId: 'session-1' } },
    ])
  })
})

describe('openAgentWork', () => {
  test('a session with no chat id opens the project', () => {
    const nav = router()
    openAgentWork(nav as any, { kind: 'session', projectId: 'project-1', chatSessionId: null, isPrimary: false })
    expect(nav.pushes).toEqual([{ pathname: '/(app)/projects/[id]', params: { id: 'project-1' } }])
  })
})
