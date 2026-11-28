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
  trimTurnFramesToCap,
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

/**
 * #2293: a P2003 means the session row was deleted mid-stream, which no retry
 * can fix — so the writer must treat it as terminal. Before this guard it kept
 * calling `appendTurnFrames` for every later batch and logged one
 * `JOURNAL WRITE FAILED` per batch: 305 lines in 51 s for one staging session.
 * The journal now dies once, says so once, and refuses every later batch.
 */
describe('a dead journal stays dead (#2293)', () => {
  test('five appends after a P2003 cost one insert, one warn, all false', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    const originalCreate = db.chatTurnFrame.create
    let inserts = 0
    db.chatTurnFrame.create = async () => {
      inserts++
      throw Object.assign(
        new Error('Foreign key constraint violated on the constraint: chat_turn_frames_sessionId_fkey'),
        { code: 'P2003' },
      )
    }
    const warns: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')) }
    try {
      const writer = new TurnJournalWriter(session, turn)
      const results: boolean[] = []
      for (let i = 0; i < 5; i++) results.push(await writer.append([`frame-${i}`]))

      expect(results).toEqual([false, false, false, false, false])
      expect(inserts).toBe(1)
      expect(warns.filter((line) => line.includes('Journalling disabled for turn'))).toHaveLength(1)
      expect(writer.dead).toBe(true)
      expect(writer.deadAtSeq).toBe(0)
      // The closing log line must not read as a healthy journal.
      expect(writer.status).toBe('dead@seq0')
      expect(await turnFrameCount(turn)).toBe(0)
    } finally {
      db.chatTurnFrame.create = originalCreate
      console.warn = originalWarn
    }
  })

  test('a transient failure keeps retrying and only the terminal one kills it', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    const originalCreate = db.chatTurnFrame.create
    let inserts = 0
    db.chatTurnFrame.create = async (args: any) => {
      inserts++
      // First attempt of the first batch is a dropped connection; the retry succeeds.
      if (inserts === 1) throw Object.assign(new Error('connection closed'), { code: 'P1001' })
      return originalCreate.call(db.chatTurnFrame, args)
    }
    try {
      const writer = new TurnJournalWriter(session, turn)
      expect(await writer.append(['retried'])).toBe(true)
      expect(await writer.append(['second'])).toBe(true)
      expect(writer.dead).toBe(false)
      expect(writer.deadAtSeq).toBeNull()
      expect(writer.status).toBe('2 batch(es)')
      expect(await readTurnFrames(turn)).toEqual(['retried', 'second'])
    } finally {
      db.chatTurnFrame.create = originalCreate
    }
  })
})

/**
 * SHO-482: a single delete over millions of rows blocked the desktop's event
 * loop for ~71 s, past its 30 s health window, so the API was killed mid-sweep
 * on every launch. The sweep now deletes a bounded batch at a time.
 */
