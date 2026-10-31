// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A turn killed mid-stream leaves an assistant row that looks exactly like a
 * reply still being written, so the client dropped it on the next resume replay
 * and the person lost the text they had already read. The API now marks that row
 * ended — keeping its text — before anything else is written (SHO-274).
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { stampTurnInterrupted, TURN_INTERRUPTED_PART } = await import('../services/chat-resume.service')

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

async function addAssistant(session: string, content: string, parts: unknown): Promise<string> {
  const row = await db.chatMessage.create({
    data: {
      sessionId: session,
      role: 'assistant',
      content,
      parts: typeof parts === 'string' ? parts : JSON.stringify(parts),
      agent: 'technical',
      model: 'auto',
    },
  })
  return row.id
}

const parse = (raw: string | null) => JSON.parse(raw ?? '[]') as any[]

describe('stampTurnInterrupted (SHO-274)', () => {
  test('keeps the streamed text and marks the row ended', async () => {
    const session = await newSession()
    const id = await addAssistant(session, 'Reading the migration files', [
      { type: 'text', text: 'Reading the migration files' },
      { type: 'data-turn-timing', data: { startedAt: Date.now() - 5_000 } },
    ])

    const result = await stampTurnInterrupted(session, { reason: 'interrupted_exec' })

    expect(result.stamped).toBe(true)
    expect(result.wroteNote).toBe(false)
    const row = await db.chatMessage.findUnique({ where: { id } })
    // The text the person already read is untouched.
    expect(row.content).toBe('Reading the migration files')
    const parts = parse(row.parts)
    expect(parts.find((p) => p.type === 'text')?.text).toBe('Reading the migration files')
    expect(parts.some((p) => p.type === TURN_INTERRUPTED_PART)).toBe(true)
    // No extra row: this is the same turn, now closed.
    expect(await db.chatMessage.count({ where: { sessionId: session } })).toBe(1)
  })

  test('an empty turn takes the note as its own text instead of a second row', async () => {
    const session = await newSession()
    const id = await addAssistant(session, '', [{ type: 'data-turn-timing', data: { startedAt: Date.now() - 5_000 } }])

    const result = await stampTurnInterrupted(session, {
      reason: 'interrupted',
      note: 'I was interrupted while working — resuming.',
    })

    expect(result).toEqual({ stamped: true, wroteNote: true })
    const row = await db.chatMessage.findUnique({ where: { id } })
    expect(row.content).toBe('I was interrupted while working — resuming.')
    expect(await db.chatMessage.count({ where: { sessionId: session } })).toBe(1)
  })

  test('is idempotent: one death is marked once', async () => {
    const session = await newSession()
    const id = await addAssistant(session, 'Halfway.', [
      { type: 'text', text: 'Halfway.' },
      { type: 'data-turn-timing', data: { startedAt: Date.now() - 5_000 } },
    ])

    expect((await stampTurnInterrupted(session, { reason: 'interrupted' })).stamped).toBe(true)
    expect((await stampTurnInterrupted(session, { reason: 'interrupted' })).stamped).toBe(false)

    const row = await db.chatMessage.findUnique({ where: { id } })
    const marks = parse(row.parts).filter((p) => p.type === TURN_INTERRUPTED_PART)
    expect(marks).toHaveLength(1)
    expect(row.content).toBe('Halfway.')
  })

  test('never stamps a note row, so a second call cannot report a second death', async () => {
    const session = await newSession()
    const note = 'I was interrupted while running `exec` before the turn finished. The work so far is saved — send a message when you want me to pick it up.'
    const id = await addAssistant(session, note, [{ type: 'text', text: note }])

    const result = await stampTurnInterrupted(session, { reason: 'interrupted_exec' })

    expect(result).toEqual({ stamped: false, wroteNote: false })
    const row = await db.chatMessage.findUnique({ where: { id } })
    expect(parse(row.parts).some((p) => p.type === TURN_INTERRUPTED_PART)).toBe(false)
  })

  test('a session with no assistant row yet is left alone', async () => {
    const session = await newSession()
    expect(await stampTurnInterrupted(session, { reason: 'interrupted' })).toEqual({
      stamped: false,
      wroteNote: false,
    })
  })

  test('an unreadable parts column is replaced rather than losing the mark', async () => {
    const session = await newSession()
    const id = await addAssistant(session, 'Halfway.', '{not json')

    const result = await stampTurnInterrupted(session, { reason: 'interrupted' })

    expect(result.stamped).toBe(true)
    const row = await db.chatMessage.findUnique({ where: { id } })
    expect(parse(row.parts).some((p) => p.type === TURN_INTERRUPTED_PART)).toBe(true)
    expect(row.content).toBe('Halfway.')
  })
})
