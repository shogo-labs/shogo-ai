// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-52: a `<@c:CHAT_ID>` tag reaches the chat it names.
 *
 * These tests drive the real delivery + mentionable logic against a mocked
 * database and a mocked queue dispatcher, so they pin the behaviour that
 * matters: the origin line, the wire token never surviving as an id, the
 * guards (no self-tag, no fan-out, no chat the sender cannot open), and the
 * fact that delivery goes through the target chat's own queue.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

interface Row {
  id: string
  name: string
  inferredName: string
  contextType: string
  contextId: string | null
  workspaceId: string | null
  isArchived: boolean
  lastActiveAt: Date
  /** Null on every chat the local/desktop path creates (SHO-118). */
  createdByUserId: string | null
  activeTurnId?: string | null
  project?: { id: string; name: string; workspaceId: string; workspace: { name: string } } | null
  workspace?: { id: string; name: string } | null
}

const now = new Date('2026-10-19T12:00:00Z')

const chats = new Map<string, Row>([
  [
    'chat-source',
    {
      id: 'chat-source',
      name: 'Billing bug',
      inferredName: '',
      contextType: 'workspace',
      contextId: null,
      workspaceId: 'ws-1',
      isArchived: false,
      lastActiveAt: now,
      createdByUserId: 'user-1',
      workspace: { id: 'ws-1', name: 'Acme' },
    },
  ],
  [
    'chat-target',
    {
      id: 'chat-target',
      name: 'Deploy notes',
      inferredName: '',
      contextType: 'project',
      contextId: 'proj-2',
      workspaceId: null,
      isArchived: false,
      lastActiveAt: new Date('2026-10-19T11:00:00Z'),
      createdByUserId: 'user-1',
      project: { id: 'proj-2', name: 'Web app', workspaceId: 'ws-2', workspace: { name: 'Other team' } },
    },
  ],
  [
    'chat-busy',
    {
      id: 'chat-busy',
      name: 'Migration plan',
      inferredName: '',
      contextType: 'workspace',
      contextId: null,
      workspaceId: 'ws-1',
      isArchived: false,
      lastActiveAt: new Date('2026-10-19T11:30:00Z'),
      createdByUserId: 'user-1',
      activeTurnId: 'turn-live',
      workspace: { id: 'ws-1', name: 'Acme' },
    },
  ],
  [
    'chat-archived',
    {
      id: 'chat-archived',
      name: 'Old chat',
      inferredName: '',
      contextType: 'workspace',
      contextId: null,
      workspaceId: 'ws-1',
      isArchived: true,
      lastActiveAt: new Date('2026-10-01T11:00:00Z'),
      createdByUserId: 'user-1',
      workspace: { id: 'ws-1', name: 'Acme' },
    },
  ],
  // The shape `createWorkspaceSession({ anchorProjectId })` writes: anchored on
  // a project, no owner at all.
  [
    'chat-anchored',
    {
      id: 'chat-anchored',
      name: 'Anchored on Web app',
      inferredName: '',
      contextType: 'workspace',
      contextId: 'proj-2',
      workspaceId: null,
      isArchived: false,
      lastActiveAt: new Date('2026-10-19T10:30:00Z'),
      createdByUserId: null,
      workspace: { id: 'ws-1', name: 'Acme' },
    },
  ],
  // Unowned, unanchored, in a workspace the person belongs to.
  [
    'chat-unowned',
    {
      id: 'chat-unowned',
      name: 'Workspace chat',
      inferredName: '',
      contextType: 'workspace',
      contextId: null,
      workspaceId: 'ws-1',
      isArchived: false,
      lastActiveAt: new Date('2026-10-19T10:00:00Z'),
      createdByUserId: null,
      workspace: { id: 'ws-1', name: 'Acme' },
    },
  ],
  // Unowned, and in a workspace the person is NOT a member of: stays closed.
  [
    'chat-foreign',
    {
      id: 'chat-foreign',
      name: 'Someone else\'s chat',
      inferredName: '',
      contextType: 'workspace',
      contextId: null,
      workspaceId: 'ws-3',
      isArchived: false,
      lastActiveAt: new Date('2026-10-19T09:00:00Z'),
      createdByUserId: null,
      workspace: { id: 'ws-3', name: 'Elsewhere' },
    },
  ],
])

const queued: any[] = []
const persisted: any[] = []
const dispatched: string[] = []

/**
 * Evaluate the slices of Prisma `where` these queries actually use — including
 * the access `OR` — so a chat is filtered by the rule under test rather than by
 * whatever the test happens to list.
 */
