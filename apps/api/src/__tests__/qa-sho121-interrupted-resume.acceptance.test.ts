// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-121 AC-4, and the promise the note makes (round 2).
 *
 * Round 1 shipped the note but left it nameless on the reattach path, so a
 * dead runtime said "I was interrupted while working" while the transcript
 * already held the tool that never returned. These cases are written from the
 * outside: a real SQLite row shapes the transcript, the two paths that notice a
 * death are driven as the product drives them (`reattachStaleTurns` with the
 * real announcement dependency, `POST /api/internal/chat/:id/resume`'s service
 * call, and the drain sweep for the retry), and the assertions are about what a
 * person would read in the transcript plus what the runtime is told to resume.
 *
 * The invariant that matters most is the pair: one death produces ONE note, and
 * it produces the resume it promises. Suppressing the second half is a worse bug
 * than the duplicate note this was meant to remove.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

const dispatched: any[] = []
let runtimeDown = true

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  trackUsageFromStream: async () => undefined,
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      const body = JSON.parse(await request.text())
      if (runtimeDown) throw new Error('runtime not ready')
      dispatched.push({ body })
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const { interruptedTurnNote } = await import('@shogo/shared-runtime/interrupted-turn')
const { postInterruptedResume } = await import('../services/chat-resume.service')
const { dispatchPendingSessions } = await import('../services/chat-queue-dispatcher.service')
const { reattachStaleTurns } = await import('../jobs/chat-turn-reattach')
const { TURN_REATTACH_AFTER_MS } = await import('../services/chat-turn-state.service')

const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(async () => {
  runtimeDown = true
  dispatched.length = 0
  await db.chatQueuedMessage.deleteMany({})
  await db.chatMessage.deleteMany({})
  await db.chatSession.deleteMany({})
})

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

/** A turn whose tracking pod died: the heartbeat is stale, the turn is open. */
async function staleTurn(session: string): Promise<void> {
  await db.chatSession.update({
    where: { id: session },
    data: {
      activeTurnId: `turn-${session.slice(0, 6)}`,
      activeTurnStartedAt: new Date(Date.now() - 60_000),
      activeTurnHeartbeatAt: new Date(Date.now() - TURN_REATTACH_AFTER_MS - 1_000),
    },
  })
}

async function addAssistant(session: string, content: string, parts: unknown, createdAt?: Date): Promise<void> {
  await db.chatMessage.create({
    data: {
      sessionId: session,
      role: 'assistant',
      content,
      parts: typeof parts === 'string' ? parts : JSON.stringify(parts),
      agent: 'technical',
      model: 'auto',
      ...(createdAt ? { createdAt } : {}),
    },
  })
}

/** What `project-chat` persists when a tool's input arrives and never returns. */
const openTool = (toolName: string) => ({
  type: 'dynamic-tool',
  toolCallId: `call-${toolName}`,
  toolName,
  input: { command: 'bun test' },
  state: 'input-available',
})

const textPart = (text: string) => ({ type: 'text', text })

function notesFor(session: string) {
  return db.chatMessage.findMany({
    where: { sessionId: session, role: 'assistant', content: { contains: 'I was interrupted' } },
    orderBy: { createdAt: 'asc' },
  })
}

function resumesFor(session: string) {
  return db.chatQueuedMessage.findMany({ where: { sessionId: session, kind: 'resume' }, orderBy: { position: 'asc' } })
}

function reattachDeps(overrides: Record<string, unknown> = {}) {
  return {
    db,
    acquireLease: async () => true,
    track: (async () => null) as any,
    resolveTarget: async () => null,
    startTurnHeartbeat: () => () => {},
    markTurnEnded: async () => {},
    dispatchNext: async () => undefined,
    getCallLink: async () => undefined,
    settleCall: async () => {},
    announceInterrupted: postInterruptedResume,
    homeSessionWhere: () => null,
    now: () => Date.now(),
    ...overrides,
  } as any
}

