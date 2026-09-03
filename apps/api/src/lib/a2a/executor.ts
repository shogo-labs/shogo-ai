// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `ShogoAgentExecutor` — the shogo equivalent of Odin's `OdinAgentExecutor`
 * (`services/a2a/executor.py`).
 *
 * Odin's executor bridges A2A directly into an in-process
 * `ToolUseAgent.ainvoke()`. Shogo's agent is a per-project pod
 * (`AgentGateway`, reached over HTTP), so this executor is a *stream
 * consumer*, not an in-process invoker: it POSTs to the pod's
 * `/agent/chat`, tees the SSE response one branch into
 * `trackUsageFromStream` (billing + `ChatMessage`/`ToolCallLog`
 * persistence, exactly like a UI turn) and one branch into
 * `mapPodChunkToA2AEvents` (published on the A2A `ExecutionEventBus`).
 */

import crypto from 'crypto'
import { JsonRpcTaskNotCancelableError } from '@a2a-js/sdk/errors'
import { Role, TaskState, type Task } from '@a2a-js/sdk'
import {
  AgentEvent,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import { prisma } from '../prisma'
import { resolveProjectPodUrl } from '../resolve-pod-url'
import { deriveProjectRuntimeToken } from '../project-runtime-token'
import { trackUsageFromStream } from '../../routes/project-chat'
import {
  createEventMapperState,
  mapPodChunkToA2AEvents,
  type EventMapperState,
} from './event-mapper'
import type { PrismaA2ATaskStore } from './task-store'

const FETCH_TIMEOUT_MS = parseInt(process.env.CHAT_UPSTREAM_FETCH_TIMEOUT_MS || '14400000', 10)
const IDLE_TIMEOUT_MS = parseInt(process.env.CHAT_STREAM_IDLE_TIMEOUT_MS || '3600000', 10)

/**
 * Extension URI a client declares (via `A2A-Extensions` / requested
 * extensions) to opt into receiving `reasoning-*` chunks as WORKING
 * updates. Off by default — see the event-mapper module doc.
 */
export const A2A_REASONING_EXTENSION_URI = 'https://shogo.ai/a2a/extensions/reasoning'

export interface ShogoAgentExecutorOptions {
  projectId: string
  workspaceId: string
  taskStore: PrismaA2ATaskStore
}

/**
 * Deterministic `chatSessionId` for an A2A `(projectId, contextId)` pair
 * so the pod's `SessionManager` gives repeat sends on the same `contextId`
 * continuous conversation memory — the entire reason A2A has a `contextId`
 * concept distinct from `taskId`.
 */
function deriveChatSessionId(projectId: string, contextId: string): string {
  const hash = crypto.createHash('sha256').update(`${projectId}:${contextId}`).digest('hex')
  return `a2a-${hash.slice(0, 32)}`
}

/** Ensures a `ChatSession` row exists so `trackUsageFromStream` can persist into it. */
async function ensureChatSession(projectId: string, chatSessionId: string): Promise<void> {
  const existing = await prisma.chatSession.findUnique({ where: { id: chatSessionId } })
  if (existing) return
  try {
    await prisma.chatSession.create({
      data: {
        id: chatSessionId,
        contextType: 'project',
        contextId: projectId,
        inferredName: 'A2A session',
      } as any,
    })
  } catch (err: any) {
    // Benign race: a concurrent request for the same contextId created it
    // first. The one-in-flight-turn-per-contextId guard in `execute()`
    // makes this vanishingly rare, but don't fail the turn over it.
    if (err?.code !== 'P2002') throw err
  }
}

/** Extract plain text from an A2A `Message`'s `text` parts, joined with newlines. */
function extractText(message: { parts: Array<{ content?: { $case: string; value: unknown } }> }): string {
  return message.parts
    .filter((p) => p.content?.$case === 'text')
    .map((p) => String((p.content as any).value ?? ''))
    .join('\n')
}

/** True if the message carries any file part not expressed as inline base64. */
function hasRejectedFilePart(message: { parts: Array<{ content?: { $case: string } }> }): string | null {
  for (const part of message.parts) {
    if (part.content?.$case === 'url') {
      return 'Remote file URLs are not supported — the agent runtime does not fetch them server-side. Inline the file as a base64 data URL part instead.'
    }
    if (part.content?.$case === 'raw') {
      return 'File uploads are not yet supported over A2A in this version.'
    }
  }
  return null
}

function nowIso(): string {
  return new Date().toISOString()
}

function emptyTask(taskId: string, contextId: string, state: TaskState, metadata?: Record<string, unknown>): Task {
  return {
    id: taskId,
    contextId,
    status: { state, message: undefined, timestamp: nowIso() },
    artifacts: [],
    history: [],
    metadata,
  }
}

/** Parses one already-`\n`-split SSE line into a JSON chunk, or `null`. Tolerant of `event:`/`id:`/`retry:` lines and `[DONE]`. */
function parseSseDataLine(line: string): any | null {
  if (!line.trim()) return null
  let payload: string
  if (line.startsWith('data: ')) payload = line.slice(6)
  else if (line.startsWith('data:')) payload = line.slice(5)
  else return null
  if (payload === '[DONE]' || !payload.trim()) return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

interface ConsumeResult {
  sawTurnComplete: boolean
}

/** Reads an SSE `ReadableStream`, mapping each chunk to A2A events and publishing them. */
async function consumeAndPublish(
  stream: ReadableStream<Uint8Array>,
  mapperState: EventMapperState,
  ctx: { taskId: string; contextId: string },
  bus: ExecutionEventBus,
  includeReasoning: boolean,
): Promise<ConsumeResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawTurnComplete = false
  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const idleTimeout = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => reject(new Error('A2A chat stream idle timeout')), IDLE_TIMEOUT_MS)
      })
      let result: Awaited<ReturnType<typeof reader.read>>
      try {
        result = await Promise.race([reader.read(), idleTimeout])
      } finally {
        clearTimeout(idleTimer)
      }
      const { done, value } = result
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const chunk = parseSseDataLine(line)
        if (!chunk) continue
        if (chunk.type === 'data-turn-complete') sawTurnComplete = true
        const events = mapPodChunkToA2AEvents(chunk, mapperState, ctx, { includeReasoning })
        for (const event of events) bus.publish(event)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
  return { sawTurnComplete }
}

