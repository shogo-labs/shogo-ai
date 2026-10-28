// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A resume nobody dropped is a promise that has to be kept (SHO-121, round 2).
 *
 * The transcript already told the user the turn is picking itself back up. When
 * the queued resume cannot start — the runtime is still booting, the proxy
 * refuses — the row used to be marked `failed` and forgotten, so the note kept
 * promising a turn that would never run. A resume now retries like a wake, and
 * when it gives up it replaces that promise with the note that says the turn is
 * stopped.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

const dispatched: any[] = []
let runtimeDown = false

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  trackUsageFromStream: async () => undefined,
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      const body = JSON.parse(await request.text())
      if (runtimeDown) throw new Error('runtime not ready')
      dispatched.push(body)
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const { dispatchNext } = await import('../services/chat-queue-dispatcher.service')
const { MAX_WAKE_ATTEMPTS } = await import('../services/background-tasks.service')
const { interruptedTurnNote, interruptedTurnResumeInstruction } = await import('@shogo/shared-runtime/interrupted-turn')

const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(() => {
  dispatched.length = 0
  runtimeDown = false
})

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

/** The row `postInterruptedResume` writes, plus the note that promised it. */
async function queueResume(session: string, opts: { attempts?: number; toolName?: string } = {}) {
  const toolName = opts.toolName ?? 'exec'
  const prompt = interruptedTurnResumeInstruction()
  await db.chatMessage.create({
    data: {
      sessionId: session,
      role: 'assistant',
      content: interruptedTurnNote(toolName, { resuming: true }),
      parts: JSON.stringify([{ type: 'text', text: interruptedTurnNote(toolName, { resuming: true }) }]),
      agent: 'technical',
      model: 'auto',
    },
  })
  return db.chatQueuedMessage.create({
    data: {
      sessionId: session,
      userId: seed.owner,
      position: 0,
      status: 'pending',
      kind: 'resume',
      content: prompt,
      parts: JSON.stringify([{ type: 'text', text: prompt }, { type: 'data-resume', data: { toolName } }]),
      body: JSON.stringify({ text: prompt, ...(opts.attempts ? { resumeAttempts: opts.attempts } : {}) }),
    },
  })
}

describe('a resume that cannot start is retried, not dropped', () => {
  test('a failed dispatch puts the row back in the queue with its attempt counted', async () => {
    const session = await newSession()
    const row = await queueResume(session)
    runtimeDown = true

    expect(await dispatchNext(session)).toBe(false)

    const after = await db.chatQueuedMessage.findUnique({ where: { id: row.id } })
    expect(after.status).toBe('pending')
    expect(JSON.parse(after.body).resumeAttempts).toBe(1)
    expect(after.error).toContain('runtime not ready')
  })

  test('the retry runs the turn once the runtime answers, and the attempt rides along', async () => {
    const session = await newSession()
    await queueResume(session, { attempts: 2 })
    runtimeDown = true
    await dispatchNext(session)

    runtimeDown = false
    expect(await dispatchNext(session)).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toContain('Pick up exactly where you left off')
  })

  test('at the cap the row stops and the transcript stops promising a resume', async () => {
    const session = await newSession()
    const row = await queueResume(session, { attempts: MAX_WAKE_ATTEMPTS - 1 })
    runtimeDown = true

    expect(await dispatchNext(session)).toBe(false)

    const after = await db.chatQueuedMessage.findUnique({ where: { id: row.id } })
    expect(after.status).toBe('failed')
    expect(after.error).toContain(`Could not resume this turn after ${MAX_WAKE_ATTEMPTS} attempts`)

    const stopped = await db.chatMessage.findFirst({
      where: { sessionId: session, role: 'assistant', content: { contains: 'send a message' } },
    })
    expect(stopped?.content).toBe(interruptedTurnNote('exec', { resuming: false }))
    // One promise, one correction — not a note per failed attempt.
    expect(
      await db.chatMessage.count({ where: { sessionId: session, role: 'assistant', content: { contains: 'I was interrupted' } } }),
    ).toBe(2)
  })
})