describe('AC-4 — a dead runtime names the step that never returned', () => {
  test('the reattach job names it, ends the turn, and queues one resume for that step', async () => {
    const session = await newSession()
    await staleTurn(session)
    await addAssistant(session, 'Running the suite', [textPart('Running the suite'), openTool('exec')])

    const ended: string[] = []
    const claimed = await reattachStaleTurns(reattachDeps({ markTurnEnded: async (id: string) => ended.push(id) }))

    expect(claimed).toEqual([session])
    await waitFor(async () => ended.includes(session))
    const notes = await notesFor(session)
    expect(notes.map((n: any) => n.content)).toEqual(['I was interrupted while running `exec` — resuming.'])

    const resumes = await waitFor(async () => {
      const rows = await resumesFor(session)
      return rows.length ? rows : null
    })
    expect(resumes).toHaveLength(1)
    expect(resumes[0].status).toBe('pending')
    // The runtime is told which step it is picking back up, so the resumed turn
    // checks that tool's effect instead of repeating it blindly.
    expect(JSON.parse(resumes[0].parts)).toContainEqual({ type: 'data-resume', data: { toolName: 'exec' } })
  })

  test('the step is read from the transcript, not guessed from the last row', async () => {
    const session = await newSession()
    await staleTurn(session)
    // Two tools in one turn: one returned, the last one never did.
    await addAssistant(session, 'Looking around', [
      textPart('Looking around'),
      { ...openTool('read_file'), state: 'output-available', output: { ok: true } },
      openTool('exec'),
    ])

    const ended: string[] = []
    await reattachStaleTurns(reattachDeps({ markTurnEnded: async (id: string) => ended.push(id) }))
    await waitFor(async () => ended.includes(session))

    const notes = await notesFor(session)
    expect(notes).toHaveLength(1)
    expect(notes[0].content).toContain('while running `exec`')
    expect(notes[0].content).not.toContain('read_file')
  })

  test('a turn that died between calls says "while working" instead of inventing a tool', async () => {
    const session = await newSession()
    await staleTurn(session)
    await addAssistant(session, 'Halfway through.', [
      textPart('Halfway through.'),
      { ...openTool('exec'), state: 'output-available', output: { ok: true } },
    ])

    const ended: string[] = []
    await reattachStaleTurns(reattachDeps({ markTurnEnded: async (id: string) => ended.push(id) }))
    await waitFor(async () => ended.includes(session))

    const notes = await notesFor(session)
    expect(notes).toHaveLength(1)
    expect(notes[0].content).toBe('I was interrupted while working — resuming.')
  })
})

describe('one death, one note — and always the resume it promises', () => {
  test('the runtime already said it: no second note, and the resume still queues', async () => {
    const session = await newSession()
    await addAssistant(session, 'Running', [openTool('exec')])

    // The runtime's boot sweep posts this through POST /api/internal/chat/:id/resume.
    await postInterruptedResume(session, { toolName: 'exec' })
    expect(await notesFor(session)).toHaveLength(1)
    await waitFor(async () => ((await resumesFor(session)).length === 1 ? true : null))

    // That resume ran and its row was consumed; then the tracking pod dies too and
    // the reattach job notices the same transcript.
    await db.chatQueuedMessage.deleteMany({ where: { sessionId: session } })
    await staleTurn(session)
    const ended: string[] = []
    await reattachStaleTurns(reattachDeps({ markTurnEnded: async (id: string) => ended.push(id) }))
    await waitFor(async () => ended.includes(session))

    const notes = await notesFor(session)
    expect(notes).toHaveLength(1)
    expect(notes[0].content).toBe('I was interrupted while running `exec` — resuming.')
    await waitFor(async () => ((await resumesFor(session)).length === 1 ? true : null))
    expect(await resumesFor(session)).toHaveLength(1)
  })

  test('an older note is a previous death, so this one is written', async () => {
    const session = await newSession()
    const note = interruptedTurnNote('exec')
    await addAssistant(session, note, [textPart(note)], new Date(Date.now() - 10 * 60_000))

    const result = await postInterruptedResume(session)

    expect(result.noted).toBe(true)
    expect(await notesFor(session)).toHaveLength(2)
  })

  test('a resume that died stops promising one, and still names the step', async () => {
    const session = await newSession()
    const note = interruptedTurnNote('exec')
    await addAssistant(session, note, [textPart(note)])

    const result = await postInterruptedResume(session, { resume: false, toolName: 'exec' })

    expect(result).toEqual({ noted: true, queued: false })
    const notes = await notesFor(session)
    expect(notes).toHaveLength(2)
    expect(notes[1].content).toBe(
      'I was interrupted while running `exec` before the turn finished. The work so far is saved — send a message when you want me to pick it up.',
    )
    expect(notes[1].content).not.toContain('resuming')
    expect(await resumesFor(session)).toHaveLength(0)
  })
})

