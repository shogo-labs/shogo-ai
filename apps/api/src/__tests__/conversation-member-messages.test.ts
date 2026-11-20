// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Messages from <member>" (SHO-419): `listMessagesUnchecked` with `from`
 * returns one member's messages in a conversation — top-level posts and thread
 * replies alike — newest first, with full pages and a correct `hasMore`.
 *
 * The SQLite path runs against a real in-memory SQLite database, so the
 * `json_extract` / `IS` author match is exercised rather than asserted. The
 * Postgres path cannot run here, so its statement is checked for the clauses
 * that differ (the enum cast and `->>`), which is the part that would silently
 * diverge between desktop and cloud.
 *
 * Run: bun test apps/api/src/__tests__/conversation-member-messages.test.ts
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

type Row = Record<string, any>

const rows: Row[] = []
const sqlite = new Database(':memory:')
sqlite.run(`CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversationId TEXT,
  workspaceId TEXT,
  seq INTEGER,
  threadRootId TEXT,
  authorType TEXT,
  authorUserId TEXT,
  authorAgentRef TEXT,
  text TEXT,
  blocks TEXT,
  deletedAt TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  replyCount INTEGER DEFAULT 0,
  alsoSentToChannel INTEGER DEFAULT 0
)`)

/** The Postgres statement the service built, when the test asked for it. */
let lastSql = ''

const prisma: any = {
  conversationMessage: {
    findMany: async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? []
      return rows.filter((row) => ids.includes(row.id))
    },
  },
  $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
    lastSql = sql
    if (process.env.SHOGO_LOCAL_MODE !== 'true') return []
    return sqlite.query(sql).all(...(params as any[]))
  },
}

mock.module('../lib/prisma', () => ({ prisma }))
mock.module('../lib/conversation-bus', () => ({ publishConversationEvent: () => {} }))

const { listMessagesUnchecked, parseFromParam } = await import('../services/conversation.service')

const CHANNEL = 'c1'
const ADA = 'u-ada'
const GRACE = 'u-grace'
const PROJECT = 'p-alpha'

function message(over: Partial<Row> & { id: string; seq: number }): Row {
  return {
    conversationId: CHANNEL,
    workspaceId: 'w1',
    threadRootId: null,
    alsoSentToChannel: 0,
    authorType: 'user',
    authorUserId: ADA,
    authorAgentRef: null,
    text: 'hello',
    blocks: null,
    deletedAt: null,
    reactions: [],
    attachments: [],
    pin: null,
    authorUser: { id: ADA, name: 'Ada', email: 'ada@example.com', image: null },
    replyCount: 0,
    createdAt: '2026-11-18T09:00:00.000Z',
    updatedAt: '2026-11-18T09:00:00.000Z',
    ...over,
  }
}

function agentMessage(over: Partial<Row> & { id: string; seq: number }, projectId: string | null): Row {
  return message({
    authorType: 'agent',
    authorUserId: null,
    authorUser: null,
    authorAgentRef: JSON.stringify({ projectId, name: projectId ? 'Alpha' : 'Shogo' }),
    ...over,
  })
}

beforeEach(() => {
  rows.length = 0
  sqlite.run('DELETE FROM conversation_messages')
  lastSql = ''
  process.env.SHOGO_LOCAL_MODE = 'true'
})

