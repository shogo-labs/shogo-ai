// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A cut stream is re-attached until the turn is actually done (SHO-546).
 *
 * On a desktop-hosted workspace the tracker's stream is cut, the replacement
 * stream is cut again minutes later, and the turn keeps working on the desktop.
 * The tracker used to resume exactly once and then give up — after wiping what it
 * had — so a long turn left either no row or an empty one.
 *
 * These tests pin the three behaviours the fix adds:
 *
 *   1. EOF → replay cut → replay → `data-turn-complete`: two resume legs, and the
 *      row holds the FULL turn.
 *   2. A replay that yields less than the previous leg never shrinks the row, and
 *      the tracker never reports persisting an empty turn.
 *   3. The loop is bounded by the turn's lifetime (`resumeBudgetMs`), not by an
 *      attempt count.
 *
 * Run: bun test apps/api/src/__tests__/chat-resume-legs.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

type PersistedMessage = {
  id: string
  sessionId: string
  role: string
  content: string
  parts?: string
  agent?: string
}

let persistedMessages: PersistedMessage[] = []
let messageIdCounter = 0

const mockPrisma = {
  chatSession: {
    findUnique: mock(async (args: any) => (args?.where?.id ? { id: args.where.id } : null)),
  },
  chatMessage: {
    create: mock(async (args: any) => {
      const msg: PersistedMessage = { id: `msg-${++messageIdCounter}`, ...args.data }
      persistedMessages.push(msg)
      return msg
    }),
    update: mock(async (args: any) => {
      const row = persistedMessages.find((message) => message.id === args.where.id)
      if (row) Object.assign(row, args.data)
      return row
    }),
    findFirst: mock(async () => null),
  },
  toolCallLog: { createMany: mock(async () => ({ count: 0 })) },
  project: { update: mock(async (args: any) => ({ id: args.where.id, ...args.data })) },
  chatTurnFrame: { deleteMany: mock(async () => ({ count: 0 })) },
}
mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
}))

mock.module('../services/git.service', () => ({ isGitAvailable: () => false }))

import { trackUsageFromStream } from '../routes/project-chat'