export class ShogoAgentExecutor implements AgentExecutor {
  private readonly opts: ShogoAgentExecutorOptions
  /** Guards "one in-flight turn per contextId" — queuing a second
   * `/agent/chat` on the same `chatSessionId` would silently hang behind
   * the gateway's own `turnLocks`, with no way for the caller to tell. */
  private readonly inFlightContexts = new Set<string>()
  /** `taskId` → abort controller for the in-flight fetch, used by `cancelTask`. */
  private readonly abortControllers = new Map<string, AbortController>()

  constructor(opts: ShogoAgentExecutorOptions) {
    this.opts = opts
  }

  /**
   * True while any turn is executing for this project. Used by the
   * router's handler LRU as a proxy for "has a live event bus" —
   * `ExecutionEventBusManager` doesn't expose a way to enumerate its
   * buses, but an in-flight turn always has one, so evicting the
   * cached `DefaultRequestHandler` (and this executor with it) while
   * this is true would orphan a running turn and any `message/stream`
   * subscriber attached to it.
   */
  get hasActiveWork(): boolean {
    return this.inFlightContexts.size > 0
  }

  async execute(reqCtx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = reqCtx

    if (this.inFlightContexts.has(contextId)) {
      // Thrown before publishing anything — `DefaultRequestHandler`
      // synthesizes the required Task + statusUpdate(FAILED) lifecycle
      // and maps this to A2A_ERROR_CODE.TASK_NOT_CANCELABLE (-32002) on
      // the wire. Not a perfect semantic fit (this is a "not startable"
      // rather than "not cancelable" rejection), but it's the closest
      // existing A2A error class to "a turn is already running on this
      // context" without inventing a custom JSON-RPC code.
      throw new JsonRpcTaskNotCancelableError({
        message:
          'A turn is already in progress for this contextId. Concurrent sends on the same context queue ' +
          "silently in the runtime pod; wait for the in-flight task to reach a terminal or interrupted state " +
          'before sending another message.',
      })
    }

    this.inFlightContexts.add(contextId)
    const abortController = new AbortController()
    this.abortControllers.set(taskId, abortController)

    try {
      await this.runTurn(reqCtx, bus, abortController)
    } finally {
      this.inFlightContexts.delete(contextId)
      this.abortControllers.delete(taskId)
    }
  }

