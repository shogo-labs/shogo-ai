// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// --- Prisma mock ----------------------------------------------------------
const findSession = mock(async (): Promise<unknown> => null)
const findConvMessage = mock(async (): Promise<unknown> => null)
const findConvMember = mock(async (): Promise<unknown> => null)
const findWorkItem = mock(async (): Promise<unknown> => null)
const findChatMessage = mock(async (): Promise<unknown> => null)
const findUser = mock(async (): Promise<unknown> => null)

mock.module('../../lib/prisma', () => ({
  prisma: {
    chatSession: { findFirst: findSession },
    conversationMessage: { findFirst: findConvMessage },
    conversationMember: { findFirst: findConvMember },
    workItem: { findFirst: findWorkItem },
    chatMessage: { findFirst: findChatMessage },
    user: { findUnique: findUser },
    boardColumn: { findUnique: async (): Promise<unknown> => ({ name: 'In Development' }) },
  },
}))

// stub loadNamesForTexts / renderMentionsAsText (path relative to service file)
mock.module('../conversation-mentions', () => ({
  loadNamesForTexts: async () => ({}),
  renderMentionsAsText: (text: string) => text,
}))

const { peekActiveChatTurn } = await import('../chat-turn-state.service')

beforeEach(() => {
  // Reset queued mock values between tests to prevent leakage.
  findSession.mockReset()
  findConvMessage.mockReset()
  findConvMember.mockReset()
  findWorkItem.mockReset()
  findChatMessage.mockReset()
  findUser.mockReset()
  // Default: return null for all
  findSession.mockResolvedValue(null as never)
  findConvMessage.mockResolvedValue(null as never)
  findConvMember.mockResolvedValue(null as never)
  findWorkItem.mockResolvedValue(null as never)
  findChatMessage.mockResolvedValue(null as never)
  findUser.mockResolvedValue({ name: 'Russell', email: 'r@shogo.ai' } as never)
})

const startedAt = new Date('2026-11-20T05:00:00.000Z')

const baseSession = {
  id: 'session-1',
  name: null,
  inferredName: 'Build chat',
  activeTurnId: 'turn-1',
  activeTurnStartedAt: startedAt,
  workspaceId: 'ws-1',
  createdByUserId: null,
  project: { id: 'proj-1', name: 'Shogo Dev 3' },
}

const agentReply = {
  id: 'msg-agent',
  text: 'Here is my progress so far…',
  updatedAt: new Date(),
  conversationId: 'conv-1',
  threadRootId: 'root-1',
  createdAt: new Date('2026-11-20T05:01:00.000Z'),
  conversation: { kind: 'public', name: 'shogo-dev', slug: 'shogo-dev' },
}

const triggerMsg = {
  text: 'SHO-466 is yours: implement the peek hover',
  createdAt: new Date('2026-11-20T05:00:30.000Z'),
  authorType: 'user',
  authorUserId: 'user-russell',
  authorAgentRef: null,
}

describe('peekActiveChatTurn', () => {
  test('returns null when session not found', async () => {
    // findSession already returns null by default
    await expect(peekActiveChatTurn('ws-1', 'session-1', 'user-1')).resolves.toBeNull()
  })

  test('returns null when session has no active turn', async () => {
    findSession.mockResolvedValueOnce({ ...baseSession, activeTurnId: null, activeTurnStartedAt: null } as never)
    await expect(peekActiveChatTurn('ws-1', 'session-1', 'user-1')).resolves.toBeNull()
  })

  test('returns peek with trigger from the conversation thread', async () => {
    findSession.mockResolvedValueOnce(baseSession as never)
    findConvMessage
      .mockResolvedValueOnce(agentReply as never) // agent reply
      .mockResolvedValueOnce(triggerMsg as never)  // trigger
    findWorkItem.mockResolvedValueOnce({ key: 'SHO-466', title: 'Hover peek', columnId: 'col-in-dev' } as never)

    const peek = await peekActiveChatTurn('ws-1', 'session-1', 'user-1')

    expect(peek).not.toBeNull()
    expect(peek!.card).toEqual({ key: 'SHO-466', title: 'Hover peek', column: 'In Development' })
    expect(peek!.trigger).toMatchObject({ authorName: 'Russell', authorType: 'user' })
    expect(peek!.hidden).toBe(false)
  })

  test('trigger uses the top-level conversation when threadRootId is null', async () => {
    const replyNoThread = { ...agentReply, threadRootId: null }
    findSession.mockResolvedValueOnce(baseSession as never)
    findConvMessage
      .mockResolvedValueOnce(replyNoThread as never)
      .mockResolvedValueOnce(triggerMsg as never)

    const peek = await peekActiveChatTurn('ws-1', 'session-1', 'user-1')

    expect(peek!.card).toBeNull()
    expect(peek!.trigger?.authorName).toBe('Russell')
    expect(peek!.where.threadRootId).toBeNull()
  })

  test('private channel is hidden for a non-member', async () => {
    const privateReply = { ...agentReply, conversation: { kind: 'private', name: 'private-ch', slug: 'private-ch' } }
    findSession.mockResolvedValueOnce(baseSession as never)
    findConvMessage.mockResolvedValueOnce(privateReply as never)
    // findConvMember returns null (default) → not a member

    const peek = await peekActiveChatTurn('ws-1', 'session-1', 'viewer-not-member')

    expect(peek!.hidden).toBe(true)
    expect(peek!.trigger).toBeNull()
    expect(peek!.reply).toBeNull()
  })

  test('private channel is not hidden for a member', async () => {
    const privateReply = { ...agentReply, conversation: { kind: 'private', name: 'sec', slug: 'sec' } }
    findSession.mockResolvedValueOnce(baseSession as never)
    findConvMessage
      .mockResolvedValueOnce(privateReply as never)
      .mockResolvedValueOnce(triggerMsg as never)
    findConvMember.mockResolvedValueOnce({ id: 'member-1' } as never)

    const peek = await peekActiveChatTurn('ws-1', 'session-1', 'user-member')

    expect(peek!.hidden).toBe(false)
    expect(peek!.trigger).not.toBeNull()
  })

  test('a direct-chat session with createdByUserId is hidden for a different viewer', async () => {
    const chatSession = { ...baseSession, createdByUserId: 'owner-user', project: null }
    findSession.mockResolvedValueOnce(chatSession as never)
    // findConvMessage returns null → chat path

    const peek = await peekActiveChatTurn('ws-1', 'session-1', 'other-user')

    expect(peek!.hidden).toBe(true)
    expect(peek!.trigger).toBeNull()
  })

  test('a direct-chat session is visible to its owner', async () => {
    const chatSession = { ...baseSession, createdByUserId: 'owner-user', project: null }
    findSession.mockResolvedValueOnce(chatSession as never)
    // findConvMessage returns null → chat path
    findChatMessage
      .mockResolvedValueOnce({ content: 'What is the status of SHO-466?', createdAt: new Date() } as never) // trigger
      .mockResolvedValueOnce({ content: 'Working on it…', updatedAt: new Date() } as never) // reply

    const peek = await peekActiveChatTurn('ws-1', 'session-1', 'owner-user')

    expect(peek!.hidden).toBe(false)
    expect(peek!.trigger?.text).toBe('What is the status of SHO-466?')
    expect(peek!.reply?.text).toBe('Working on it…')
  })
})
