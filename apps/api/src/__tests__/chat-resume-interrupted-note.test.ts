// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The interrupted step has a name, and one death gets one note (SHO-121, AC-4).
 *
 * The reattach job only knows that the runtime behind a turn is gone; it does
 * not know what the turn was doing. The transcript does: `project-chat` writes
 * every tool call as a `dynamic-tool` part when its input arrives and only
 * completes it when the result lands, so the newest part still open is the tool
 * that was running when the process died. Naming it is what makes the note
 * actionable — and reading it in one place (here) keeps both call sites honest
 * without changing their signature.
 *
 * The same read decides whether the other path already said this: the runtime's
 * boot sweep writes the same note from its own marker, and a second, vaguer copy
 * for one death reads as two failures.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

// The resume is delivered through the chat proxy; this suite is about the note,
// so the proxy just records that a turn was asked for.
const dispatched: any[] = []
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  trackUsageFromStream: async () => undefined,
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      dispatched.push({ body: JSON.parse(await request.text()) })
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const { inFlightToolName, postInterruptedResume } = await import('../services/chat-resume.service')
const { reattachStaleTurns } = await import('../jobs/chat-turn-reattach')
const { TURN_REATTACH_AFTER_MS } = await import('../services/chat-turn-state.service')

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

async function addAssistant(session: string, content: string, parts: unknown): Promise<void> {
  await db.chatMessage.create({
    data: {
      sessionId: session,
      role: 'assistant',
      content,
      parts: typeof parts === 'string' ? parts : JSON.stringify(parts),
      agent: 'technical',
      model: 'auto',
    },
  })
}

function notesFor(session: string) {
  return db.chatMessage.findMany({
    where: { sessionId: session, role: 'assistant', content: { contains: 'I was interrupted' } },
    orderBy: { createdAt: 'asc' },
  })
}

const toolPart = (toolName: string, state = 'input-available') => ({
  type: 'dynamic-tool',
  toolCallId: `c-${toolName}`,
  toolName,
  input: { command: 'bun test' },
  state,
})

describe('the interrupted step is named (AC-4)', () => {
  test('the last tool still in input-available is the step that never returned', async () => {
    const session = await newSession()
    await addAssistant(session, 'Running the suite', [
      { type: 'text', text: 'Running the suite' },
      toolPart('read_file', 'output-available'),
      toolPart('exec'),
    ])

    const result = await postInterruptedResume(session)

    expect(result).toEqual({ noted: true, queued: true })
    const notes = await notesFor(session)
    expect(notes).toHaveLength(1)
    expect(notes[0].content).toBe('I was interrupted while running `exec` — resuming.')
    // The queued turn is resumed for that same step, so the runtime path and the
    // API path name the same tool.
    const queued = await waitFor(async () => dispatched.map((d) => d.body).find((body) => body.chatSessionId === session) ?? null)
    expect(JSON.stringify(queued.messages)).toContain('"toolName":"exec"')
  })

  test('a step that was never recorded stays nameless instead of inventing one', async () => {
    const session = await newSession()
    // The model died between calls: the turn persisted text, and the only tool
    // on the row already returned.
    await addAssistant(session, 'Halfway through.', [
      { type: 'text', text: 'Halfway through.' },
      toolPart('exec', 'output-available'),
    ])

    await postInterruptedResume(session)

    const notes = await notesFor(session)
    expect(notes[0].content).toBe('I was interrupted while working — resuming.')
  })

  test('an unreadable parts column does not lose the note', async () => {
    const session = await newSession()
    await addAssistant(session, 'Working', '{not json')

    const result = await postInterruptedResume(session)

    expect(result.noted).toBe(true)
    const notes = await notesFor(session)
    expect(notes[0].content).toBe('I was interrupted while working — resuming.')
  })

  test('a tool name the caller already knows wins over the transcript', async () => {
    const session = await newSession()
    await addAssistant(session, 'Running', [toolPart('exec')])

    await postInterruptedResume(session, { toolName: 'browser_qa' })

    const notes = await notesFor(session)
    expect(notes[0].content).toBe('I was interrupted while running `browser_qa` — resuming.')
  })
})

