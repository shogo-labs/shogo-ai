// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /workspaces/:id/activity` is the companion Activity screen's source —
 * the third surface that renders a live chat row. It used to hand the client a
 * bare `sessionName` (the `#channel: @agent …` string) and nothing else, so the
 * screen showed the raw stored name plus a fixed sentence. The row metadata
 * `/active-chats` already returns now travels with it.
 */
import { describe, expect, mock, test } from 'bun:test'

const listCalls: Array<{ workspaceId: string; opts: unknown }> = []

const liveChat = {
  chatSessionId: 'chat-1',
  turnId: 'turn-1',
  sessionName: '#shogo-dev: @agent fix SHO-421 on your branch',
  isPrimary: false,
  projectId: 'project-1',
  projectName: 'Shogo Dev 3',
  projectHidden: false,
  startedAt: new Date('2026-11-18T15:00:00.000Z'),
  agentName: 'Shogo Dev 3',
  card: { key: 'SHO-421', title: 'Boot standalone without PROJECT_ID' },
  canStop: true,
  conversationId: 'conv-1',
  conversationName: 'shogo-dev',
  threadRootId: 'thread-1',
  messageId: 'msg-1',
}

mock.module('../chat-turn-state.service', () => ({
  listActiveChatTurns: async (workspaceId: string, opts: unknown) => {
    listCalls.push({ workspaceId, opts })
    return [liveChat]
  },
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    goalEvent: { findMany: async () => [] },
    agentTask: { findMany: async () => [] },
  },
}))

const { listWorkspaceActivity } = await import('../workspace-agent.service')

describe('listWorkspaceActivity chat rows', () => {
  test('a chat_turn carries what the row needs to name, time and stop it', async () => {
    const activity = await listWorkspaceActivity('workspace-1', 100, { viewerUserId: 'user-1' })
    const chat = activity.find((item) => item.type === 'chat_turn')
    expect(chat).toMatchObject({
      id: 'chat-1:turn-1',
      chatSessionId: 'chat-1',
      sessionName: '#shogo-dev: @agent fix SHO-421 on your branch',
      projectId: 'project-1',
      agentName: 'Shogo Dev 3',
      card: { key: 'SHO-421', title: 'Boot standalone without PROJECT_ID' },
      canStop: true,
      messageId: 'msg-1',
      conversationName: 'shogo-dev',
      threadRootId: 'thread-1',
    })
  })

  test('the viewer decides whether those rows may stop a run', async () => {
    await listWorkspaceActivity('workspace-1', 100, { viewerUserId: 'user-viewer' })
    expect(listCalls.at(-1)).toEqual({ workspaceId: 'workspace-1', opts: { viewerUserId: 'user-viewer' } })
  })
})
