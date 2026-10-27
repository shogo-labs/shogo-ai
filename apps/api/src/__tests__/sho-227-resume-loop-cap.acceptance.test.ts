// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Automatic restarts need a person (SHO-227).
 *
 * A resume after an interrupted turn reads as a `role: 'user'` row, so before
 * this the whole session believed a human had written: the one-resume cap
 * restarted with every resume, and the 3-wake pause restarted with it. A watch
 * script that re-armed itself in the resumed turn could therefore keep a cloud
 * session paying for turns for days with nobody in the loop.
 *
 * These are the API halves of that rule: the resume decision
 * (`postInterruptedResume`) and the wake count (`consecutiveWakeWaits`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

// A resume is delivered through the chat proxy. Nothing here may reach a real
// runtime, and the dispatch must not consume the row this suite inspects — so
// the proxy refuses, which is what the dispatcher's retry path already handles.
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  trackUsageFromStream: async () => undefined,
  projectChatRoutes: () => ({
    fetch: async () => {
      throw new Error('no runtime in this suite')
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const { postInterruptedResume } = await import('../services/chat-resume.service')
const tasks = await import('../services/background-tasks.service')
const { reattachStaleTurns } = await import('../jobs/chat-turn-reattach')
const { TURN_REATTACH_AFTER_MS } = await import('../services/chat-turn-state.service')

const db = prisma as any
let seed: SeededWorkspace
let clock = Date.now() - 60 * 60_000

const previousMaxAge = process.env.AGENT_RESUME_MAX_AGE_MINUTES

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

beforeEach(() => {
  delete process.env.AGENT_RESUME_MAX_AGE_MINUTES
})

afterEach(() => {
  if (previousMaxAge === undefined) delete process.env.AGENT_RESUME_MAX_AGE_MINUTES
  else process.env.AGENT_RESUME_MAX_AGE_MINUTES = previousMaxAge
})

/** A timestamp that is always later than the row written before it. */
function tick(): Date {
  clock += 1_000
  return new Date(clock)
}

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

/** A person typing in the composer: a plain user row, no synthetic part. */
async function humanWrites(session: string, text = 'make the room watercolour'): Promise<Date> {
  const createdAt = tick()
  await db.chatMessage.create({
    data: {
      sessionId: session,
      role: 'user',
      content: text,
      parts: JSON.stringify([{ type: 'text', text }]),
      authorUserId: seed.owner,
      createdAt,
    },
  })
  return createdAt
}

/** A watch script reporting back: a user row the machine wrote, not a person. */
async function taskWake(session: string, taskId: string): Promise<Date> {
  const createdAt = tick()
  await db.chatMessage.create({
    data: {
      sessionId: session,
      role: 'user',
      content: '[Task update] watch finished',
      parts: JSON.stringify([{ type: 'text', text: 'wake' }, { type: 'data-task-notification', data: { taskIds: [taskId] } }]),
      createdAt,
    },
  })
  return createdAt
}

/** A resume the machine queued: the row that made every cap reset. */
async function resumeMessage(session: string): Promise<Date> {
  const createdAt = tick()
  await db.chatMessage.create({
    data: {
      sessionId: session,
      role: 'user',
      content: 'Pick up exactly where you left off.',
      parts: JSON.stringify([{ type: 'text', text: 'resume' }, { type: 'data-resume', data: { toolName: 'exec' } }]),
      createdAt,
    },
  })
  return createdAt
}

function resumeRows(session: string) {
  return db.chatQueuedMessage.findMany({ where: { sessionId: session, kind: 'resume' } })
}

function notes(session: string) {
  return db.chatMessage.findMany({
    where: { sessionId: session, role: 'assistant', content: { contains: 'I was interrupted' } },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * What the dispatcher does when a queued resume actually starts: the row's
 * message is persisted as a user row and the row itself is deleted
 * (`chat-queue-dispatcher.service.ts` `startClaimedRow`).
 */
async function theResumeRuns(session: string): Promise<void> {
  const row = await db.chatQueuedMessage.findFirst({ where: { sessionId: session, kind: 'resume' } })
  if (!row) throw new Error('no queued resume to run')
  await db.chatMessage.create({
    data: {
      id: row.id,
      sessionId: session,
      role: 'user',
      content: row.content,
      parts: row.parts,
      agent: 'technical',
      model: null,
      createdAt: tick(),
    },
  })
  await db.chatQueuedMessage.delete({ where: { id: row.id } })
}

describe('one automatic resume per person (AC-1)', () => {
  test('the first death resumes; a second death with no person in between only says the turn is stopped', async () => {
    const session = await newSession()
    await humanWrites(session)

    const first = await postInterruptedResume(session, { toolName: 'exec' })
    expect(first.queued).toBe(true)
    expect(await resumeRows(session)).toHaveLength(1)

    // The queued resume ran and its turn finished — the state the old code read
    // as "a fresh conversation" because the row was gone.
    await theResumeRuns(session)

    const second = await postInterruptedResume(session, { toolName: 'exec' })
    expect(second).toEqual({ noted: true, queued: false, reason: 'already-resumed' })
    expect(await resumeRows(session)).toHaveLength(0)

    // The transcript stops promising a resume that will not happen.
    const all = await notes(session)
    expect(all).toHaveLength(2)
    expect(all[1].content).toBe(
      'I was interrupted while running `exec` before the turn finished. The work so far is saved — send a message when you want me to pick it up.',
    )

    // A person writing is what hands the cap back.
    await humanWrites(session, 'keep going')
    const third = await postInterruptedResume(session, { toolName: 'exec' })
    expect(third.queued).toBe(true)
    expect(await resumeRows(session)).toHaveLength(1)
  })

  test('a resume still waiting in the queue is not a second resume, and its promise stands', async () => {
    const session = await newSession()
    await humanWrites(session)

    await postInterruptedResume(session, { toolName: 'exec' })
    const second = await postInterruptedResume(session, { toolName: 'exec' })

    // Two paths noticing the same death: no downgrade, no duplicate row.
    expect(second).toEqual({ noted: false, queued: false })
    expect(await resumeRows(session)).toHaveLength(1)
    expect(await notes(session)).toHaveLength(1)
  })
})

describe('a session nobody has touched does not restart itself (AC-2)', () => {
  test('a human message older than the max age gets the note only', async () => {
    process.env.AGENT_RESUME_MAX_AGE_MINUTES = '5'
    const session = await newSession()
    const wroteAt = new Date(Date.now() - 60 * 60_000)
    await db.chatMessage.create({
      data: {
        sessionId: session,
        role: 'user',
        content: 'make the room watercolour',
        parts: JSON.stringify([{ type: 'text', text: 'make the room watercolour' }]),
        authorUserId: seed.owner,
        createdAt: wroteAt,
      },
    })

    const result = await postInterruptedResume(session, { toolName: 'exec' })

    expect(result).toEqual({ noted: true, queued: false, reason: 'stale' })
    expect(await resumeRows(session)).toHaveLength(0)
    expect((await notes(session))[0].content).toContain('send a message when you want me to pick it up')
  })

  test('AGENT_RESUME_MAX_AGE_MINUTES=0 queues nothing even for a fresh session', async () => {
    process.env.AGENT_RESUME_MAX_AGE_MINUTES = '0'
    const session = await newSession()
    await humanWrites(session)

    const result = await postInterruptedResume(session, { toolName: 'exec' })

    expect(result).toEqual({ noted: true, queued: false, reason: 'stale' })
    expect(await resumeRows(session)).toHaveLength(0)
  })
})

describe('the wake pause survives a resume (AC-3)', () => {
  /** A watch that re-arms itself: one row, one task id, waking again and again. */
  async function rearmedWatch(session: string): Promise<string> {
    const task = await tasks.createTask({
      id: tasks.newTaskId(),
      chatSessionId: session,
      source: 'work_item',
      targetRef: 'card-loop',
      title: 'SHO-1 loop',
      until: 'agent (stopped|failed)',
    })
    return task.id
  }

  test('wake, wake, resume, wake counts three waits — the resume does not reset the run', async () => {
    const session = await newSession()
    const taskId = await rearmedWatch(session)
    await humanWrites(session)

    await taskWake(session, taskId)
    await taskWake(session, taskId)
    await resumeMessage(session)
    await taskWake(session, taskId)

    expect(await tasks.consecutiveWakeWaits(session, tasks.MAX_CONSECUTIVE_WAKES)).toBe(3)
  })

  test('wake, wake, person, wake counts one wait — a person still ends the run', async () => {
    const session = await newSession()
    const taskId = await rearmedWatch(session)

    await taskWake(session, taskId)
    await taskWake(session, taskId)
    await humanWrites(session, 'thanks, keep watching')
    await taskWake(session, taskId)

    expect(await tasks.consecutiveWakeWaits(session, tasks.MAX_CONSECUTIVE_WAKES)).toBe(1)
  })
})

describe('the reattach job across a completed resume (AC-5)', () => {
  async function deadTurn(session: string): Promise<void> {
    await db.chatSession.update({
      where: { id: session },
      data: {
        activeTurnId: `turn-${Math.random().toString(36).slice(2)}`,
        activeTurnStartedAt: new Date(Date.now() - 60_000),
        activeTurnHeartbeatAt: new Date(Date.now() - TURN_REATTACH_AFTER_MS - 1_000),
      },
    })
  }

  async function sweep(session: string): Promise<void> {
    const ended: string[] = []
    const claimed = await reattachStaleTurns({
      db,
      acquireLease: async () => true,
      track: (async () => null) as any,
      // No runtime behind the turn: the dead-runtime branch is what announces.
      resolveTarget: async () => null,
      startTurnHeartbeat: () => () => {},
      markTurnEnded: async (id: string) => {
        ended.push(id)
      },
      dispatchNext: async () => undefined,
      getCallLink: async () => undefined,
      settleCall: async () => {},
      announceInterrupted: postInterruptedResume,
      homeSessionWhere: () => null,
      now: () => Date.now(),
    })
    expect(claimed).toEqual([session])
    // The announcement runs inside reattachTurn, which the sweep starts and does
    // not await; wait for the turn to be marked ended.
    const deadline = Date.now() + 5_000
    while (!ended.includes(session) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(ended).toContain(session)
  }

  test('two "no runtime" announcements across a resume produce one resume, not two', async () => {
    const session = await newSession()
    await humanWrites(session)

    await deadTurn(session)
    await sweep(session)
    expect(await resumeRows(session)).toHaveLength(1)

    await theResumeRuns(session)

    await deadTurn(session)
    await sweep(session)

    // Exactly one resume ran in total, and the second death left the note that
    // says the turn is stopped.
    expect(await resumeRows(session)).toHaveLength(0)
    const stopped = await db.chatMessage.findFirst({
      where: { sessionId: session, role: 'assistant', content: { contains: 'send a message' } },
    })
    expect(stopped).not.toBeNull()
  })
})