describe('one death, one note', () => {
  test('the runtime sweep already said it — no second, vaguer note, and the resume still queues', async () => {
    const session = await newSession()
    // What the runtime's boot sweep writes: it knows the tool from its marker.
    await addAssistant(
      session,
      'I was interrupted while running `exec` — resuming.',
      [{ type: 'text', text: 'I was interrupted while running `exec` — resuming.' }],
    )

    const result = await postInterruptedResume(session)

    expect(result).toEqual({ noted: false, queued: true })
    expect(await notesFor(session)).toHaveLength(1)
  })

  test('a resume that died replaces the promise with the wording that says the turn is stopped', async () => {
    const session = await newSession()
    await addAssistant(
      session,
      'I was interrupted while running `exec` — resuming.',
      [{ type: 'text', text: 'I was interrupted while running `exec` — resuming.' }],
    )

    const result = await postInterruptedResume(session, { resume: false, toolName: 'exec' })

    expect(result).toEqual({ noted: true, queued: false })
    expect(await notesFor(session)).toHaveLength(2)
    const stopped = await db.chatMessage.findFirst({
      where: { sessionId: session, role: 'assistant', content: { contains: 'send a message' } },
    })
    expect(stopped.content).toBe(
      'I was interrupted while running `exec` before the turn finished. The work so far is saved — send a message when you want me to pick it up.',
    )
  })

  test('saying it twice at the same moment writes one row', async () => {
    const session = await newSession()
    await addAssistant(session, 'Running', [toolPart('exec')])

    await postInterruptedResume(session)
    const second = await postInterruptedResume(session)

    expect(second.noted).toBe(false)
    expect(await notesFor(session)).toHaveLength(1)
  })
})

describe('the reattach job names the step end to end', () => {
  test('a dead runtime over a real transcript produces a note that names exec', async () => {
    const session = await newSession()
    await db.chatSession.update({
      where: { id: session },
      data: {
        activeTurnId: 'turn-dead',
        activeTurnStartedAt: new Date(Date.now() - 60_000),
        activeTurnHeartbeatAt: new Date(Date.now() - TURN_REATTACH_AFTER_MS - 1_000),
      },
    })
    await addAssistant(session, 'Running the suite', [
      { type: 'text', text: 'Running the suite' },
      toolPart('exec'),
    ])

    const ended: string[] = []
    const claimed = await reattachStaleTurns({
      db,
      acquireLease: async () => true,
      track: (async () => null) as any,
      resolveTarget: async () => null,
      startTurnHeartbeat: () => () => {},
      markTurnEnded: async (id: string) => {
        ended.push(id)
      },
      dispatchNext: async () => undefined,
      getCallLink: async () => undefined,
      settleCall: async () => {},
      // The job's own dependency: it says nothing about the tool, and the name
      // has to come from the transcript.
      announceInterrupted: postInterruptedResume,
      homeSessionWhere: () => null,
      now: () => Date.now(),
    })

    expect(claimed).toEqual([session])
    await waitFor(async () => (ended.includes(session) ? true : null))
    const notes = await notesFor(session)
    expect(notes).toHaveLength(1)
    expect(notes[0].content).toBe('I was interrupted while running `exec` — resuming.')
  })
})

describe('inFlightToolName', () => {
  test('reads the database string, the in-memory array, and nothing at all', () => {
    expect(inFlightToolName(JSON.stringify([toolPart('exec')]))).toBe('exec')
    expect(inFlightToolName([toolPart('exec')])).toBe('exec')
    expect(inFlightToolName(JSON.stringify([toolPart('exec'), toolPart('exec', 'output-available')]))).toBe('exec')
    expect(inFlightToolName(JSON.stringify([toolPart('exec', 'output-available')]))).toBeNull()
    expect(inFlightToolName(JSON.stringify([{ type: 'text', text: 'hi' }]))).toBeNull()
    expect(inFlightToolName(null)).toBeNull()
    expect(inFlightToolName('not json')).toBeNull()
    expect(inFlightToolName(JSON.stringify({ type: 'dynamic-tool' }))).toBeNull()
  })
})