function seed(list: Row[]) {
  for (const row of list) {
    rows.push(row)
    sqlite.run(
      `INSERT INTO conversation_messages
        (id, conversationId, workspaceId, seq, threadRootId, authorType, authorUserId, authorAgentRef, text, blocks, deletedAt, createdAt, updatedAt, replyCount, alsoSentToChannel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.conversationId, row.workspaceId, row.seq, row.threadRootId, row.authorType,
        row.authorUserId, row.authorAgentRef, row.text, row.blocks, row.deletedAt, row.createdAt,
        row.updatedAt, row.replyCount, row.alsoSentToChannel,
      ],
    )
  }
}

describe('parseFromParam', () => {
  test('reads the three shapes the pane opens with', () => {
    expect(parseFromParam('user:u-ada')).toEqual({ type: 'user', userId: 'u-ada' })
    expect(parseFromParam('agent:p-alpha')).toEqual({ type: 'agent', projectId: 'p-alpha' })
    expect(parseFromParam('agent:ws')).toEqual({ type: 'agent', projectId: null })
  })

  test('no value means no filter', () => {
    expect(parseFromParam(undefined)).toBeUndefined()
    expect(parseFromParam('')).toBeUndefined()
    expect(parseFromParam('   ')).toBeUndefined()
  })

  test('anything else is a 400 rather than a silently unfiltered page', () => {
    for (const bad of ['user:', 'agent:', 'ada', 'channel:general', 'user']) {
      expect(() => parseFromParam(bad)).toThrow(/from must be/)
    }
  })
})

describe('listMessagesUnchecked — from a person', () => {
  test('returns their top-level posts and thread replies, newest first', async () => {
    seed([
      message({ id: 'ada-1', seq: 1 }),
      message({ id: 'grace-1', seq: 2, authorUserId: GRACE }),
      message({ id: 'ada-reply', seq: 3, threadRootId: 'grace-1' }),
      message({ id: 'ada-2', seq: 4 }),
    ])
    const result = await listMessagesUnchecked(CHANNEL, { from: { type: 'user', userId: ADA } })
    expect(result.messages.map((m: any) => m.id)).toEqual(['ada-2', 'ada-reply', 'ada-1'])
    expect(result.hasMore).toBe(false)
  })

  test('a reply says which thread it belongs to', async () => {
    seed([message({ id: 'root', seq: 1 }), message({ id: 'reply', seq: 2, threadRootId: 'root' })])
    const result = await listMessagesUnchecked(CHANNEL, { from: { type: 'user', userId: ADA } })
    const reply = result.messages.find((m: any) => m.id === 'reply')
    expect(reply.threadRootId).toBe('root')
  })

  test('deleted and system messages are left out', async () => {
    seed([
      message({ id: 'kept', seq: 1 }),
      message({ id: 'deleted', seq: 2, deletedAt: '2026-11-18T10:00:00.000Z' }),
      message({ id: 'system', seq: 3, authorType: 'system', authorUserId: null }),
    ])
    const result = await listMessagesUnchecked(CHANNEL, { from: { type: 'user', userId: ADA } })
    expect(result.messages.map((m: any) => m.id)).toEqual(['kept'])
  })

  test('pages are full and hasMore is right when other authors are interleaved', async () => {
    seed([
      message({ id: 'ada-1', seq: 1 }),
      message({ id: 'grace-1', seq: 2, authorUserId: GRACE }),
      message({ id: 'ada-2', seq: 3 }),
      message({ id: 'grace-2', seq: 4, authorUserId: GRACE }),
      message({ id: 'ada-3', seq: 5 }),
    ])
    const first = await listMessagesUnchecked(CHANNEL, { from: { type: 'user', userId: ADA }, limit: 2 })
    expect(first.messages.map((m: any) => m.id)).toEqual(['ada-3', 'ada-2'])
    expect(first.hasMore).toBe(true)
    const second = await listMessagesUnchecked(CHANNEL, {
      from: { type: 'user', userId: ADA },
      limit: 2,
      beforeSeq: 3,
    })
    expect(second.messages.map((m: any) => m.id)).toEqual(['ada-1'])
    expect(second.hasMore).toBe(false)
  })

  test('someone who never posted gets an empty page, not the channel', async () => {
    seed([message({ id: 'ada-1', seq: 1 })])
    const result = await listMessagesUnchecked(CHANNEL, { from: { type: 'user', userId: 'u-nobody' } })
    expect(result.messages).toEqual([])
    expect(result.hasMore).toBe(false)
  })
})

describe('listMessagesUnchecked — from an agent', () => {
  test('matches one project agent, not the others', async () => {
    seed([
      agentMessage({ id: 'alpha-1', seq: 1 }, PROJECT),
      agentMessage({ id: 'beta-1', seq: 2 }, 'p-beta'),
      agentMessage({ id: 'ws-1', seq: 3 }, null),
      message({ id: 'ada-1', seq: 4 }),
    ])
    const result = await listMessagesUnchecked(CHANNEL, { from: { type: 'agent', projectId: PROJECT } })
    expect(result.messages.map((m: any) => m.id)).toEqual(['alpha-1'])
  })

  test('agent:ws is the workspace agent, whose ref has no project', async () => {
    seed([
      agentMessage({ id: 'alpha-1', seq: 1 }, PROJECT),
      agentMessage({ id: 'ws-1', seq: 2 }, null),
    ])
    const result = await listMessagesUnchecked(CHANNEL, { from: { type: 'agent', projectId: null } })
    expect(result.messages.map((m: any) => m.id)).toEqual(['ws-1'])
  })

  test('an agent page is full even when people posted in between', async () => {
    seed([
      agentMessage({ id: 'alpha-1', seq: 1 }, PROJECT),
      message({ id: 'ada-1', seq: 2 }),
      agentMessage({ id: 'alpha-2', seq: 3 }, PROJECT),
      message({ id: 'ada-2', seq: 4 }),
      agentMessage({ id: 'alpha-3', seq: 5 }, PROJECT),
    ])
    const first = await listMessagesUnchecked(CHANNEL, { from: { type: 'agent', projectId: PROJECT }, limit: 2 })
    expect(first.messages.map((m: any) => m.id)).toEqual(['alpha-3', 'alpha-2'])
    expect(first.hasMore).toBe(true)
  })

  test('a ref that is not valid JSON does not take the page down', async () => {
    seed([
      agentMessage({ id: 'alpha-1', seq: 1 }, PROJECT),
      message({ id: 'broken', seq: 2, authorType: 'agent', authorUserId: null, authorAgentRef: 'not json' }),
    ])
    const result = await listMessagesUnchecked(CHANNEL, { from: { type: 'agent', projectId: PROJECT } })
    expect(result.messages.map((m: any) => m.id)).toEqual(['alpha-1'])
  })
})

describe('listMessagesUnchecked — from is its own view', () => {
  test('it cannot be combined with a thread or delta read', async () => {
    const from = { type: 'user' as const, userId: ADA }
    await expect(listMessagesUnchecked(CHANNEL, { from, threadRootId: 'root' })).rejects.toThrow(/cannot be combined/)
    await expect(listMessagesUnchecked(CHANNEL, { from, afterSeq: 3 })).rejects.toThrow(/cannot be combined/)
    await expect(
      listMessagesUnchecked(CHANNEL, { from, changedSince: new Date('2026-11-18T09:00:00.000Z') }),
    ).rejects.toThrow(/cannot be combined/)
  })
})

describe('the Postgres statement', () => {
  test('casts the enum and reads the agent ref with ->>', async () => {
    process.env.SHOGO_LOCAL_MODE = 'false'
    await listMessagesUnchecked(CHANNEL, { from: { type: 'agent', projectId: PROJECT } })
    expect(lastSql).toContain(`m."authorType"::text = 'agent'`)
    expect(lastSql).toContain(`m."authorAgentRef"->>'projectId' IS NOT DISTINCT FROM $2`)
    expect(lastSql).toContain(`ORDER BY m."seq" DESC`)
    expect(lastSql).not.toContain('json_extract')
  })

  test('a person is matched on the column, with no JSON at all', async () => {
    process.env.SHOGO_LOCAL_MODE = 'false'
    await listMessagesUnchecked(CHANNEL, { from: { type: 'user', userId: ADA } })
    expect(lastSql).toContain(`m."authorUserId" = $2`)
    expect(lastSql).not.toContain('authorAgentRef')
  })
})
