// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Recovery is the other half of the journal (SHO-274): the frames are replayed
 * through the turn parser, so the rebuilt row holds exactly the characters the
 * person had on screen — no more, no less.
 *
 * The parser itself is `trackUsageFromStream`, covered by its own suites; here
 * it is injected so this file asserts the *recovery* contract (order, byte
 * fidelity, consumption, stamping) without dragging the whole chat route into
 * the module graph of every suite that shares a bun process with it.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { appendTurnFrames, readTurnFrames, turnFrameCount } = await import('../services/chat-turn-journal')
const { recoverTurnFromJournal } = await import('../services/chat-turn-recovery')

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

const frame = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`

/**
 * Stand-in for `trackUsageFromStream`: drains the stream, extracts the text the
 * way the real parser does, and writes the row. Whatever the recovery hands it
 * is what the row ends up holding — which is the property under test.
 */
function fakeTrack(written: string[]) {
  return (async (stream: ReadableStream<Uint8Array>, _body: any, _project: any, options: any) => {
    const reader = stream.getReader()
    let raw = ''
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
    const text = raw
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => {
        try {
          return JSON.parse(line.slice(6))
        } catch {
          return null
        }
      })
      .filter((part: any) => part?.type === 'text-delta')
      .map((part: any) => part.delta)
      .join('')
    written.push(text)
    const row = await db.chatMessage.create({
      data: { sessionId: options.chatSessionId, role: 'assistant', content: text, agent: 'technical', model: 'auto' },
    })
    return { outcome: 'partial', status: null, text, assistantMessageId: row.id }
  }) as any
}

describe('recoverTurnFromJournal (SHO-274)', () => {
  test('replays every journaled frame, in order, as one turn', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    // A turn killed after two text deltas: no data-turn-complete anywhere.
    await appendTurnFrames(session, turn, 0, [frame({ type: 'text-delta', delta: 'Reading the ' })])
    await appendTurnFrames(session, turn, 1, [frame({ type: 'text-delta', delta: 'migration files' })])

    const written: string[] = []
    const result = await recoverTurnFromJournal(session, turn, { track: fakeTrack(written) })

    expect(result.recovered).toBe(true)
    expect(result.frames).toBe(2)
    // Exactly the characters the client had, in the order it had them.
    expect(written).toEqual(['Reading the migration files'])
    const rows = await db.chatMessage.findMany({ where: { sessionId: session, role: 'assistant' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('Reading the migration files')
    // The turn must stop looking like a reply still being written, or the client
    // drops the row on the next replay.
    expect(rows[0].parts).toContain('data-turn-interrupted')
  })

  test('consumes the frames it replayed, so a second boot has nothing to redo', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    await appendTurnFrames(session, turn, 0, [frame({ type: 'text-delta', delta: 'half an answer' })])

    expect((await recoverTurnFromJournal(session, turn, { track: fakeTrack([]) })).recovered).toBe(true)
    expect(await turnFrameCount(turn)).toBe(0)

    const again = await recoverTurnFromJournal(session, turn, { track: fakeTrack([]) })
    expect(again.recovered).toBe(false)
    expect(again.frames).toBe(0)
    // The row is left alone, not blanked by the second attempt.
    const rows = await db.chatMessage.findMany({ where: { sessionId: session, role: 'assistant' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('half an answer')
  })

  test('keepFrames leaves the journal for whoever recovers next', async () => {
    const session = await newSession()
    const turn = `turn-${crypto.randomUUID()}`
    await appendTurnFrames(session, turn, 0, [frame({ type: 'text-delta', delta: 'kept' })])

    await recoverTurnFromJournal(session, turn, { track: fakeTrack([]), keepFrames: true })

    expect(await turnFrameCount(turn)).toBe(1)
    expect(await readTurnFrames(turn)).toHaveLength(1)
  })

  test('a turn with no frames is a no-op, not an empty row', async () => {
    const session = await newSession()
    const result = await recoverTurnFromJournal(session, `turn-${crypto.randomUUID()}`, { track: fakeTrack([]) })

    expect(result).toEqual({ recovered: false, frames: 0, assistantMessageId: null })
    expect(await db.chatMessage.count({ where: { sessionId: session } })).toBe(0)
  })
})
