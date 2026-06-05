// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Accumulator-reset tests for `trackUsageFromStream` in `project-chat.ts`.
 *
 * When the runtime re-issues a model call that dropped mid-generation it emits
 * a `data-inference-retry` frame. The API-side parser must discard the failed
 * step's partial text/reasoning (and any partially-streamed tool input that
 * never executed) so the persisted `ChatMessage` reflects ONLY the final,
 * retried output — never a concatenation of the thrown-away partial with the
 * regenerated text. Completed tool calls from earlier steps must be preserved.
 *
 * Run: bun test apps/api/src/__tests__/chat-inference-retry-reset.test.ts
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
  },
  toolCallLog: {
    createMany: mock(async (args: any) => {
      persistedToolCalls.push(...args.data)
      return { count: args.data.length }
    }),
  },
  project: {
    update: mock(async (args: any) => ({ id: args.where.id, ...args.data })),
  },
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

describe('trackUsageFromStream — inference-retry accumulator reset', () => {
  beforeEach(() => {
    persistedMessages = []
    persistedToolCalls = []
    messageIdCounter = 0
  })

  test('discards the failed step partial text on data-inference-retry', async () => {
    const projectId = 'proj-retry-text'
    const chatSessionId = 'sess-retry-text'
    openSession(projectId, 'ws', 'user')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 30)

    const stream = makeSseStream([
      // Failed step: partial text streamed, then the model call drops and is retried.
      dataFrame({ type: 'text-delta', delta: 'partial that was ' }),
      dataFrame({ type: 'text-delta', delta: 'thrown away' }),
      dataFrame({ type: 'data-inference-retry', data: { attempt: 1, maxAttempts: 2, reason: 'network' } }),
      // Retried step: the real, final answer.
      dataFrame({ type: 'text-delta', delta: 'final ' }),
      dataFrame({ type: 'text-delta', delta: 'answer' }),
      dataFrame({ type: 'data-turn-complete', data: { status: 'completed', lastSeq: 9 } }),
      dataFrame({ type: 'finish', usage: { inputTokens: 100, outputTokens: 30 } }),
    ])

    await trackUsageFromStream(
      stream,
      { chatSessionId, agentMode: 'sonnet' },
      { id: projectId, workspaceId: 'ws' },
      { resume: async () => null },
    )

    expect(persistedMessages).toHaveLength(1)
    // Only the post-retry output — no concatenation of the discarded partial.
    expect(persistedMessages[0].content).toBe('final answer')
    expect(persistedMessages[0].content).not.toContain('thrown away')
    const parts = JSON.parse(persistedMessages[0].parts || '[]')
    const textParts = parts.filter((p: any) => p.type === 'text')
    expect(textParts).toHaveLength(1)
    expect(textParts[0].text).toBe('final answer')
  })

  test('preserves completed tool calls from earlier steps across a retry', async () => {
    const projectId = 'proj-retry-tool'
    const chatSessionId = 'sess-retry-tool'
    openSession(projectId, 'ws', 'user')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 30)

    const stream = makeSseStream([
      // Step 1 completes a tool call (executed -> has output).
      dataFrame({ type: 'text-delta', delta: 'looking at the file. ' }),
      dataFrame({
        type: 'tool-input-available',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        input: { path: 'a.ts' },
      }),
      dataFrame({ type: 'tool-output-available', toolCallId: 'tc-1', output: { content: 'body' } }),
      // Step 2 starts generating text + a partial tool input, then drops -> retry.
      dataFrame({ type: 'text-delta', delta: 'half-written ' }),
      dataFrame({ type: 'tool-input-start', toolCallId: 'tc-2-partial', toolName: 'edit_file' }),
      dataFrame({ type: 'data-inference-retry', data: { attempt: 1, maxAttempts: 2, reason: 'server_5xx' } }),
      // Retried step 2: the final answer text.
      dataFrame({ type: 'text-delta', delta: 'Here is the summary.' }),
      dataFrame({ type: 'data-turn-complete', data: { status: 'completed', lastSeq: 12 } }),
      dataFrame({ type: 'finish', usage: { inputTokens: 100, outputTokens: 30 } }),
    ])

    await trackUsageFromStream(
      stream,
      { chatSessionId, agentMode: 'sonnet' },
      { id: projectId, workspaceId: 'ws' },
      { resume: async () => null },
    )

    expect(persistedMessages).toHaveLength(1)
    // Completed tool call survives; the partial step-2 text is dropped.
    expect(persistedMessages[0].content).toBe('looking at the file. Here is the summary.')
    expect(persistedMessages[0].content).not.toContain('half-written')

    // Only the executed tool is logged; the partial (never-executed) tool is dropped.
    expect(persistedToolCalls).toHaveLength(1)
    expect(persistedToolCalls[0].toolName).toBe('read_file')

    const parts = JSON.parse(persistedMessages[0].parts || '[]')
    const toolParts = parts.filter((p: any) => p.type === 'dynamic-tool')
    expect(toolParts).toHaveLength(1)
    expect(toolParts[0].toolName).toBe('read_file')
  })
})
