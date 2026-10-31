// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The write-ahead journal is what makes "a frame reaches the client only after
 * it is durable" true (SHO-274). These tests pin the contract the relay relies
 * on: frames come back byte-identical and in order, a retried insert cannot
 * duplicate them, and nothing is kept once its turn is finished.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const {
  TurnJournalWriter,
  appendTurnFrames,
  deleteTurnFrames,
  readTurnFrames,
  sweepTurnFrames,
  turnFrameCount,
} = await import('../services/chat-turn-journal')

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

describe('turn journal (SHO-274)', () => {
  test('frames come back byte-identical and in seq order', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    const first = 'data: {"type":"text-delta","delta":"Hello "}\n\n'
    const second = 'data: {"type":"text-delta","delta":"world"}\n\n'
    // Out of order on purpose: the relay can only ever write in order, but the
    // read must not depend on insertion order.
    await appendTurnFrames(session, turn, 1, [second])
    await appendTurnFrames(session, turn, 0, [first])

    expect(await readTurnFrames(turn)).toEqual([first, second])
  })

  test('a batch keeps its frames in the order they were received', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    await appendTurnFrames(session, turn, 0, ['a', 'b', 'c'])

    expect(await readTurnFrames(turn)).toEqual(['abc'])
  })

  test('a retried insert cannot duplicate frames', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    const frame = 'data: {"type":"text-delta","delta":"once"}\n\n'

    expect(await appendTurnFrames(session, turn, 0, [frame])).toBe(true)
    // The retry after an insert whose response was lost: same seq, same frames.
    expect(await appendTurnFrames(session, turn, 0, [frame])).toBe(true)

    expect(await turnFrameCount(turn)).toBe(1)
    expect(await readTurnFrames(turn)).toEqual([frame])
  })

  test('bytes are decoded as UTF-8, not latin-1', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    const line = 'data: {"type":"text-delta","delta":"héllo ⚡"}\n\n'
    await appendTurnFrames(session, turn, 0, [new TextEncoder().encode(line)])

    expect(await readTurnFrames(turn)).toEqual([line])
  })

  test('deleting a turn removes only that turn', async () => {
    const session = await newSession()
    const keep = `turn-${crypto.randomUUID()}`
    const drop = `turn-${crypto.randomUUID()}`
    await appendTurnFrames(session, keep, 0, ['keep'])
    await appendTurnFrames(session, drop, 0, ['drop'])

    expect(await deleteTurnFrames(drop)).toBe(1)
    expect(await readTurnFrames(drop)).toEqual([])
    expect(await readTurnFrames(keep)).toEqual(['keep'])
  })

  test('the sweep drops only frames past the retention window', async () => {
    const session = await newSession()
    const oldTurn = `turn-${crypto.randomUUID()}`
    const newTurn = `turn-${crypto.randomUUID()}`
    await db.chatTurnFrame.create({
      data: {
        sessionId: session,
        turnId: oldTurn,
        seq: 0,
        data: 'old',
        createdAt: new Date(Date.now() - 72 * 60 * 60_000),
      },
    })
    await appendTurnFrames(session, newTurn, 0, ['new'])

    expect(await sweepTurnFrames()).toBe(1)
    expect(await readTurnFrames(oldTurn)).toEqual([])
    expect(await readTurnFrames(newTurn)).toEqual(['new'])
  })

  test('the writer numbers batches in order and counts them', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    const writer = new TurnJournalWriter(session, turn)

    expect(await writer.append(['first'])).toBe(true)
    expect(await writer.append(['second'])).toBe(true)
    expect(writer.written).toBe(2)
    expect(await readTurnFrames(turn)).toEqual(['first', 'second'])
  })

  test('an empty batch writes nothing', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    expect(await appendTurnFrames(session, turn, 0, [])).toBe(true)
    expect(await turnFrameCount(turn)).toBe(0)
  })
})
