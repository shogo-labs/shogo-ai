// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repair on read: opening a call chat whose reply never landed writes the
 * missing assistant row from the durable call record — once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { _testing as agentCallStoreTesting } from '../../lib/agent-call-store'
import { reconcileCallReplyOnRead } from '../agent-call-reconcile.service'

const SESSION = 'chat-reconcile-1'
const PROMPT_AT = new Date('2026-10-18T18:00:00.000Z')

/** Just enough of a Prisma client for the newest-row query, the insert and the counter. */
function fakeDb(rows: any[]) {
  const state = { rows, sessionUpdates: 0 }
  return {
    state,
    chatMessage: {
      findFirst: async ({ where }: any) => {
        const matching = state.rows.filter((r) => r.sessionId === where.sessionId)
        if (matching.length === 0) return null
        return [...matching].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
      },
      create: async ({ data }: any) => {
        state.rows.push({ ...data, createdAt: new Date('2026-10-18T18:05:00.000Z') })
        return data
      },
    },
    chatSession: {
      update: async () => {
        state.sessionUpdates++
        return {}
      },
    },
  }
}

function promptRow() {
  return {
    sessionId: SESSION,
    role: 'user',
    agent: 'project_call',
    content: 'do it',
    parts: JSON.stringify([
      { type: 'text', text: 'do it' },
      { type: 'data-project-call', data: { runId: 'run-1', callerName: 'Caller' } },
    ]),
    createdAt: PROMPT_AT,
  }
}

function replyRow(text = 'the answer') {
  return {
    sessionId: SESSION,
    role: 'assistant',
    agent: 'technical',
    content: text,
    parts: JSON.stringify([{ type: 'text', text }]),
    createdAt: new Date(PROMPT_AT.getTime() + 5_000),
  }
}

function seedCall(record: any) {
  agentCallStoreTesting.records.set(`agent-call:proj-1:run-1`, {
    record: { runId: 'run-1', sessionId: SESSION, chatSessionId: SESSION, startedAt: PROMPT_AT.getTime(), updatedAt: PROMPT_AT.getTime(), ...record },
    expiresAt: Date.now() + 60_000,
  })
  agentCallStoreTesting.sessionLinks.set(`agent-call-session:${SESSION}`, {
    link: { projectId: 'proj-1', runId: 'run-1', startedAt: PROMPT_AT.getTime() },
    expiresAt: Date.now() + 60_000,
  })
}

beforeEach(() => {
  agentCallStoreTesting.records.clear()
  agentCallStoreTesting.sessionLinks.clear()
})
afterEach(() => {
  agentCallStoreTesting.records.clear()
  agentCallStoreTesting.sessionLinks.clear()
})

describe('reconcileCallReplyOnRead', () => {
  it('writes the reply of a terminal call whose chat only has the prompt', async () => {
    const db = fakeDb([promptRow()])
    seedCall({ status: 'completed', reply: 'PONG' })

    expect(await reconcileCallReplyOnRead(db, SESSION)).toBe(true)

    const replies = db.state.rows.filter((r) => r.role === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ agent: 'technical', content: 'PONG' })
    expect(db.state.sessionUpdates).toBe(1)
  })

  it('is idempotent: a chat that already has its reply is not written again', async () => {
    const db = fakeDb([promptRow(), replyRow()])
    seedCall({ status: 'completed', reply: 'PONG' })

    expect(await reconcileCallReplyOnRead(db, SESSION)).toBe(false)
    expect(db.state.rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
  })

  it('does nothing while the call is still running', async () => {
    const db = fakeDb([promptRow()])
    seedCall({ status: 'running' })

    expect(await reconcileCallReplyOnRead(db, SESSION)).toBe(false)
    expect(db.state.rows).toHaveLength(1)
  })

  it('writes an explicit failure row for a terminal call that has no reply text', async () => {
    const db = fakeDb([promptRow()])
    seedCall({ status: 'failed', reply: null, error: { code: 'callee_turn_lost', message: 'lost' } })

    expect(await reconcileCallReplyOnRead(db, SESSION)).toBe(true)
    const replies = db.state.rows.filter((r) => r.role === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0].content).toContain('callee_turn_lost')
  })

  it('ignores a chat whose newest row is not a call prompt', async () => {
    const db = fakeDb([
      promptRow(),
      replyRow(),
      { sessionId: SESSION, role: 'user', agent: 'technical', content: 'hi', createdAt: new Date() },
    ])
    seedCall({ status: 'completed', reply: 'PONG' })

    expect(await reconcileCallReplyOnRead(db, SESSION)).toBe(false)
    expect(db.state.rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
  })

  it('ignores a chat with no tracked call behind it', async () => {
    const db = fakeDb([promptRow()])
    expect(await reconcileCallReplyOnRead(db, SESSION)).toBe(false)
    expect(db.state.rows).toHaveLength(1)
  })

  it('never throws when the database fails', async () => {
    const db = {
      chatMessage: {
        findFirst: async () => {
          throw new Error('db down')
        },
        create: async () => ({}),
      },
      chatSession: { update: async () => ({}) },
    }
    seedCall({ status: 'completed', reply: 'PONG' })
    expect(await reconcileCallReplyOnRead(db, SESSION)).toBe(false)
  })
})
