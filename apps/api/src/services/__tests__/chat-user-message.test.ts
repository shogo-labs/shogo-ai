// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The person's message is durable before the turn starts (SHO-274).
 *
 * The send path used to persist the user row from a separate client POST that
 * nothing awaited, so a process killed right after Send left the agent with a
 * turn and the transcript with no question in it. The chat route now writes the
 * row itself, keyed by the id the client's bubble already carries.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { persistUserMessageForTurn } = await import('../chat-user-message')

const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

const userTurn = (id: string, text: string) => ({
  messageId: id,
  messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }],
})

describe('persistUserMessageForTurn (SHO-274)', () => {
  test('writes the message the client named, under the id its bubble carries', async () => {
    const session = await newSession()

    const result = await persistUserMessageForTurn(session, {
      messageId: 'ui-msg-1',
      messages: [
        { id: 'ui-msg-0', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'ui-msg-1', role: 'user', parts: [{ type: 'text', text: 'deploy it please' }] },
      ],
    })

    expect(result).toEqual({ id: 'ui-msg-1', created: true })
    const row = await db.chatMessage.findUnique({ where: { id: 'ui-msg-1' } })
    expect(row?.sessionId).toBe(session)
    expect(row?.role).toBe('user')
    expect(row?.content).toBe('deploy it please')
    expect(JSON.parse(row?.parts ?? '[]')).toEqual([{ type: 'text', text: 'deploy it please' }])
  })

  test('is idempotent: a retried or reconnected POST does not append a second copy', async () => {
    const session = await newSession()
    const body = userTurn('ui-msg-2', 'again')

    expect(await persistUserMessageForTurn(session, body)).toEqual({ id: 'ui-msg-2', created: true })
    expect(await persistUserMessageForTurn(session, body)).toEqual({ id: 'ui-msg-2', created: false })

    const rows = await db.chatMessage.findMany({ where: { sessionId: session, role: 'user' } })
    expect(rows).toHaveLength(1)
  })

  test('falls back to the last user message when the client named none', async () => {
    const session = await newSession()

    const result = await persistUserMessageForTurn(session, {
      messages: [
        { id: 'ui-msg-3', role: 'user', parts: [{ type: 'text', text: 'first' }] },
        { id: 'ui-msg-4', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
        { id: 'ui-msg-5', role: 'user', parts: [{ type: 'text', text: 'second' }] },
      ],
    })

    expect(result.id).toBe('ui-msg-5')
    expect((await db.chatMessage.findUnique({ where: { id: 'ui-msg-5' } }))?.content).toBe('second')
  })

  test('writes nothing when the body carries no user message (a resume or a retry)', async () => {
    const session = await newSession()

    const result = await persistUserMessageForTurn(session, {
      messages: [{ id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'only a reply' }] }],
    })

    expect(result).toEqual({ id: null, created: false })
    expect(await db.chatMessage.count({ where: { sessionId: session } })).toBe(0)
  })

  test('an id already held by another session does not swallow this message', async () => {
    const other = await newSession()
    const mine = await newSession()
    await persistUserMessageForTurn(other, userTurn('ui-msg-collide', 'theirs'))

    const result = await persistUserMessageForTurn(mine, userTurn('ui-msg-collide', 'mine'))

    expect(result.created).toBe(true)
    expect(result.id).not.toBe('ui-msg-collide')
    const rows = await db.chatMessage.findMany({ where: { sessionId: mine, role: 'user' } })
    expect(rows.map((row: { content: string }) => row.content)).toEqual(['mine'])
  })
})
