// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Failure-mode tests for src/lib/a2a/executor.ts (ShogoAgentExecutor),
// driven directly against the executor (no HTTP/JSON-RPC layer) with a
// fully mocked "pod": resolveProjectPodUrl, deriveProjectRuntimeToken,
// trackUsageFromStream, and global fetch. Covers:
//   - happy-path turn completion
//   - EOF without data-turn-complete -> resume from the pod buffer
//   - resume returning HTTP 204 (buffer expired) -> terminal FAILED
//   - an unanswered ask_user call -> terminal INPUT_REQUIRED
//   - two execute() calls sharing a contextId -> the second is rejected

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Role, TaskState, type SendMessageRequest, type TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { RequestContext, ServerCallContext, type AgentExecutionEvent, type ExecutionEventBus } from '@a2a-js/sdk/server'
import type { PrismaA2ATaskStore } from '../task-store'

process.env.CHAT_UPSTREAM_FETCH_TIMEOUT_MS = '600000'
process.env.CHAT_STREAM_IDLE_TIMEOUT_MS = '600000'

mock.module('../../prisma', () => ({
  prisma: {
    chatSession: {
      findUnique: async () => null,
      create: async () => ({}),
    },
  },
}))

mock.module('../../resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: 'http://fake-pod.test' }),
}))

mock.module('../../project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'fake-runtime-token',
}))

mock.module('../../../routes/project-chat', () => ({
  trackUsageFromStream: async (stream: ReadableStream<Uint8Array>) => {
    // Drain the billing branch so the mapper branch's tee() doesn't stall.
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  },
}))