describe('sweeping a large backlog (SHO-482)', () => {
  const OLD_TURN = () => `turn-${crypto.randomUUID()}`

  async function seedOldFrames(session: string, turn: string, count: number): Promise<void> {
    const old = new Date(Date.now() - 72 * 60 * 60_000)
    for (let i = 0; i < count; i++) {
      await db.chatTurnFrame.create({
        data: { sessionId: session, turnId: turn, seq: i, data: `frame-${i}`, createdAt: old },
      })
    }
  }

  test('deletes one batch per call and leaves the rest for the next tick', async () => {
    await db.chatTurnFrame.deleteMany({})
    const session = await newSession()
    const turn = OLD_TURN()
    await seedOldFrames(session, turn, 12)

    expect(await sweepTurnFrames(undefined, { batchSize: 5, maxBatches: 1 })).toBe(5)
    expect(await turnFrameCount(turn)).toBe(7)

    expect(await sweepTurnFrames(undefined, { batchSize: 5, maxBatches: 1 })).toBe(5)
    // The short batch ends the sweep: nothing under the cutoff is left.
    expect(await sweepTurnFrames(undefined, { batchSize: 5, maxBatches: 1 })).toBe(2)
    expect(await turnFrameCount(turn)).toBe(0)
  })

  test('the wall-clock budget stops the sweep instead of blocking the process', async () => {
    await db.chatTurnFrame.deleteMany({})
    const session = await newSession()
    const turn = OLD_TURN()
    await seedOldFrames(session, turn, 6)

    // A zero budget means "do not start a second batch": one batch of 2 goes,
    // the other 4 stay for the next tick.
    expect(await sweepTurnFrames(undefined, { batchSize: 2, budgetMs: 0 })).toBe(2)
    expect(await turnFrameCount(turn)).toBe(4)
  })

  test('never deletes the frames of a turn the session is still running', async () => {
    await db.chatTurnFrame.deleteMany({})
    const liveSession = await newSession()
    const deadSession = await newSession()
    const liveTurn = OLD_TURN()
    const deadTurn = OLD_TURN()
    await seedOldFrames(liveSession, liveTurn, 2)
    await seedOldFrames(deadSession, deadTurn, 2)
    await db.chatSession.update({ where: { id: liveSession }, data: { activeTurnId: liveTurn } })

    expect(await sweepTurnFrames()).toBe(2)
    expect(await turnFrameCount(liveTurn)).toBe(2)
    expect(await turnFrameCount(deadTurn)).toBe(0)
  })

  test('the cap trims down to MAX_TURN_FRAMES, newest rows kept', async () => {
    await db.chatTurnFrame.deleteMany({})
    const session = await newSession()
    const turn = OLD_TURN()
    const now = Date.now()
    // Newer than the retention window on purpose: the cap is the only thing
    // that can bound this journal.
    for (let i = 0; i < 30; i++) {
      await db.chatTurnFrame.create({
        data: {
          sessionId: session,
          turnId: turn,
          seq: i,
          data: `frame-${i}`,
          createdAt: new Date(now - (30 - i) * 1_000),
        },
      })
    }

    expect(await trimTurnFramesToCap(10)).toBe(20)
    expect(await turnFrameCount(turn)).toBe(10)
    // Newest kept: the surviving seqs are the last ten written.
    const kept = await db.chatTurnFrame.findMany({ where: { turnId: turn }, orderBy: { seq: 'asc' }, select: { seq: true } })
    expect(kept.map((row: { seq: number }) => row.seq)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
  })

  test('the cap leaves a live turn alone too', async () => {
    await db.chatTurnFrame.deleteMany({})
    const liveSession = await newSession()
    const session = await newSession()
    const liveTurn = OLD_TURN()
    const turn = OLD_TURN()
    const now = Date.now()
    // The live turn's frames are the oldest, so a plain cap would take them.
    await db.chatTurnFrame.create({ data: { sessionId: liveSession, turnId: liveTurn, seq: 0, data: 'live', createdAt: new Date(now - 60_000) } })
    for (let i = 0; i < 10; i++) {
      await db.chatTurnFrame.create({
        data: { sessionId: session, turnId: turn, seq: i, data: `frame-${i}`, createdAt: new Date(now - (10 - i) * 1_000) },
      })
    }
    await db.chatSession.update({ where: { id: liveSession }, data: { activeTurnId: liveTurn } })

    expect(await trimTurnFramesToCap(5)).toBe(5)
    expect(await turnFrameCount(liveTurn)).toBe(1)
    expect(await turnFrameCount(turn)).toBe(5)
  })
})

/**
 * AC1 of SHO-482, as a regression test: while the sweep deletes, the process
 * must keep turning the event loop, because that is what answers `/api/health`.
 *
 * The old sweep was one `deleteMany` over the whole backlog. On the desktop's
 * synchronous SQLite adapter that held the loop for ~71 s, past the 30 s health
 * window, so the supervisor killed the API mid-delete and every relaunch
 * repeated it. A microtask "yield" would look like a fix and behave the same
 * as the bug: a 0 ms interval is a macrotask, so it only ever fires while the
 * sweep is genuinely off the loop.
 */
describe('the sweep leaves the event loop free (SHO-482 AC1)', () => {
  test('a 0 ms timer keeps firing while a backlog is deleted in batches', async () => {
    await db.chatTurnFrame.deleteMany({})
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    const old = new Date(Date.now() - 72 * 60 * 60_000)
    await db.chatTurnFrame.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({ sessionId: session, turnId: turn, seq: i, data: `frame-${i}`, createdAt: old })),
    })

    let turns = 0
    const timer = setInterval(() => { turns++ }, 0)
    let deleted = 0
    try {
      deleted = await sweepTurnFrames(undefined, { batchSize: 5, maxBatches: 40, budgetMs: 60_000 })
    } finally {
      clearInterval(timer)
    }

    expect(deleted).toBe(200)
    // 40 batches, so 39 yields: a batch-at-a-time sweep that never left the
    // loop would fire the timer zero times (or once, by luck at the start).
    expect(turns).toBeGreaterThan(1)
  })
})
