// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA end-to-end for SHO-227: the reported cloud loop, driven until it stops.
 *
 * The staging session this card came from had one open-ended instruction, a
 * watch script that kept reporting back, and a pod that kept being evicted
 * mid-turn. Nobody wrote again, yet every few hours the transcript grew
 * another "I was interrupted while working — resuming." pair, because a resume
 * read as a person: the one-resume cap and the three-wake pause both restarted
 * with it, so the chain could not end.
 *
 * This walks that loop through the real code paths — the internal task-notify
 * route, the queue dispatcher, the reattach sweep and `postInterruptedResume` —
 * with the runtime proxied (no model call, no paid turn), and asserts the
 * session stops: one automatic resume, at most `MAX_CONSECUTIVE_WAKES` wakes,
 * then the paused/waiting state a person can see and act on.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

/** Every turn the queue started, in order, as the runtime would have received it. */
const started: Array<Record<string, any>> = []

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  trackUsageFromStream: async () => undefined,
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      started.push(JSON.parse(await request.text()))
      // The turn starts and the pod dies before it can answer; what matters to
      // this card is that the queue believed it started.
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const tasks = await import('../services/background-tasks.service')
const { postInterruptedResume } = await import('../services/chat-resume.service')
const { reattachStaleTurns } = await import('../jobs/chat-turn-reattach')
const { runChatQueueDrain } = await import('../jobs/run-chat-queue-drain')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { TURN_REATTACH_AFTER_MS, markTurnEnded } = await import('../services/chat-turn-state.service')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route(
  '/api/internal',
  runtimeInternalRoutes({
    authenticate: async (c: any) => (c.req.header('x-identity') ? JSON.parse(c.req.header('x-identity')!) : null),
    saveAgentAvatar: async () => ({}) as any,
    metalWorkspaceMember: (async () => null) as any,
  } as any),
)

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(() => {
  tasks._testing.clearTimers()
  started.length = 0
})

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

/**
 * The instruction that started the staging session.
 *
 * Both rules compare row timestamps (a resume must be *newer* than the last
 * person, a wake must be *newer* than the pause it lifts), so the row is written
 * at real time and the test waits a beat before letting the machine write:
 * a same-millisecond tie would make this about the clock, not the rule.
 */
