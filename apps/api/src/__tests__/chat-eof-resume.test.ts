// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Auto-resume + partial-persist tests for `trackUsageFromStream` in
 * `project-chat.ts`.
 *
 * Covers the three real-world stream-end shapes:
 *
 *   1. Clean stream — `data-turn-complete` arrives before EOF: the resume
 *      hook is never invoked and the assistant message + tool calls are
 *      persisted as today.
 *
 *   2. EOF without `data-turn-complete`, resume returns 200 with the
 *      missing tail (Knative activator 5-min cut, buffer alive on the
 *      runtime): the parser resets state and re-consumes the full
 *      replay so the persisted row reflects the FULL turn.
 *
 *   3. EOF without `data-turn-complete`, resume returns 204 (user clicked
 *      Stop, pod crashed, buffer expired): the partial accumulated from
 *      the original stream is persisted so the user's truncated turn
 *      still lands in DB.
 *
 * Run: bun test apps/api/src/__tests__/chat-eof-resume.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ─── Prisma mock ──────────────────────────────────────────────────────────
type PersistedMessage = {
  id: string
  sessionId: string
  role: string
  content: string
  parts?: string
  agent?: string
}

let persistedMessages: PersistedMessage[] = []
let persistedToolCalls: any[] = []
let projectUpdates: any[] = []
let messageIdCounter = 0

const mockPrisma = {
  chatSession: {
    findUnique: mock(async (args: any) => {
      // Treat any session lookup as found so the persistence path runs.
      return args?.where?.id ? { id: args.where.id } : null
    }),
  },
  chatMessage: {
    create: mock(async (args: any) => {
      const msg: PersistedMessage = {
        id: `msg-${++messageIdCounter}`,
        ...args.data,
      }
      persistedMessages.push(msg)
      return msg
    }),
  },
  toolCallLog: {
    createMany: mock(async (args: any) => {
      persistedToolCalls.push(...args.data)
      return { count: args.data.length }
    }),
  },
  project: {
    update: mock(async (args: any) => {
      projectUpdates.push(args)
      return { id: args.where.id, ...args.data }
    }),
  },
}
mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

// ─── Billing-service mock ─────────────────────────────────────────────────
let consumeUsageCalls: any[] = []
mock.module('../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return { success: true, remainingIncludedUsd: 99 }
  },
}))

// Skip auto-checkpoint without forcing a fake workspace path.
mock.module('../services/git.service', () => ({
  isGitAvailable: () => false,
}))

// ─── System under test (imported AFTER mocks) ────────────────────────────
import {
  openSession,
  hasSession,
  accumulateUsage,
} from '../lib/proxy-billing-session'
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