describe('the resume the note promises actually runs', () => {
  test('a resume the runtime refuses is retried by the drain, then stops saying so once', async () => {
    const session = await newSession()
    await addAssistant(session, 'Running', [openTool('exec')])
    await postInterruptedResume(session, { toolName: 'exec' })

    const first = await waitFor(async () => {
      const row = await db.chatQueuedMessage.findFirst({ where: { sessionId: session, kind: 'resume' } })
      return row && JSON.parse(row.body).resumeAttempts >= 1 ? row : null
    })
    expect(first.status).toBe('pending')
    expect(JSON.parse(first.body).resumeAttempts).toBe(1)

    // MAX_WAKE_ATTEMPTS is 5: four more refused attempts reach the cap.
    for (let i = 0; i < 4; i++) await dispatchPendingSessions()

    const capped = await waitFor(async () => {
      const row = await db.chatQueuedMessage.findFirst({ where: { sessionId: session, kind: 'resume' } })
      return row?.status === 'failed' && /Could not resume this turn after 5 attempts/.test(row.error ?? '') ? row : null
    })
    expect(capped).toBeTruthy()

    const notes = await notesFor(session)
    expect(notes).toHaveLength(2)
    expect(notes[1].content).toContain('before the turn finished')
    expect(notes[1].content).toContain('`exec`')
    expect(notes[1].content).not.toContain('resuming')

    // Nothing left to promise, so a later sweep starts no further turn.
    await dispatchPendingSessions()
    expect(await db.chatQueuedMessage.count({ where: { sessionId: session, status: 'pending' } })).toBe(0)
    expect(dispatched).toHaveLength(0)
  })

  test('a retry the runtime accepts runs exactly one turn, carrying the step', async () => {
    const session = await newSession()
    await addAssistant(session, 'Running', [openTool('exec')])
    await postInterruptedResume(session, { toolName: 'exec' })
    await waitFor(async () => {
      const row = await db.chatQueuedMessage.findFirst({ where: { sessionId: session, kind: 'resume' } })
      return row && JSON.parse(row.body).resumeAttempts >= 1 ? true : null
    })

    runtimeDown = false
    await dispatchPendingSessions()

    expect(dispatched).toHaveLength(1)
    const parts = dispatched[0].body.messages[0].parts
    expect(parts).toContainEqual({ type: 'data-resume', data: { toolName: 'exec' } })
    expect(await resumesFor(session)).toHaveLength(0)
  })
})

describe('the healthy path is untouched', () => {
  test('a runtime whose buffer still answers gets no note and no resume', async () => {
    const session = await newSession()
    await staleTurn(session)
    await addAssistant(session, 'Running', [openTool('exec')])

    let announced = 0
    const ended: string[] = []
    await reattachStaleTurns(
      reattachDeps({
        resolveTarget: async () => ({
          project: { id: seed.projectId, workspaceId: seed.workspaceId },
          fetchRuntime: async () => new Response('data: {}\n\n', { status: 200 }),
        }),
        announceInterrupted: async (...args: any[]) => {
          announced++
          return (postInterruptedResume as any)(...args)
        },
        markTurnEnded: async (id: string) => ended.push(id),
      }),
    )
    await waitFor(async () => ended.includes(session))

    expect(announced).toBe(0)
    expect(await notesFor(session)).toHaveLength(0)
    expect(await resumesFor(session)).toHaveLength(0)
  })
})
