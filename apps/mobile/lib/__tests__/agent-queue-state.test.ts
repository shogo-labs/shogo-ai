// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A reply that is waiting for an agent slot says so in its thread: the queue
 * notice rides the same `agent.delta` stream as the text, so it must survive the
 * text frames that follow it and disappear when the slot is taken.
 */
import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../team-chat-api'
import { applyTimelineEvent, emptyTimeline } from '../team-chat-state'

function agentReply(id: string): ChatMessage {
  return {
    conversationId: 'c1',
    workspaceId: 'w1',
    id,
    seq: 1,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    alsoSentToChannel: false,
    authorType: 'agent',
    author: { id: 'a1', name: 'Shogo', image: null },
    authorUserId: null,
    authorAgent: 'workspace',
    text: '',
    blocks: null,
    clientMsgId: null,
    agentSessionId: 's1',
    agentStatus: 'running',
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-22T10:00:00.000Z',
  } as ChatMessage
}

const scope = { conversationId: 'c1', threadRootId: null }
const state = { ...emptyTimeline, messages: [agentReply('m1')] }

describe('agent queue position in the timeline', () => {
  test('a queue notice is kept alongside the text already streamed', () => {
    const streamed = applyTimelineEvent(
      state,
      { type: 'agent.delta', conversationId: 'c1', messageId: 'm1', text: 'Looking into it', tool: null },
      scope,
    )
    const queued = applyTimelineEvent(
      streamed,
      {
        type: 'agent.delta',
        conversationId: 'c1',
        messageId: 'm1',
        text: '',
        tool: null,
        queue: { position: 2, ahead: 1, running: 1, limit: 1 },
      },
      scope,
    )

    expect(queued.streaming.m1?.queue).toEqual({ position: 2, ahead: 1, running: 1, limit: 1 })
    expect(queued.streaming.m1?.text).toBe('Looking into it')
  })

  test('text that arrives after the notice keeps the place in line', () => {
    const queued = applyTimelineEvent(
      state,
      {
        type: 'agent.delta',
        conversationId: 'c1',
        messageId: 'm1',
        text: '',
        tool: null,
        queue: { position: 1, ahead: 0, running: 1, limit: 1 },
      },
      scope,
    )
    const streaming = applyTimelineEvent(
      queued,
      { type: 'agent.delta', conversationId: 'c1', messageId: 'm1', text: 'On it', tool: null },
      scope,
    )

    expect(streaming.streaming.m1?.text).toBe('On it')
    expect(streaming.streaming.m1?.queue?.position).toBe(1)
  })

  test('taking the slot clears the notice', () => {
    const queued = applyTimelineEvent(
      state,
      {
        type: 'agent.delta',
        conversationId: 'c1',
        messageId: 'm1',
        text: '',
        tool: null,
        queue: { position: 1, ahead: 0, running: 1, limit: 1 },
      },
      scope,
    )
    const admitted = applyTimelineEvent(
      queued,
      { type: 'agent.delta', conversationId: 'c1', messageId: 'm1', text: 'On it', tool: null, queue: null },
      scope,
    )

    expect(admitted.streaming.m1?.queue).toBeNull()
  })
})