describe('trackUsageFromStream — auto-resume + partial-persist', () => {
  beforeEach(() => {
    persistedMessages = []
    persistedToolCalls = []
    projectUpdates = []
    consumeUsageCalls = []
    messageIdCounter = 0
  })

  test('clean stream with data-turn-complete persists and bills as today', async () => {
    const projectId = 'proj-clean'
    const chatSessionId = 'sess-clean'
    openSession(projectId, 'ws-clean', 'user-clean')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 200, 50)

    const stream = makeSseStream([
      dataFrame({ type: 'text-delta', delta: 'hello ' }),
      dataFrame({ type: 'text-delta', delta: 'world' }),
      dataFrame({ type: 'data-turn-complete', data: { status: 'completed', lastSeq: 5 } }),
      dataFrame({ type: 'finish', usage: { inputTokens: 200, outputTokens: 50 } }),
    ])

    let resumeCalls = 0
    await trackUsageFromStream(
      stream,
      { chatSessionId, agentMode: 'sonnet' },
      { id: projectId, workspaceId: 'ws-clean' },
      {
        resume: async () => {
          resumeCalls++
          return null
        },
      },
    )

    expect(resumeCalls).toBe(0)
    expect(hasSession(projectId)).toBe(false)
    expect(consumeUsageCalls.length).toBe(1)
    expect(persistedMessages.length).toBe(1)
    expect(persistedMessages[0].content).toBe('hello world')
    expect(persistedMessages[0].sessionId).toBe(chatSessionId)
  })

  test('EOF without turn-complete + resume(200) re-drains full turn from buffer', async () => {
    const projectId = 'proj-resume-ok'
    const chatSessionId = 'sess-resume-ok'
    openSession(projectId, 'ws-r', 'user-r')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 30)

    // Original POST stream EOFs with a truncated text-delta and no
    // terminal `data-turn-complete` marker — exactly the Knative cut shape.
    const originalStream = makeSseStream([
      dataFrame({ type: 'text-delta', delta: 'hello ' }),
      dataFrame({ type: 'data-turn-seq', data: { turnId: 't1', seq: 7 } }),
    ])

    // The runtime's resume buffer replays everything from the start, this
    // time including the missing tail and the terminal marker. Charging /
    // resumed AI proxy calls would have accumulated into the SAME billing
    // session before close.
    const resumeBody = makeSseStream([
      dataFrame({ type: 'text-delta', delta: 'hello ' }),
      dataFrame({ type: 'text-delta', delta: 'world from resume' }),
      dataFrame({
        type: 'tool-input-available',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        input: { path: 'a.ts' },
      }),
      dataFrame({
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { content: 'file body' },
      }),
      dataFrame({ type: 'data-turn-complete', data: { status: 'completed', lastSeq: 42 } }),
      dataFrame({ type: 'finish', usage: { inputTokens: 250, outputTokens: 80 } }),
    ])

    // Simulate the additional AI proxy call(s) that run on the resumed turn:
    // they accumulate into the still-open billing session before close.
    accumulateUsage(projectId, 'claude-sonnet-4-5', 150, 50)

    const resumeFromSeqs: number[] = []
    const resumeFn = async (fromSeq: number) => {
      resumeFromSeqs.push(fromSeq)
      return new Response(resumeBody, { status: 200 })
    }

    await trackUsageFromStream(
      originalStream,
      { chatSessionId, agentMode: 'sonnet' },
      { id: projectId, workspaceId: 'ws-r' },
      { resume: resumeFn },
    )

    // Resume was attempted exactly once with fromSeq=0 (full replay).
    expect(resumeFromSeqs).toEqual([0])
    // DB row reflects the FULL recovered text, not the truncated original.
    expect(persistedMessages.length).toBe(1)
    expect(persistedMessages[0].content).toBe('hello world from resume')
    // Tool call from the resumed tail is recorded.
    expect(persistedToolCalls.length).toBe(1)
    expect(persistedToolCalls[0].toolName).toBe('read_file')
    // Billing closed (not discarded) — full session charged.
    expect(hasSession(projectId)).toBe(false)
    expect(consumeUsageCalls.length).toBe(1)
    expect(consumeUsageCalls[0].actionMetadata.requestCount).toBe(2)
  })

  test('EOF without turn-complete + resume(204) persists partial (stop button case)', async () => {
    const projectId = 'proj-stop'
    const chatSessionId = 'sess-stop'
    openSession(projectId, 'ws-s', 'user-s')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 30)

    // The user clicked stop before the turn finished. We saw some text +
    // one completed tool call before the abort hit.
    const originalStream = makeSseStream([
      dataFrame({ type: 'text-delta', delta: 'partial reply' }),
      dataFrame({
        type: 'tool-input-available',
        toolCallId: 'tc-1',
        toolName: 'exec',
        input: { command: 'ls' },
      }),
      dataFrame({
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { stdout: 'ok' },
      }),
      dataFrame({ type: 'data-turn-seq', data: { turnId: 't', seq: 3 } }),
    ])

    let resumeCalls = 0
    const resumeFn = async () => {
      resumeCalls++
      // Buffer was aborted by `/agent/stop` → 204
      return new Response(null, { status: 204 })
    }

    await trackUsageFromStream(
      originalStream,
      { chatSessionId, agentMode: 'sonnet' },
      { id: projectId, workspaceId: 'ws-s' },
      { resume: resumeFn },
    )

    expect(resumeCalls).toBe(1)
    // Partial row was persisted — the user's truncated turn lands in DB.
    expect(persistedMessages.length).toBe(1)
    expect(persistedMessages[0].content).toBe('partial reply')
    expect(persistedToolCalls.length).toBe(1)
    expect(persistedToolCalls[0].toolName).toBe('exec')
    // Billing closed (NOT discarded) — we charge for what the user actually
    // consumed up to the cut.
    expect(hasSession(projectId)).toBe(false)
    expect(consumeUsageCalls.length).toBe(1)
    expect(consumeUsageCalls[0].actionMetadata.requestCount).toBe(1)
  })

  test('EOF without turn-complete + resume hook returns null persists partial', async () => {
    // Covers the case where `chatSessionId` is missing or `fetchFromRuntime`
    // throws — resume returns null, we keep what we had.
    const projectId = 'proj-noresume'
    const chatSessionId = 'sess-noresume'
    openSession(projectId, 'ws-n', 'user-n')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 50, 10)

    const stream = makeSseStream([
      dataFrame({ type: 'text-delta', delta: 'half-finished thought' }),
    ])

    await trackUsageFromStream(
      stream,
      { chatSessionId, agentMode: 'sonnet' },
      { id: projectId, workspaceId: 'ws-n' },
      { resume: async () => null },
    )

    expect(persistedMessages.length).toBe(1)
    expect(persistedMessages[0].content).toBe('half-finished thought')
    expect(consumeUsageCalls.length).toBe(1)
  })

  test('legacy chats without chatSessionId are still billed (no persist, no resume)', async () => {
    const projectId = 'proj-legacy'
    openSession(projectId, 'ws-l', 'user-l')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 60, 15)

    const stream = makeSseStream([
      dataFrame({ type: 'text-delta', delta: 'reply' }),
      dataFrame({ type: 'data-turn-complete', data: { status: 'completed' } }),
      dataFrame({ type: 'finish', usage: { inputTokens: 60, outputTokens: 15 } }),
    ])

    let resumeCalls = 0
    await trackUsageFromStream(
      stream,
      { agentMode: 'sonnet' },
      { id: projectId, workspaceId: 'ws-l' },
      {
        resume: async () => {
          resumeCalls++
          return null
        },
      },
    )

    expect(resumeCalls).toBe(0)
    expect(persistedMessages.length).toBe(0)
    expect(consumeUsageCalls.length).toBe(1)
  })
})