const { ShogoAgentExecutor } = await import('../executor')

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function sseStream(chunks: any[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[i++])}\n\n`))
    },
  })
}

const fakeTaskStore = {
  save: async () => {},
  load: async () => undefined,
  list: async () => ({ tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 }),
} as unknown as PrismaA2ATaskStore

function makeBus(): { bus: ExecutionEventBus; events: AgentExecutionEvent[] } {
  const events: AgentExecutionEvent[] = []
  const bus: ExecutionEventBus = {
    publish: (e) => {
      events.push(e)
    },
    on: () => bus,
    off: () => bus,
    once: () => bus,
    removeAllListeners: () => bus,
    finished: () => {},
  }
  return { bus, events }
}

function makeSendMessageRequest(text: string, extensions: string[] = []): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: 'msg-1',
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined,
      extensions,
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  }
}

function makeReqCtx(opts: { taskId: string; contextId: string; text: string; requestedExtensions?: string[] }) {
  const context = new ServerCallContext({ tenant: 'proj-1', requestedExtensions: opts.requestedExtensions })
  return new RequestContext(makeSendMessageRequest(opts.text, opts.requestedExtensions), opts.taskId, opts.contextId, context)
}

function lastStatus(events: AgentExecutionEvent[]): TaskStatusUpdateEvent {
  const statusEvents = events.filter((e) => e.kind === 'statusUpdate')
  return statusEvents[statusEvents.length - 1].data as TaskStatusUpdateEvent
}

const originalFetch = globalThis.fetch
let fetchImpl: (url: string, init?: any) => Promise<Response>
let fetchCalls: string[]

beforeEach(() => {
  fetchCalls = []
  fetchImpl = async () => new Response(null, { status: 500 })
  globalThis.fetch = (async (url: any, init?: any) => {
    fetchCalls.push(String(url))
    return fetchImpl(String(url), init)
  }) as any
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function newExecutor() {
  return new ShogoAgentExecutor({ projectId: 'proj-1', workspaceId: 'ws-1', taskStore: fakeTaskStore })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShogoAgentExecutor.execute — happy path', () => {
  it('publishes task -> WORKING -> artifact text -> terminal COMPLETED', async () => {
    fetchImpl = async (url) => {
      if (url.endsWith('/agent/chat')) {
        return new Response(
          sseStream([{ type: 'text-delta', delta: 'Hi there' }, { type: 'data-turn-complete', data: { status: 'completed' } }]),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const executor = newExecutor()
    const { bus, events } = makeBus()
    await executor.execute(makeReqCtx({ taskId: 't1', contextId: 'c1', text: 'hello' }), bus)

    expect(events[0].kind).toBe('task')
    expect(events.some((e) => e.kind === 'artifactUpdate')).toBe(true)
    expect(lastStatus(events).status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(executor.hasActiveWork).toBe(false)
  })

  it('fails the turn when the message has no text parts', async () => {
    const executor = newExecutor()
    const { bus, events } = makeBus()
    await executor.execute(makeReqCtx({ taskId: 't1', contextId: 'c1', text: '' }), bus)
    expect(lastStatus(events).status?.state).toBe(TaskState.TASK_STATE_FAILED)
    expect(fetchCalls).toHaveLength(0) // never reaches the pod
  })
})

describe('ShogoAgentExecutor.execute — resume on missing data-turn-complete', () => {
  it('re-fetches the pod buffer at fromSeq and completes once the resume stream sees data-turn-complete', async () => {
    fetchImpl = async (url) => {
      if (url.endsWith('/agent/chat')) {
        // EOFs after a partial chunk, no data-turn-complete.
        return new Response(sseStream([{ type: 'text-delta', delta: 'partial' }]), { status: 200 })
      }
      if (url.includes('/stream?fromSeq=')) {
        return new Response(sseStream([{ type: 'data-turn-complete', data: { status: 'completed' } }]), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const executor = newExecutor()
    const { bus, events } = makeBus()
    await executor.execute(makeReqCtx({ taskId: 't1', contextId: 'c1', text: 'hello' }), bus)

    expect(fetchCalls.filter((u) => u.includes('/stream?fromSeq='))).toHaveLength(1)
    expect(lastStatus(events).status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('publishes terminal FAILED when the resume buffer has expired (HTTP 204)', async () => {
    fetchImpl = async (url) => {
      if (url.endsWith('/agent/chat')) return new Response(sseStream([]), { status: 200 })
      if (url.includes('/stream?fromSeq=')) return new Response(null, { status: 204 })
      throw new Error(`unexpected fetch: ${url}`)
    }

    const executor = newExecutor()
    const { bus, events } = makeBus()
    await executor.execute(makeReqCtx({ taskId: 't1', contextId: 'c1', text: 'hello' }), bus)

    const status = lastStatus(events)
    expect(status.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    const text = (status.status?.message?.parts[0].content as any)?.value
    expect(text).toMatch(/buffer has since expired/)
  })

  it('publishes terminal FAILED when the resume itself never sees data-turn-complete', async () => {
    fetchImpl = async (url) => {
      if (url.endsWith('/agent/chat')) return new Response(sseStream([]), { status: 200 })
      if (url.includes('/stream?fromSeq=')) return new Response(sseStream([]), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }

    const executor = newExecutor()
    const { bus, events } = makeBus()
    await executor.execute(makeReqCtx({ taskId: 't1', contextId: 'c1', text: 'hello' }), bus)

    const status = lastStatus(events)
    expect(status.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    expect((status.status?.message?.parts[0].content as any)?.value).toMatch(/ended unexpectedly/)
  })
})

describe('ShogoAgentExecutor.execute — ask_user', () => {
  it('maps an unanswered ask_user call to terminal INPUT_REQUIRED', async () => {
    fetchImpl = async (url) => {
      if (url.endsWith('/agent/chat')) {
        return new Response(
          sseStream([
            {
              type: 'tool-input-available',
              toolCallId: 'call-1',
              toolName: 'ask_user',
              input: { questions: [{ header: 'Confirm', question: 'Delete the file?' }] },
            },
            { type: 'data-turn-complete', data: { status: 'completed' } },
          ]),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const executor = newExecutor()
    const { bus, events } = makeBus()
    await executor.execute(makeReqCtx({ taskId: 't1', contextId: 'c1', text: 'delete a.txt' }), bus)

    const status = lastStatus(events)
    expect(status.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    expect((status.status?.message?.parts[0].content as any)?.value).toBe('Confirm: Delete the file?')
  })
})

describe('ShogoAgentExecutor.execute — concurrent same-context tasks', () => {
  it('rejects a second execute() call for a contextId that already has a turn in flight', async () => {
    let releasePod: ((res: Response) => void) | undefined
    fetchImpl = async (url) => {
      if (url.endsWith('/agent/chat')) {
        return new Promise<Response>((resolve) => {
          releasePod = resolve
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const executor = newExecutor()
    const { bus: bus1, events: events1 } = makeBus()
    const { bus: bus2, events: events2 } = makeBus()

    const p1 = executor.execute(makeReqCtx({ taskId: 't1', contextId: 'shared-ctx', text: 'first' }), bus1)
    // Fired before p1 has resolved: the synchronous prefix of execute()/runTurn()
    // (up to its first await) has already registered 'shared-ctx' as in-flight.
    expect(executor.hasActiveWork).toBe(true)
    const p2 = executor.execute(makeReqCtx({ taskId: 't2', contextId: 'shared-ctx', text: 'second' }), bus2)

    await expect(p2).rejects.toThrow(/already in progress/)
    expect(events2).toEqual([]) // rejected before publishing anything

    // p1's chain (ensureChatSession -> resolveProjectPodUrl ->
    // deriveProjectRuntimeToken -> fetch) still needs a few microtask/
    // macrotask hops to reach the pod fetch and populate `releasePod`.
    while (!releasePod) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    releasePod!(new Response(sseStream([{ type: 'data-turn-complete', data: { status: 'completed' } }]), { status: 200 }))
    await p1
    expect(lastStatus(events1).status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(executor.hasActiveWork).toBe(false)
  })

  it('allows a second execute() call once the first contextId turn has settled', async () => {
    fetchImpl = async (url) => {
      if (url.endsWith('/agent/chat')) {
        return new Response(sseStream([{ type: 'data-turn-complete', data: { status: 'completed' } }]), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const executor = newExecutor()
    const { bus: bus1, events: events1 } = makeBus()
    const { bus: bus2, events: events2 } = makeBus()

    await executor.execute(makeReqCtx({ taskId: 't1', contextId: 'shared-ctx', text: 'first' }), bus1)
    await executor.execute(makeReqCtx({ taskId: 't2', contextId: 'shared-ctx', text: 'second' }), bus2)

    expect(lastStatus(events1).status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(lastStatus(events2).status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })
})