  private async runTurn(
    reqCtx: RequestContext,
    bus: ExecutionEventBus,
    abortController: AbortController,
  ): Promise<void> {
    const { taskId, contextId } = reqCtx
    const { projectId, workspaceId } = this.opts
    const chatSessionId = deriveChatSessionId(projectId, contextId)
    const mapperCtx = { taskId, contextId }
    const includeReasoning = reqCtx.context.requestedExtensions?.includes(A2A_REASONING_EXTENSION_URI) ?? false

    bus.publish(AgentEvent.task(emptyTask(taskId, contextId, TaskState.TASK_STATE_SUBMITTED, { chatSessionId })))
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: nowIso() },
        metadata: undefined,
      }),
    )

    const userMessage = reqCtx.userMessage
    const rejectReason = hasRejectedFilePart(userMessage)
    if (rejectReason) {
      this.publishFailure(bus, mapperCtx, rejectReason)
      return
    }
    const userText = extractText(userMessage)
    if (!userText.trim()) {
      this.publishFailure(bus, mapperCtx, 'The message must contain at least one text part.')
      return
    }

    await ensureChatSession(projectId, chatSessionId)

    let podUrl: string
    let runtimeToken: string
    try {
      const pod = await resolveProjectPodUrl(projectId, {
        logTag: 'A2A',
        metalWaitMs: parseInt(process.env.A2A_METAL_WAIT_MS || '90000', 10),
        metalRetryDelayMs: 1000,
      })
      podUrl = pod.url
      runtimeToken = await deriveProjectRuntimeToken(projectId, { workspaceId })
    } catch (err: any) {
      this.publishFailure(bus, mapperCtx, `Failed to reach the project's agent runtime: ${err?.message ?? err}`)
      return
    }

    const requestBody = {
      messages: [{ role: 'user', parts: [{ type: 'text', text: userText }] }],
      chatSessionId,
      // Never omit — the pod's own default matches this today, but a
      // future default change must not silently move A2A into 'plan'
      // mode, whose tool set is a read-only allowlist expecting a
      // `confirmedPlan` the caller has no way to supply.
      interactionMode: 'agent' as const,
    }

    let res: Response
    try {
      res = await fetch(`${podUrl}/agent/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runtime-token': runtimeToken,
          'X-Chat-Session-Id': chatSessionId,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      })
    } catch (err: any) {
      if (abortController.signal.aborted) return // cancelTask already published CANCELED
      this.publishFailure(bus, mapperCtx, `Agent runtime request failed: ${err?.message ?? err}`)
      return
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      this.publishFailure(bus, mapperCtx, `Agent runtime returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
      return
    }

    const [mapperStream, billingStream] = res.body.tee()
    const mapperState = createEventMapperState()

    const billingPromise = trackUsageFromStream(
      billingStream,
      requestBody,
      { id: projectId, workspaceId },
      {
        chatSessionId,
        resume: async (fromSeq: number) => {
          try {
            return await fetch(`${podUrl}/agent/chat/${encodeURIComponent(chatSessionId)}/stream?fromSeq=${fromSeq}`, {
              method: 'GET',
              headers: { 'x-runtime-token': runtimeToken },
            })
          } catch {
            return null
          }
        },
      },
    ).catch((err) => {
      console.error(`[A2A] trackUsageFromStream failed for project ${projectId}:`, err)
    })

    let sawTurnComplete: boolean
    try {
      ;({ sawTurnComplete } = await consumeAndPublish(mapperStream, mapperState, mapperCtx, bus, includeReasoning))
    } catch (err: any) {
      await billingPromise
      if (abortController.signal.aborted) return
      this.publishFailure(bus, mapperCtx, `Agent stream read failed: ${err?.message ?? err}`)
      return
    }

    // EOF without `data-turn-complete` is a normal occurrence, not an edge
    // case: the Knative activator cuts pod-facing HTTP at ~5 minutes while
    // the agent keeps running in the pod's buffer. Resume with
    // `fromSeq = mapperState.lastSeq` (NOT 0/full-replay like
    // `trackUsageFromStream` uses for its own single-accumulator use
    // case) — `append: true` artifact updates PUSH a new Part onto the
    // task's artifact (see `ResultManager.applyArtifactUpdate` in
    // `@a2a-js/sdk`), so a full replay from 0 would duplicate every
    // already-published text chunk in the persisted Task and to any live
    // `message/stream` subscriber. The heartbeat lag documented in
    // `project-chat.ts` means a handful of frames may still be
    // re-delivered at the seam; that's an accepted, documented tradeoff.
    if (!sawTurnComplete && !abortController.signal.aborted) {
      let resumeRes: Response | null = null
      try {
        resumeRes = await fetch(
          `${podUrl}/agent/chat/${encodeURIComponent(chatSessionId)}/stream?fromSeq=${mapperState.lastSeq}`,
          { method: 'GET', headers: { 'x-runtime-token': runtimeToken } },
        )
      } catch (err: any) {
        console.warn(`[A2A] Resume fetch failed for ${projectId}/${chatSessionId}:`, err?.message ?? err)
      }

      if (resumeRes && resumeRes.status === 200 && resumeRes.body) {
        try {
          ;({ sawTurnComplete } = await consumeAndPublish(resumeRes.body, mapperState, mapperCtx, bus, includeReasoning))
        } catch (err: any) {
          sawTurnComplete = false
          console.warn(`[A2A] Resume stream read failed for ${projectId}/${chatSessionId}:`, err?.message ?? err)
        }
      } else if (resumeRes && resumeRes.status === 204) {
        // Buffer is gone — stop, expiry, or pod restart. Terminal FAILED.
        this.publishFailure(
          bus,
          mapperCtx,
          "Connection to the agent was interrupted and the turn's buffer has since expired " +
            '(stop, pod restart, or crash). Any work completed before the interruption may still be persisted.',
        )
        await billingPromise
        return
      }
    }

    await billingPromise

    if (!sawTurnComplete) {
      this.publishFailure(bus, mapperCtx, 'The agent stream ended unexpectedly without completing the turn.')
    }
  }

  private publishFailure(bus: ExecutionEventBus, ctx: { taskId: string; contextId: string }, text: string): void {
    bus.publish(
      AgentEvent.statusUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: TaskState.TASK_STATE_FAILED,
          message: {
            messageId: crypto.randomUUID(),
            contextId: ctx.contextId,
            taskId: ctx.taskId,
            role: Role.ROLE_AGENT,
            parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: nowIso(),
        },
        metadata: undefined,
      }),
    )
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.abortControllers.get(taskId)?.abort()

    const context = new ServerCallContext({ tenant: this.opts.projectId })
    const task = await this.opts.taskStore.load(taskId, context)
    const contextId = task?.contextId ?? ''
    const chatSessionId = (task?.metadata as Record<string, unknown> | undefined)?.chatSessionId

    if (typeof chatSessionId === 'string') {
      try {
        const pod = await resolveProjectPodUrl(this.opts.projectId, { logTag: 'A2A' })
        const runtimeToken = await deriveProjectRuntimeToken(this.opts.projectId, {
          workspaceId: this.opts.workspaceId,
        })
        await fetch(`${pod.url}/agent/stop`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-runtime-token': runtimeToken,
            'X-Chat-Session-Id': chatSessionId,
          },
          body: JSON.stringify({ chatSessionId }),
        })
      } catch (err: any) {
        console.warn(`[A2A] /agent/stop failed for task ${taskId}:`, err?.message ?? err)
      }
    }

    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: nowIso() },
        metadata: undefined,
      }),
    )
  }
}
