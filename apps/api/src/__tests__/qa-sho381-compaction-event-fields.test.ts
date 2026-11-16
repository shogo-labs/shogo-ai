// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-381 — the `data-context-summarized` part the API persists must carry the
 * two fields the card was extended for, and must keep a real `0`.
 *
 * `droppedToolResults: 0` is the state "variant B1 ran and dropped nothing".
 * `Number(x) || undefined` turns it into `undefined`, which is indistinguishable
 * from "variant A / field never sent" — the exact ambiguity Russell asked us to
 * remove. `promptOverheadTokens` is the other half: how much of `tokensAfter` is
 * tool definitions rather than conversation.
 *
 * Run: bun test apps/api/src/__tests__/qa-sho381-compaction-event-fields.test.ts
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

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
  },
  toolCallLog: { createMany: mock(async () => ({ count: 0 })) },
  project: { update: mock(async (args: any) => ({ id: args.where.id, ...args.data })) },
}
mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
}))
mock.module('../services/git.service', () => ({ isGitAvailable: () => false }))

import { openSession, accumulateUsage } from '../lib/proxy-billing-session'
import { trackUsageFromStream } from '../routes/project-chat'

function makeSseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
}

function dataFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function summarizedParts(): any[] {
  const parts = persistedMessages.flatMap((m) => (m.parts ? JSON.parse(m.parts) : []))
  return parts.filter((p: any) => p?.type === 'data-context-summarized')
}

async function runWithSummarizedFrame(data: Record<string, unknown>, projectId: string) {
  persistedMessages = []
  messageIdCounter = 0
  await openSession(projectId, `ws-${projectId}`, `user-${projectId}`)
  await accumulateUsage(projectId, 'claude-sonnet-4-5', 200, 50)
  await trackUsageFromStream(
    makeSseStream([
      dataFrame({ type: 'text-delta', delta: 'compacted' }),
      dataFrame({ type: 'data-context-summarized', data }),
      dataFrame({ type: 'data-turn-complete', data: { status: 'completed' } }),
      dataFrame({ type: 'finish', usage: { inputTokens: 200, outputTokens: 50 } }),
    ]),
    { chatSessionId: `sess-${projectId}`, agentMode: 'sonnet' },
    { id: projectId, workspaceId: `ws-${projectId}` },
    { resume: async () => null },
  )
  return summarizedParts()
}

beforeEach(() => {
  persistedMessages = []
  messageIdCounter = 0
})

describe('SHO-381: the persisted compaction part carries the diagnostic fields', () => {
  test('a B1 compaction that dropped nothing persists droppedToolResults: 0, not undefined', async () => {
    const parts = await runWithSummarizedFrame(
      {
        trigger: 'auto',
        tokensBefore: 300_000,
        tokensAfter: 120_000,
        messagesBefore: 40,
        messagesAfter: 6,
        summaryChars: 900,
        contextWindowTokens: 1_000_000,
        promptOverheadTokens: 25_898,
        droppedToolResults: 0,
      },
      'proj-sho381-zero',
    )
    expect(parts).toHaveLength(1)
    expect(parts[0].data.droppedToolResults).toBe(0)
    expect(parts[0].data.promptOverheadTokens).toBe(25_898)
  }, 60_000)

  test('a B1 compaction that dropped results persists the count', async () => {
    const parts = await runWithSummarizedFrame(
      {
        trigger: 'auto',
        tokensBefore: 300_000,
        tokensAfter: 120_000,
        messagesBefore: 40,
        messagesAfter: 6,
        summaryChars: 900,
        contextWindowTokens: 1_000_000,
        promptOverheadTokens: 25_898,
        droppedToolResults: 3,
      },
      'proj-sho381-dropped',
    )
    expect(parts).toHaveLength(1)
    expect(parts[0].data.droppedToolResults).toBe(3)
  }, 60_000)

  test('a frame without the fields (older runtime) persists neither', async () => {
    const parts = await runWithSummarizedFrame(
      {
        trigger: 'auto',
        tokensBefore: 300_000,
        tokensAfter: 120_000,
        messagesBefore: 40,
        messagesAfter: 6,
        summaryChars: 900,
        contextWindowTokens: 1_000_000,
      },
      'proj-sho381-absent',
    )
    expect(parts).toHaveLength(1)
    expect(parts[0].data.droppedToolResults).toBeUndefined()
    expect(parts[0].data.promptOverheadTokens).toBeUndefined()
  }, 60_000)
})