async function matchesWhere(row: Row, where: any, projectIds?: string[], workspaceIds?: string[]): Promise<boolean> {
  if (!where || typeof where !== 'object') return true
  if (Array.isArray(where.AND)) {
    for (const clause of where.AND) {
      if (!(await matchesWhere(row, clause))) return false
    }
  }
  if (Array.isArray(where.OR)) {
    let any = false
    for (const clause of where.OR) {
      if (await matchesWhere(row, clause)) {
        any = true
        break
      }
    }
    if (!any) return false
  }
  if (where.id !== undefined) {
    const wanted = where.id
    if (typeof wanted === 'string' && row.id !== wanted) return false
    if (wanted && typeof wanted === 'object') {
      if (Array.isArray(wanted.in) && !wanted.in.includes(row.id)) return false
      if (typeof wanted.not === 'string' && row.id === wanted.not) return false
    }
  }
  if (typeof where.isArchived === 'boolean' && row.isArchived !== where.isArchived) return false
  if (where.contextType !== undefined && row.contextType !== where.contextType) return false
  if (where.createdByUserId !== undefined && row.createdByUserId !== where.createdByUserId) return false
  if (where.workspaceId !== undefined) {
    const wanted = where.workspaceId
    if (typeof wanted === 'string' ? row.workspaceId !== wanted : !wanted?.in?.includes(row.workspaceId)) return false
  }
  if (where.contextId !== undefined) {
    const wanted = where.contextId
    if (wanted === null ? row.contextId !== null : !wanted?.in?.includes(row.contextId)) return false
  }
  return true
}

mock.module('../lib/prisma', () => ({
  prisma: {
    member: {
      findMany: async () => [{ role: 'member', workspaceId: 'ws-1', projectId: null }],
      findFirst: async () => ({ id: 'member-1', role: 'member' }),
    },
    user: {
      findUnique: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com', role: 'user' }),
    },
    project: {
      findMany: async () => [{ id: 'proj-1' }, { id: 'proj-2' }],
    },
    chatSession: {
      findFirst: async (args: any) => {
        const id = args?.where?.AND?.[0]?.id
        const chat = typeof id === 'string' ? chats.get(id) ?? null : null
        return chat && (await matchesWhere(chat, args?.where)) ? chat : null
      },
      findMany: async (args: any) => {
        const rows: Row[] = []
        for (const chat of chats.values()) {
          if (await matchesWhere(chat, args?.where)) rows.push(chat)
        }
        return rows.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
      },
    },
    chatQueuedMessage: {
      create: async (args: any) => {
        queued.push(args.data)
        return args.data
      },
      findFirst: async () => null,
    },
    chatMessage: {
      upsert: async (args: any) => {
        persisted.push(args.create)
        return args.create
      },
      findMany: async () => [],
    },
  },
}))

mock.module('../services/chat-queue-dispatcher.service', () => ({
  dispatchNext: async (sessionId: string) => {
    dispatched.push(sessionId)
    return true
  },
}))

const { deliverChatMentions, handOffToChat, chatHandoffText, isChatHandoff } = await import(
  '../services/chat-mention-delivery.service'
)
const { listChatMentionables, resolveChatForUser } = await import('../lib/chat-mentionables')
const { mentionedChatIds, chatReferenceIds, renderMentionsAsText, chatMentionToken, parseMentions } =
  await import('../services/conversation-mentions')

beforeEach(() => {
  queued.length = 0
  persisted.length = 0
  dispatched.length = 0
})

describe('chat mention tokens', () => {
  test('reads <@c:ID> tokens in order, once each', () => {
    expect(mentionedChatIds('hi <@c:a> and <@c:b> and again <@c:a>')).toEqual(['a', 'b'])
    expect(chatMentionToken('x')).toBe('<@c:x>')
    expect(parseMentions('<@c:x>')).toEqual([{ targetType: 'chat', chatId: 'x' }])
  })

  // SHO-191: the workspace chat turns these ids into pointer references instead
  // of delivering to them, so the list has to skip the chat itself and anything
  // the composer already sent as a reference.
  test('picks the chats a workspace tag should point at', () => {
    const text = 'look at <@c:a> and <@c:b>'
    expect(chatReferenceIds(text, { selfSessionId: 'self', existing: ['a'] })).toEqual(['b'])
    expect(chatReferenceIds('only <@c:self>', { selfSessionId: 'self' })).toEqual([])
    expect(chatReferenceIds('no tags here', { selfSessionId: 'self' })).toEqual([])
  })

  test('renders a token as its title, falling back to "chat"', () => {
    const names = { chats: new Map([['a', 'Deploy notes']]) }
    expect(renderMentionsAsText('<@c:a> look', names)).toBe('@Deploy notes look')
    expect(renderMentionsAsText('<@c:b> look', names)).toBe('@chat look')
  })
})

