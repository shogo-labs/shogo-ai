// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  emptyWorkspaceChatActivity,
  nextWorkspaceChatActivity,
  workspaceChatActivityEvent,
} from '../workspace-chat-activity'

describe('nextWorkspaceChatActivity', () => {
  test('a starting turn makes exactly that chat the streaming one', () => {
    const state = nextWorkspaceChatActivity(emptyWorkspaceChatActivity, {
      sessionId: 'chat-1',
      isStreaming: true,
      activeSessionId: 'chat-1',
    })
    expect(state.streamingSessionId).toBe('chat-1')
    expect(state.completedSessionIds).toEqual([])
  })

  test('the turn ending clears the spinner', () => {
    const streaming = { streamingSessionId: 'chat-1', completedSessionIds: [] }
    const state = nextWorkspaceChatActivity(streaming, {
      sessionId: 'chat-1',
      isStreaming: false,
      activeSessionId: 'chat-1',
    })
    expect(state.streamingSessionId).toBeNull()
  })

  test('a finished turn in a chat nobody is looking at gets the activity dot', () => {
    const streaming = { streamingSessionId: 'chat-1', completedSessionIds: [] }
    const state = nextWorkspaceChatActivity(streaming, {
      sessionId: 'chat-1',
      isStreaming: false,
      activeSessionId: 'chat-2',
    })
    expect(state.completedSessionIds).toEqual(['chat-1'])
  })

  test('the completed set carries over to the next turn and is not duplicated', () => {
    const afterFirst = { streamingSessionId: null, completedSessionIds: ['chat-1'] }

    // A second chat starts streaming: the finished one keeps its dot.
    const second = nextWorkspaceChatActivity(afterFirst, {
      sessionId: 'chat-2',
      isStreaming: true,
      activeSessionId: 'chat-2',
    })
    expect(second.completedSessionIds).toEqual(['chat-1'])

    const finished = nextWorkspaceChatActivity(second, {
      sessionId: 'chat-2',
      isStreaming: false,
      activeSessionId: 'chat-3',
    })
    expect(finished.completedSessionIds).toEqual(['chat-1', 'chat-2'])

    // Re-streaming the flagged chat drops its dot.
    const resumed = nextWorkspaceChatActivity(finished, {
      sessionId: 'chat-1',
      isStreaming: true,
      activeSessionId: 'chat-1',
    })
    expect(resumed.completedSessionIds).toEqual(['chat-2'])
  })

  test('the initial mount "not streaming" event is not a finished turn', () => {
    const state = nextWorkspaceChatActivity(emptyWorkspaceChatActivity, {
      sessionId: 'chat-1',
      isStreaming: false,
      activeSessionId: 'chat-9',
    })
    expect(state).toBe(emptyWorkspaceChatActivity)
  })
})

describe('workspaceChatActivityEvent', () => {
  test('carries one scope id — the workspace — and never a project', () => {
    const event = workspaceChatActivityEvent('ws-1', {
      streamingSessionId: 'chat-1',
      completedSessionIds: ['chat-2'],
    })
    expect(event.workspaceId).toBe('ws-1')
    expect('projectId' in event).toBe(false)
    expect(event.streamingSessionIds).toEqual(['chat-1'])
    expect(event.completedSessionIds).toEqual(['chat-2'])
  })

  test('an idle workspace emits empty sets so stale rows clear', () => {
    const event = workspaceChatActivityEvent('ws-1', emptyWorkspaceChatActivity)
    expect(event.streamingSessionIds).toEqual([])
    expect(event.completedSessionIds).toEqual([])
  })
})
