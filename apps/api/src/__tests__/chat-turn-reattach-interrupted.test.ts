// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A turn whose runtime is gone must not end in silence (SHO-121).
 *
 * The reattach job exists to follow a turn across an API pod loss. When the
 * runtime behind it is dead — or its stream buffer is unreachable — there is
 * nothing to follow, and before this the job simply ended the turn: no final
 * message, and the user had to type "continue" to find out what happened. Now
 * that dead end says the turn was interrupted and queues its one resume.
 */
import { describe, expect, test } from 'bun:test'
import { reattachStaleTurns, type ReattachDeps } from '../jobs/chat-turn-reattach'
import { TURN_REATTACH_AFTER_MS } from '../services/chat-turn-state.service'
import { isTaskWakeMessage } from '../services/background-tasks.service'
import { interruptedTurnNote, interruptedTurnResumeInstruction, interruptedTurnResumePrompt } from '@shogo/shared-runtime/interrupted-turn'

const SESSION_ID = 'sess-121'

type Recorded = {
  announced: string[]
  tracked: number
  ended: string[]
  dispatched: string[]
}

/**
 * Deps that behave like the job's own, minus the database and the network.
 * `buffer` decides what `/agent/chat/:id/stream` answers.
 */
function fakeDeps(opts: { target: 'missing' | 'unreachable' | 'alive' }): { deps: ReattachDeps; seen: Recorded } {
  const seen: Recorded = { announced: [], tracked: 0, ended: [], dispatched: [] }
  const now = Date.now()
  const session = {
    id: SESSION_ID,
    contextType: 'project',
    contextId: 'proj-1',
    workspaceId: 'ws-1',
    activeTurnId: 'turn-1',
    activeTurnStartedAt: new Date(now - 60_000),
    // Stale enough to be claimed, recent enough to be inside MAX_HEARTBEAT_AGE_MS.
    activeTurnHeartbeatAt: new Date(now - TURN_REATTACH_AFTER_MS - 1_000),
  }
  const db = {
    chatSession: {
      findMany: async () => [session],
      updateMany: async () => ({ count: 1 }),
    },
    chatMessage: { findFirst: async () => ({ id: 'msg-1', model: 'auto' }) },
  }
  const deps: ReattachDeps = {
    db,
    acquireLease: async () => true,
    track: (async () => {
      seen.tracked++
      return { text: 'done', usage: null, seq: 1 } as any
    }) as any,
    resolveTarget: async () =>
      opts.target === 'missing'
        ? null
        : {
            project: { id: 'proj-1', workspaceId: 'ws-1' },
            fetchRuntime: async () =>
              opts.target === 'alive'
                ? new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 })
                : new Response('gone', { status: 404 }),
          },
    startTurnHeartbeat: () => () => {},
    markTurnEnded: async (id: string) => {
      seen.ended.push(id)
    },
    dispatchNext: async (id: string) => {
      seen.dispatched.push(id)
    },
    getCallLink: async () => undefined,
    settleCall: async () => {},
    announceInterrupted: async (id: string) => {
      seen.announced.push(id)
      return { noted: true, queued: true }
    },
    homeSessionWhere: () => null,
    now: () => now,
  }
  return { deps, seen }
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('chat turn reattach: dead runtime (SHO-121)', () => {
  test('a turn whose runtime is gone announces the interruption instead of ending silently', async () => {
    const { deps, seen } = fakeDeps({ target: 'missing' })
    await reattachStaleTurns(deps)
    await until(() => seen.ended.length > 0)

    expect(seen.announced).toEqual([SESSION_ID])
    expect(seen.tracked).toBe(0)
    // The turn is still closed out, and the queued resume still gets dispatched.
    expect(seen.ended).toEqual([SESSION_ID])
    expect(seen.dispatched).toEqual([SESSION_ID])
  })

  test('an unreachable stream buffer announces the interruption too', async () => {
    const { deps, seen } = fakeDeps({ target: 'unreachable' })
    await reattachStaleTurns(deps)
    await until(() => seen.ended.length > 0)

    expect(seen.announced).toEqual([SESSION_ID])
    expect(seen.tracked).toBe(0)
  })

  test('a live buffer is followed and says nothing about an interruption', async () => {
    const { deps, seen } = fakeDeps({ target: 'alive' })
    await reattachStaleTurns(deps)
    await until(() => seen.ended.length > 0)

    expect(seen.tracked).toBe(1)
    expect(seen.announced).toEqual([])
  })

  test('the announcement tells the user what happened without asking them to type anything', async () => {
    const resuming = interruptedTurnResumePrompt('exec')
    expect(resuming).toContain('I was interrupted while running `exec` — resuming.')
    expect(resuming).toContain('Pick up exactly where you left off. Do not start over.')
    expect(resuming.toLowerCase()).not.toContain('type "continue"')
    // With no recorded tool it still reads as a sentence.
    expect(interruptedTurnNote(null)).toBe('I was interrupted while working — resuming.')
    // The second death keeps the turn stopped and does not promise a resume.
    const noteOnly = interruptedTurnNote('exec', { resuming: false })
    expect(noteOnly).toContain('I was interrupted while running `exec`')
    expect(noteOnly).not.toContain('resuming')
    // The queued prompt never repeats the note: the note is the assistant line
    // right before it, so the transcript shows one interruption, not two.
    expect(interruptedTurnResumeInstruction()).not.toContain('I was interrupted')
    expect(interruptedTurnResumeInstruction()).not.toBe(resuming)
  })

  test('the queued resume is not counted as a task wake (so it cannot pause wakes)', () => {
    const prompt = interruptedTurnResumePrompt('exec')
    // The row the resume service writes: a text part plus a data-resume marker,
    // deliberately without the data-task-notification part `consecutiveWakeWaits`
    // looks for.
    const parts = JSON.stringify([{ type: 'text', text: prompt }, { type: 'data-resume', data: { toolName: 'exec' } }])
    expect(isTaskWakeMessage(parts)).toBe(false)
  })
})