describe('chat mention access', () => {
  test('offers the person their own chats and readable project chats, across workspaces', async () => {
    const chats = await listChatMentionables({ userId: 'user-1' })
    expect(chats.map((chat) => chat.id)).toEqual([
      'chat-source',
      'chat-busy',
      'chat-target',
      'chat-anchored',
      'chat-unowned',
    ])
    expect(chats.find((chat) => chat.id === 'chat-target')?.workspaceName).toBe('Other team')
  })

  // SHO-118: the three ids from the issue are the ordinary shapes the product
  // writes, and every one of them 404'd before this clause existed.
  test('opens a workspace chat anchored on a readable project, with no owner', async () => {
    expect(await resolveChatForUser('user-1', 'chat-anchored')).not.toBeNull()
    expect((await listChatMentionables({ userId: 'user-1' })).map((chat) => chat.id)).toContain('chat-anchored')
  })

  test('opens an unowned workspace chat in a workspace the person belongs to', async () => {
    expect(await resolveChatForUser('user-1', 'chat-unowned')).not.toBeNull()
  })

  test('still refuses an unowned chat in a workspace the person is not a member of', async () => {
    expect(await resolveChatForUser('user-1', 'chat-foreign')).toBeNull()
    expect((await listChatMentionables({ userId: 'user-1' })).map((chat) => chat.id)).not.toContain('chat-foreign')
  })

  test('a handoff into an anchored chat delivers like any other', async () => {
    const delivered = await handOffToChat({
      targetChatId: 'chat-anchored',
      text: 'read the plan',
      actingUserId: 'user-1',
      sourceSessionId: 'chat-source',
    })
    expect(delivered?.started).toBe(true)
    expect(queued[0].sessionId).toBe('chat-anchored')
    expect(dispatched).toEqual(['chat-anchored'])
  })

  test('never offers an archived chat', async () => {
    const chats = await listChatMentionables({ userId: 'user-1' })
    expect(chats.some((chat) => chat.id === 'chat-archived')).toBeFalsy()
    expect(await resolveChatForUser('user-1', 'chat-archived')).toBeNull()
  })

  test('filters by title when the picker has a query', async () => {
    const chats = await listChatMentionables({ userId: 'user-1', query: 'deploy' })
    expect(chats.map((chat) => chat.id)).toEqual(['chat-target'])
  })
})

describe('deliverChatMentions', () => {
  test('delivers into the tagged chat with a one-line origin and no token for itself', async () => {
    const result = await deliverChatMentions({
      text: 'please take this <@c:chat-target> and <@c:chat-source>',
      actingUserId: 'user-1',
      sourceSessionId: 'chat-source',
    })

    expect(result.delivered.map((chat) => chat.id)).toEqual(['chat-target'])
    // Tagging the chat you are in does nothing.
    expect(result.dropped).toEqual(['chat-source'])
    expect(dispatched).toEqual(['chat-target'])

    const row = queued[0]
    expect(row.sessionId).toBe('chat-target')
    expect(row.content).toContain('From @Ada Lovelace in "Billing bug" (Acme):')
    expect(row.content).not.toContain('<@c:chat-target>')

    const body = JSON.parse(row.body)
    expect(body.origin.handoffFromChatId).toBe('chat-source')
    expect(body.origin.handoffFromUserId).toBe('user-1')
    expect(body.references).toEqual([
      { type: 'chat', id: 'chat-source', name: 'Billing bug' },
    ])
    // The origin also rides on the text part, because the queue row is deleted
    // on dispatch and the persisted ChatMessage is what the chip's durable
    // `delivered` state reads afterwards.
    const parts = JSON.parse(row.parts)
    expect(parts[0]).toMatchObject({ type: 'text', text: row.content })
    expect(parts[0].handoff.handoffFromChatId).toBe('chat-source')
    expect(parts[0].handoff.handoffFromUserId).toBe('user-1')
    // No transcript bubble while it is only queued: the dispatcher persists
    // this same row id when it takes the row and the turn starts (SHO-45).
    expect(persisted).toEqual([])
  })

  test('queues instead of starting a turn when the target is mid-turn', async () => {
    const delivered = await handOffToChat({
      targetChatId: 'chat-busy',
      text: 'over to you too',
      actingUserId: 'user-1',
      sourceSessionId: 'chat-source',
    })
    expect(delivered?.started).toBe(false)
    expect(queued).toHaveLength(1)
    // Queued ⇒ dock only: the target's transcript stays empty until its
    // dispatcher takes the row, so a busy chat is not shown a message it has
    // not started on.
    expect(persisted).toEqual([])
    // The row is drained by the target's own queue when its turn ends.
    expect(dispatched).toEqual([])
  })

  test('a chat the sender cannot open is dropped, never delivered', async () => {
    const result = await deliverChatMentions({
      text: 'sneaky <@c:not-mine>',
      actingUserId: 'user-1',
      sourceSessionId: 'chat-source',
    })
    expect(result.delivered).toEqual([])
    expect(result.dropped).toEqual(['not-mine'])
    expect(queued).toEqual([])
  })

  test('a message with no chat token touches nothing', async () => {
    const result = await deliverChatMentions({
      text: 'plain message',
      actingUserId: 'user-1',
      sourceSessionId: 'chat-source',
    })
    expect(result.delivered).toEqual([])
    expect(queued).toEqual([])
    expect(dispatched).toEqual([])
  })
})

describe('handoff detection on a send body', () => {
  test('a delivered handoff is recognised so it never fans out again', () => {
    expect(isChatHandoff({ origin: { handoffFromChatId: 'chat-source' } })).toBe(true)
    expect(isChatHandoff({ text: 'hi' })).toBe(false)
  })

  test('finds the typed text on either body shape', () => {
    expect(chatHandoffText({ text: 'hello' })).toBe('hello')
    expect(
      chatHandoffText({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'old' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
          { role: 'user', parts: [{ type: 'text', text: 'newest <@c:a>' }] },
        ],
      }),
    ).toBe('newest <@c:a>')
  })
})