const dataFrame = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`
const encoder = new TextEncoder()

function sseStream(frames: string[], opts: { errorAfter?: number } = {}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < frames.length; i++) {
        if (opts.errorAfter !== undefined && i === opts.errorAfter) {
          controller.error(new Error('ECONNRESET'))
          return
        }
        controller.enqueue(encoder.encode(frames[i]!))
      }
      controller.close()
    },
  })
}

/** A replay that sends `text`, then dies mid-stream — the ~5-minute cut shape. */
function cutReplay(text: string): ReadableStream<Uint8Array> {
  return sseStream(
    [dataFrame({ type: 'text-delta', delta: text }), dataFrame({ type: 'text-delta', delta: ' never arrived' })],
    { errorAfter: 1 },
  )
}

function captureConsole() {
  const logs: string[] = []
  const originals = { log: console.log, warn: console.warn }
  const record = (...args: any[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
  }
  console.log = record as any
  console.warn = record as any
  return {
    logs,
    restore() {
      console.log = originals.log
      console.warn = originals.warn
    },
  }
}

describe('trackUsageFromStream — resume legs (SHO-546)', () => {
  beforeEach(() => {
    persistedMessages = []
    messageIdCounter = 0
  })

  test('re-attaches after a cut replay and persists the whole turn', async () => {
    const console_ = captureConsole()
    const original = sseStream([
      dataFrame({ type: 'data-turn-start', data: { turnId: 'turn-1', startedAt: 1_000_000 } }),
      dataFrame({ type: 'text-delta', delta: 'first leg of the turn' }),
      dataFrame({ type: 'data-turn-seq', data: { turnId: 'turn-1', seq: 575 } }),
    ])
    const legs = [
      // Leg 1 replays the buffer up to the cut and is itself cut: no terminal frame.
      () => new Response(cutReplay('first leg of the turn, more replayed text'), { status: 200 }),
      // Leg 2 finally reaches the terminal frame.
      () =>
        new Response(
          sseStream([
            dataFrame({ type: 'data-turn-start', data: { turnId: 'turn-1', startedAt: 1_000_000 } }),
            dataFrame({ type: 'text-delta', delta: 'first leg of the turn, more replayed text' }),
            dataFrame({ type: 'text-delta', delta: ' and the finished answer' }),
            dataFrame({ type: 'data-turn-complete', data: { status: 'completed', lastSeq: 612 } }),
          ]),
          { status: 200 },
        ),
    ]
    let resumeCalls = 0
    try {
      const result = await trackUsageFromStream(
        original,
        { chatSessionId: 'sess-legs', agentMode: 'sonnet' },
        null,
        {
          chatSessionId: 'sess-legs',
          resume: async (fromSeq) => {
            expect(fromSeq).toBe(0)
            return legs[resumeCalls++]!()
          },
          resumeRetryDelaysMs: [0],
          resumeLegDelayMs: 0,
        },
      )
      expect(result.outcome).toBe('complete')
      expect(result.status).toBe('completed')
    } finally {
      console_.restore()
    }

    expect(resumeCalls).toBe(2)
    expect(console_.logs.filter((line) => line.startsWith('[ProjectChat] Resume leg 1 for session sess-legs ('))).toHaveLength(1)
    expect(console_.logs.filter((line) => line.startsWith('[ProjectChat] Resume leg 2 for session sess-legs ('))).toHaveLength(1)
    expect(persistedMessages).toHaveLength(1)
    expect(persistedMessages[0]!.content).toBe('first leg of the turn, more replayed text and the finished answer')
  })

  test('a replay that yields less than the previous leg never shrinks the row', async () => {
    const console_ = captureConsole()
    const original = sseStream([
      dataFrame({ type: 'data-turn-start', data: { turnId: 'turn-2', startedAt: 2_000_000 } }),
      dataFrame({ type: 'text-delta', delta: 'the whole first leg, which the row holds' }),
      dataFrame({ type: 'data-turn-seq', data: { turnId: 'turn-2', seq: 575 } }),
    ])
    let resumeCalls = 0
    try {
      await trackUsageFromStream(original, { chatSessionId: 'sess-short', agentMode: 'sonnet' }, null, {
        chatSessionId: 'sess-short',
        resume: async () => {
          resumeCalls++
          // The buffer's replay starts mid-turn and is cut after a few bytes —
          // the prod shape: `lastObservedSeq=575`, replay dies, "persisting 0 chars".
          if (resumeCalls === 1) return new Response(cutReplay('tiny'), { status: 200 })
          return null
        },
        resumeRetryDelaysMs: [0],
        resumeLegDelayMs: 0,
      })
    } finally {
      console_.restore()
    }

    expect(persistedMessages).toHaveLength(1)
    expect(persistedMessages[0]!.content).toBe('the whole first leg, which the row holds')
    expect(console_.logs.some((line) => line.includes('persisting 0 chars'))).toBe(false)
    expect(console_.logs.some((line) => line.includes('replayed less than we had'))).toBe(true)
  })

  test('the retry loop is bounded by the turn budget, not an attempt count', async () => {
    const original = sseStream([
      dataFrame({ type: 'data-turn-start', data: { turnId: 'turn-3', startedAt: 3_000_000 } }),
      dataFrame({ type: 'text-delta', delta: 'partial' }),
    ])
    let resumeCalls = 0
    const result = await trackUsageFromStream(original, { chatSessionId: 'sess-budget', agentMode: 'sonnet' }, null, {
      chatSessionId: 'sess-budget',
      // Every leg is a 200 that immediately ends without a terminal frame: the
      // turn is alive but never finishes. The budget is what stops us.
      resume: async () => {
        resumeCalls++
        return new Response(sseStream([dataFrame({ type: 'text-delta', delta: 'partial' })]), { status: 200 })
      },
      resumeRetryDelaysMs: [0],
      resumeLegDelayMs: 0,
      resumeBudgetMs: 0,
    })

    expect(resumeCalls).toBe(1)
    expect(result.outcome).toBe('partial')
    expect(persistedMessages[0]!.content).toBe('partial')
  })

  test('a 204 after a good leg keeps that leg and stops', async () => {
    const original = sseStream([
      dataFrame({ type: 'data-turn-start', data: { turnId: 'turn-4', startedAt: 4_000_000 } }),
      dataFrame({ type: 'text-delta', delta: 'first leg' }),
    ])
    const legs: Array<() => Response> = [
      () => new Response(cutReplay('first leg'), { status: 200 }),
      () => new Response(null, { status: 204 }),
    ]
    let resumeCalls = 0
    const result = await trackUsageFromStream(original, { chatSessionId: 'sess-204', agentMode: 'sonnet' }, null, {
      chatSessionId: 'sess-204',
      resume: async () => legs[resumeCalls++]!(),
      resumeRetryDelaysMs: [0],
      resumeLegDelayMs: 0,
    })

    expect(resumeCalls).toBe(2)
    expect(result.outcome).toBe('partial')
    expect(persistedMessages[0]!.content).toBe('first leg')
  })
})

/**
 * Step 4 of the card: the prod turn had **no assistant row at all**.
 *
 * Persistence is not gated on where the workspace runs — the tracker only asks
 * whether it has content. So a hosted turn gets its row from the first leg's
 * coalesced snapshot, and a turn that streamed heartbeats but no payload frames
 * has nothing to write, which is exactly what the prod log showed
 * (`lastObservedSeq=575`, "persisting 0 chars", 0 tool calls).
 */
describe('trackUsageFromStream — hosted snapshot persistence (SHO-546 step 4)', () => {
  beforeEach(() => {
    persistedMessages = []
    messageIdCounter = 0
  })

  test('a hosted workspace gets its assistant row from the first leg, mid-stream', async () => {
    // The tracker is shared by both routes and never sees the host, so this is
    // the hosted-workspace shape: the cloud API tracks a turn whose runtime sits
    // behind the host tunnel. The row must exist before the leg ends.
    let rowsWhileStreaming = -1
    const original = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            dataFrame({ type: 'data-turn-start', data: { turnId: 'turn-hosted', startedAt: 5_000_000 } }),
          ),
        )
        controller.enqueue(encoder.encode(dataFrame({ type: 'text-delta', delta: 'half the answer' })))
        controller.enqueue(
          encoder.encode(dataFrame({ type: 'data-turn-seq', data: { turnId: 'turn-hosted', seq: 575 } })),
        )
        // The turn keeps working: the coalesced snapshot gets a full interval
        // (SNAPSHOT_MIN_INTERVAL_MS = 1 s) to land while this leg is still open.
        await new Promise((resolve) => setTimeout(resolve, 1_400))
        rowsWhileStreaming = persistedMessages.length
        controller.enqueue(
          encoder.encode(
            dataFrame({ type: 'data-turn-complete', data: { status: 'completed', lastSeq: 600 } }),
          ),
        )
        controller.close()
      },
    })

    const result = await trackUsageFromStream(
      original,
      { chatSessionId: 'sess-hosted', agentMode: 'sonnet' },
      null,
      { chatSessionId: 'sess-hosted', resumeRetryDelaysMs: [0], resumeLegDelayMs: 0 },
    )

    expect(result.outcome).toBe('complete')
    expect(rowsWhileStreaming).toBe(1)
    expect(persistedMessages).toHaveLength(1)
    expect(persistedMessages[0]!.sessionId).toBe('sess-hosted')
    expect(persistedMessages[0]!.content).toBe('half the answer')
  })

  test('a heartbeat-only turn persists nothing — and now says so', async () => {
    const console_ = captureConsole()
    const original = sseStream([
      dataFrame({ type: 'data-turn-start', data: { turnId: 'turn-heartbeat', startedAt: 6_000_000 } }),
      dataFrame({ type: 'data-turn-seq', data: { turnId: 'turn-heartbeat', seq: 575 } }),
    ])
    try {
      const result = await trackUsageFromStream(
        original,
        { chatSessionId: 'sess-heartbeat', agentMode: 'sonnet' },
        null,
        {
          chatSessionId: 'sess-heartbeat',
          resume: async () => new Response(null, { status: 204 }),
          resumeRetryDelaysMs: [0],
          resumeLegDelayMs: 0,
        },
      )
      expect(result.outcome).toBe('partial')
    } finally {
      console_.restore()
    }

    expect(persistedMessages).toHaveLength(0)
    expect(console_.logs.some((line) => line.includes('produced no assistant content'))).toBe(true)
    expect(console_.logs.some((line) => line.includes('lastObservedSeq=575'))).toBe(true)
  })
})

afterEach(() => {
  persistedMessages = []
})