async function personWrites(session: string, text = "create the room in the watercolour art style — don't stop until it is beautiful") {
  await db.chatMessage.create({
    data: {
      sessionId: session,
      role: 'user',
      content: text,
      parts: JSON.stringify([{ type: 'text', text }]),
      authorUserId: seed.owner,
      createdAt: new Date(),
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
}

/** A watch script reporting back: a finished shell task the runtime announces. */
async function watchReportsBack(chatSessionId: string, taskId: string): Promise<void> {
  const res = await app.request('/api/internal/tasks/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-identity': JSON.stringify({ kind: 'project', projectId: seed.projectId }) },
    body: JSON.stringify({
      chatSessionId,
      tasks: [{ id: taskId, source: 'shell', title: 'render the room', status: 'completed', text: `[Task update] render the room (${taskId}) completed.` }],
    }),
  })
  expect(res.status).toBe(200)
  tasks._testing.clearTimers()
}

/** The pod is evicted mid-turn: the turn's heartbeat stops and the sweep notices. */
async function podDiesMidTurn(session: string): Promise<void> {
  await db.chatSession.update({
    where: { id: session },
    data: {
      activeTurnId: `turn-${Math.random().toString(36).slice(2)}`,
      activeTurnStartedAt: new Date(Date.now() - 60_000),
      activeTurnHeartbeatAt: new Date(Date.now() - TURN_REATTACH_AFTER_MS - 1_000),
    },
  })
  const ended: string[] = []
  const claimed = await reattachStaleTurns({
    db,
    acquireLease: async () => true,
    track: (async () => null) as any,
    // The runtime that was running this turn is gone with its pod.
    resolveTarget: async () => null,
    startTurnHeartbeat: () => () => {},
    // The real one, because it is what clears the dead turn: a session still
    // marked busy would refuse to start the resume the announcement queued.
    markTurnEnded: async (id: string, turnId: string) => {
      ended.push(id)
      await markTurnEnded(id, turnId)
    },
    dispatchNext: async () => undefined,
    getCallLink: async () => undefined,
    settleCall: async () => {},
    announceInterrupted: postInterruptedResume,
    homeSessionWhere: () => null,
    now: () => Date.now(),
  })
  expect(claimed).toContain(session)
  // The announcement runs inside a turn the sweep does not await.
  await waitFor(async () => ended.includes(session))
  // Start whatever the announcement queued, the way the drain worker would.
  await runChatQueueDrain()
  await new Promise((resolve) => setTimeout(resolve, 50))
}

const wakeTurns = () => started.filter((body) => body.taskNotification)
/**
 * A resume turn, recognised by what it says rather than by the flag the fix
 * added: the point of this test is that the count is 1, on this branch and on
 * the code before it.
 */
const resumeTurns = () => started.filter((body) => String(body.text ?? '').includes('Pick up exactly where you left off'))

function notes(session: string) {
  return db.chatMessage.findMany({
    where: { sessionId: session, role: 'assistant', content: { contains: 'I was interrupted' } },
    orderBy: { createdAt: 'asc' },
  })
}

describe('SHO-227 e2e: the cloud resume loop stops by itself', () => {
  test('one resume, at most three wakes, then the session waits for a person', async () => {
    const session = await newSession()
    await personWrites(session)

    // Five rounds of "watch reports back → pod dies mid-turn". Before the fix
    // every round produced a wake turn *and* a resume turn, forever.
    for (let round = 1; round <= 5; round++) {
      await watchReportsBack(session, `t_loop${String(round).padStart(4, '0')}`)
      await runChatQueueDrain()
      await new Promise((resolve) => setTimeout(resolve, 50))
      await podDiesMidTurn(session)
    }

    // The one automatic restart this conversation is allowed.
    expect(resumeTurns()).toHaveLength(1)
    expect(resumeTurns()[0].text).toContain('Pick up exactly where you left off')

    // The watch keeps re-arming, so the existing pause is what ends the waking.
    expect(wakeTurns()).toHaveLength(tasks.MAX_CONSECUTIVE_WAKES)

    // Stopped, and visibly so: the paused wake names the update nobody delivered.
    const state = await tasks.sessionWakeState(session)
    expect(state.paused).toBe(true)
    expect(state.wakesInARow).toBeGreaterThanOrEqual(tasks.MAX_CONSECUTIVE_WAKES)
    expect(state.waiting.length).toBeGreaterThan(0)

    // The transcript's last word about the interruptions is the note-only one,
    // not a promise to resume that nothing will honour.
    const all = await notes(session)
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all[all.length - 1].content).toContain('send a message when you want me to pick it up')
    expect(all[all.length - 1].content).not.toContain('resuming')

    // Nothing is left queued to fire on its own: the loop is over, not sleeping.
    expect(await db.chatQueuedMessage.count({ where: { sessionId: session, kind: 'resume', status: { in: ['pending', 'dispatching'] } } })).toBe(0)
  })

  test('a person coming back hands both caps back: wakes flow again and the next death resumes once', async () => {
    const session = await newSession()
    await personWrites(session)

    for (let round = 1; round <= 4; round++) {
      await watchReportsBack(session, `t_back${String(round).padStart(4, '0')}`)
      await runChatQueueDrain()
      await new Promise((resolve) => setTimeout(resolve, 50))
      await podDiesMidTurn(session)
    }
    expect((await tasks.sessionWakeState(session)).paused).toBe(true)
    const resumesBefore = resumeTurns().length
    expect(resumesBefore).toBe(1)

    // The person reads the paused update and writes back. That is the only thing
    // that clears either cap.
    await personWrites(session, 'ok, carry on — and stop when it looks good')
    const wakesBefore = wakeTurns().length

    await watchReportsBack(session, 't_back0009')
    await runChatQueueDrain()
    await waitFor(async () => wakeTurns().length > wakesBefore)
    expect(wakeTurns().length).toBe(wakesBefore + 1)

    await podDiesMidTurn(session)
    expect(resumeTurns().length).toBe(resumesBefore + 1)
  })
})
