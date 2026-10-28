// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-52 HTTP surface: the composer's chat picker and the source chip's
 * delivery state. Access is decided per chat on the server, so these tests pin
 * the auth gate and the fact that an unopenable chat is never described.
 */

import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const openable = new Set(['chat-a', 'chat-b', 'chat-c'])

mock.module('../lib/chat-mentionables', () => ({
  listChatMentionables: async (options: { ids?: string[]; excludeSessionId?: string }) => {
    const ids = (options.ids ?? [...openable]).filter(
      (id) => openable.has(id) && id !== options.excludeSessionId,
    )
    return ids.map((id) => ({
      id,
      title: id === 'chat-a' ? 'Deploy notes' : 'Billing bug',
      contextType: 'workspace',
      projectId: null,
      projectName: null,
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
      lastActiveAt: '2026-10-19T12:00:00.000Z',
    }))
  },
  resolveChatForUser: async (_userId: string, chatId: string) =>
    openable.has(chatId) ? { id: chatId } : null,
}))

const handoffParts = JSON.stringify([
  {
    type: 'text',
    text: 'From @me in "Deploy notes" (Acme):\n\nthe handoff',
    handoff: {
      handoffFromChatId: 'chat-a',
      handoffFromUserId: 'user-1',
      handoffAt: '2026-10-19T12:02:00.000Z',
    },
  },
])

/** A message a person typed in a chat is not a handoff. */
const plainParts = JSON.stringify([{ type: 'text', text: 'just typing' }])

mock.module('../lib/prisma', () => {
  // Like Prisma, only the requested chats come back.
  const asked = (args: any): string[] =>
    args?.where?.sessionId?.in ?? args?.where?.id?.in ?? []
  return {
    prisma: {
      chatSession: {
        findMany: async (args: any) =>
          [
            { id: 'chat-a', activeTurnId: 'turn-1', activeTurnHeartbeatAt: new Date() },
            { id: 'chat-b', activeTurnId: null, activeTurnHeartbeatAt: null },
            { id: 'chat-c', activeTurnId: 'turn-2', activeTurnHeartbeatAt: new Date() },
          ].filter((row) => asked(args).includes(row.id)),
      },
      chatQueuedMessage: {
        // chat-b's handoff is still waiting its turn. chat-a has a queue row of
        // its own, but no handoff — a workspace-chat tag sends nothing.
        findMany: async (args: any) =>
          [
            { sessionId: 'chat-b', parts: handoffParts },
            { sessionId: 'chat-a', parts: plainParts },
          ].filter((row) => asked(args).includes(row.sessionId)),
      },
      chatMessage: {
        findMany: async (args: any) => {
          const rows =
            args?.where?.role === 'user'
              ? [
                  // A delivered handoff (its origin rides on the text part).
                  { sessionId: 'chat-c', createdAt: new Date('2026-10-19T12:02:00Z'), parts: handoffParts },
                  // A message a person typed in the target chat is not a delivery.
                  { sessionId: 'chat-a', createdAt: new Date('2026-10-19T12:03:00Z'), parts: plainParts },
                ]
              : [{ sessionId: 'chat-c', createdAt: new Date('2026-10-19T12:05:00Z') }]
          return rows.filter((row) => asked(args).includes(row.sessionId))
        },
      },
    },
  }
})

const { chatMentionRoutes } = await import('../routes/chat-mentions')

function appFor(userId: string | null) {
  const app = new Hono()
  app.route('/api', chatMentionRoutes({ resolveUserId: async () => userId }))
  return app
}

describe('GET /api/chat-mentionables', () => {
  test('requires authentication', async () => {
    expect((await appFor(null).request('/api/chat-mentionables?q=deploy')).status).toBe(401)
  })

  test('returns chats with their workspace so duplicates are distinguishable', async () => {
    const response = await appFor('user-1').request('/api/chat-mentionables?q=')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.chats.map((chat: any) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-c'])
    expect(body.chats[0].workspaceName).toBe('Acme')
  })

  test('drops the chat the composer is already in', async () => {
    const response = await appFor('user-1').request('/api/chat-mentionables?exclude=chat-a')
    const body = await response.json()
    expect(body.chats.map((chat: any) => chat.id)).toEqual(['chat-b', 'chat-c'])
  })

  test('resolves titles by id for chips in an old message', async () => {
    const response = await appFor('user-1').request('/api/chat-mentionables?ids=chat-b,gone')
    const body = await response.json()
    expect(body.chats.map((chat: any) => chat.id)).toEqual(['chat-b'])
  })
})

describe('GET /api/chat-mention-status', () => {
  test('requires authentication', async () => {
    expect((await appFor(null).request('/api/chat-mention-status?ids=chat-a')).status).toBe(401)
  })

  test('reports a chat only once it actually took a handoff', async () => {
    const response = await appFor('user-1').request(
      '/api/chat-mention-status?ids=chat-a,chat-b,chat-c,not-mine&since=2026-10-19T12:00:00.000Z',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    // chat-a is openable and busy, but nothing was handed to it: a workspace-chat
    // tag is context (SHO-191), so it must not read as a delivery.
    expect(Object.keys(body.statuses).sort()).toEqual(['chat-b', 'chat-c'])
    expect(body.statuses['chat-a']).toBeUndefined()
    // chat-b's handoff is still queued; chat-c's started and answered.
    expect(body.statuses['chat-b']).toMatchObject({ queued: 1, working: false, repliedAt: null })
    expect(body.statuses['chat-c']).toMatchObject({ queued: 0, working: true, repliedAt: expect.any(String) })
  })

  test('keeps a durable delivered state once the handoff is persisted', async () => {
    const response = await appFor('user-1').request(
      '/api/chat-mention-status?ids=chat-b,chat-c&since=2026-10-19T12:00:00.000Z',
    )
    const body = await response.json()
    // chat-c's handoff message is what proves delivery even before/after a reply.
    expect(body.statuses['chat-c'].deliveredAt).toBe('2026-10-19T12:02:00.000Z')
    // chat-b has nothing persisted yet — only its queued handoff row.
    expect(body.statuses['chat-b'].deliveredAt).toBeNull()
  })

  test('does not report a reply the target chat had for someone else', async () => {
    const response = await appFor('user-1').request(
      '/api/chat-mention-status?ids=chat-a&since=2026-10-19T12:00:00.000Z',
    )
    expect(await response.json()).toEqual({ statuses: {} })
  })

  test('returns nothing for ids the caller cannot open', async () => {
    const response = await appFor('user-1').request('/api/chat-mention-status?ids=not-mine')
    expect(await response.json()).toEqual({ statuses: {} })
  })
})
