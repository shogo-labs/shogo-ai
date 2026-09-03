// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Maps the agent-runtime pod's AI SDK `UIMessageChunk` SSE stream (see
 * `packages/agent-runtime/src/server.ts`'s `createUIMessageStream`) onto
 * A2A `AgentExecutionEvent`s.
 *
 * This has no equivalent in Odin — `alignment-project-server` doesn't
 * stream (`capabilities.streaming=False`); this is shogo's actual
 * departure from the reference implementation.
 *
 * Mapping (see the plan's "Event mapping" section for the full table):
 *   - `text-start` / `text-delta` / `text-end` → `artifactUpdate` on a
 *     single `response` artifact, `append: true` throughout,
 *     `lastChunk: true` only on `text-end`.
 *   - `tool-input-available` → `statusUpdate(WORKING)` with a `DataPart`
 *     of `{ toolCallId, toolName, input }`.
 *   - `tool-output-available` → `statusUpdate(WORKING)` with
 *     `{ toolCallId, output }`.
 *   - `tool-output-error` → `statusUpdate(WORKING)` with error data.
 *   - `reasoning-*` → `statusUpdate(WORKING)` with `metadata.kind =
 *     'reasoning'`, gated behind `opts.includeReasoning` (an opt-in card
 *     extension in the executor) so reasoning isn't leaked by default.
 *   - `data-usage` → accumulated into `state.usage`; merged into the
 *     final status's `metadata` by the caller (not emitted as its own
 *     event).
 *   - `data-turn-seq` → no A2A event (persisted to `A2aTask.lastSeq` by
 *     the executor directly, for resume diagnostics).
 *   - `error` → `statusUpdate(FAILED, final: true)`.
 *   - `data-turn-complete` → `statusUpdate(COMPLETED | CANCELED | FAILED,
 *     final: true)` based on `status` — UNLESS the turn's last
 *     unanswered tool call was `ask_user`, in which case it maps to
 *     `INPUT_REQUIRED` instead (see below).
 *
 * Two interactive cases the first draft of this plan missed:
 *
 *   - **`ask_user` → `TASK_STATE_INPUT_REQUIRED`.** The tool deliberately
 *     suppresses `tool-output-available` and ends the turn
 *     (`gateway.ts`'s `onAfterToolCall`), so `state.askUserPending` is
 *     set on `tool-input-available` and only cleared by a matching
 *     `tool-output-available` (defensive; ask_user never sends one).
 *     When `data-turn-complete` arrives with it still set, we override
 *     the terminal state to `INPUT_REQUIRED` with the question(s) as the
 *     status message, regardless of what `data.status` said — an
 *     unanswered `ask_user` is never actually "completed".
 *
 *   - **`data-permission-request` → `TASK_STATE_AUTH_REQUIRED`.** Only
 *     ever emitted when `SHOGO_LOCAL_MODE=true` with a non-default
 *     `strict`/`balanced` security policy (`PermissionEngine` doesn't
 *     exist on cloud pods). The underlying `requestApproval()` call
 *     blocks the pod's tool execution — and therefore the whole
 *     `/agent/chat` HTTP response — for up to 30s before auto-denying,
 *     so this is a TRANSIENT status update, not a terminal one: we
 *     surface it immediately (rather than silently eating the stall)
 *     and keep consuming the same stream, which resumes on its own
 *     once the pod's timeout or an operator's out-of-band response
 *     fires `handleApprovalResponse`. There is intentionally no v1 path
 *     for an A2A client to answer this itself — see the module's
 *     "Known limitations" note in the plan.
 */

import { Role, TaskState, type Message, type Part } from '@a2a-js/sdk'
import { AgentEvent, type AgentExecutionEvent } from '@a2a-js/sdk/server'

/** Artifact id/name every text chunk of a turn's response is appended to. */
const RESPONSE_ARTIFACT_ID = 'response'

export interface EventMapperContext {
  taskId: string
  contextId: string
}

export interface EventMapperOptions {
  /** Surface `reasoning-*` chunks as WORKING updates. Default false. */
  includeReasoning?: boolean
}

export interface UsageSnapshot {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
}

export interface AskUserPending {
  toolCallId: string
  questions: Array<{ header: string; question: string }>
}

/** Per-turn accumulator threaded through every `mapPodChunkToA2AEvents` call. */
export interface EventMapperState {
  askUserPending?: AskUserPending
  usage?: UsageSnapshot
  /** Highest `data-turn-seq` observed — for the executor's resume bookkeeping. */
  lastSeq: number
}

export function createEventMapperState(): EventMapperState {
  return { lastSeq: 0 }
}

function textPart(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }
}

function dataPart(value: unknown): Part {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' }
}

function agentMessage(ctx: EventMapperContext, parts: Part[]): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: ctx.contextId,
    taskId: ctx.taskId,
    role: Role.ROLE_AGENT,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function statusUpdate(
  ctx: EventMapperContext,
  state: TaskState,
  opts: { message?: Message; metadata?: Record<string, unknown> } = {},
): AgentExecutionEvent {
  return AgentEvent.statusUpdate({
    taskId: ctx.taskId,
    contextId: ctx.contextId,
    status: {
      state,
      message: opts.message,
      timestamp: new Date().toISOString(),
    },
    metadata: opts.metadata,
  })
}

function workingWithData(ctx: EventMapperContext, value: unknown): AgentExecutionEvent {
  return statusUpdate(ctx, TaskState.TASK_STATE_WORKING, {
    message: agentMessage(ctx, [dataPart(value)]),
  })
}

/**
 * Process one already-JSON-parsed pod SSE chunk. Returns zero or more
 * `AgentExecutionEvent`s to publish, in order. Mutates `state` in place
 * (mirrors the pattern in `evals/runner.ts` / `project-chat.ts`).
 */
export function mapPodChunkToA2AEvents(
  chunk: any,
  state: EventMapperState,
  ctx: EventMapperContext,
  opts: EventMapperOptions = {},
): AgentExecutionEvent[] {
  if (!chunk || typeof chunk !== 'object') return []
  const type = chunk.type

  switch (type) {
    case 'text-delta': {
      const delta = chunk.delta ?? ''
      if (!delta) return []
      return [
        AgentEvent.artifactUpdate({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          artifact: {
            artifactId: RESPONSE_ARTIFACT_ID,
            name: RESPONSE_ARTIFACT_ID,
            description: '',
            parts: [textPart(delta)],
            metadata: undefined,
            extensions: [],
          },
          append: true,
          lastChunk: false,
          metadata: undefined,
        }),
      ]
    }

    case 'text-end': {
      // Deliberately no event here. `append: true` artifact updates PUSH a
      // new `Part` onto `artifact.parts` (see `ResultManager.applyArtifactUpdate`
      // in `@a2a-js/sdk` — it's an array push, not a string concat), so an
      // empty trailing part would just be dead weight in the persisted
      // task. `lastChunk` on the terminal `data-turn-complete` status
      // update is the actual "this task is done" signal; a listener
      // wanting "this text run is done" can infer it from the next
      // WORKING update (tool call) or the terminal state.
      return []
    }

    case 'tool-input-available': {
      const toolCallId = chunk.toolCallId ?? ''
      const toolName = chunk.toolName ?? 'unknown'
      if (toolName === 'ask_user') {
        const questions: Array<{ header: string; question: string }> =
          Array.isArray(chunk.input?.questions)
            ? chunk.input.questions.map((q: any) => ({
                header: String(q?.header ?? ''),
                question: String(q?.question ?? ''),
              }))
            : []
        state.askUserPending = { toolCallId, questions }
      }
      return [workingWithData(ctx, { toolCallId, toolName, input: chunk.input })]
    }

    case 'tool-output-available': {
      const toolCallId = chunk.toolCallId ?? ''
      if (state.askUserPending?.toolCallId === toolCallId) state.askUserPending = undefined
      return [workingWithData(ctx, { toolCallId, output: chunk.output })]
    }

    case 'tool-output-error': {
      const toolCallId = chunk.toolCallId ?? ''
      if (state.askUserPending?.toolCallId === toolCallId) state.askUserPending = undefined
      return [workingWithData(ctx, { toolCallId, error: chunk.errorText ?? chunk.error ?? 'tool error' })]
    }

    case 'reasoning-start':
    case 'reasoning-delta':
    case 'reasoning-end': {
      if (!opts.includeReasoning) return []
      const text = type === 'reasoning-delta' ? String(chunk.delta ?? '') : ''
      return [
        statusUpdate(ctx, TaskState.TASK_STATE_WORKING, {
          message: agentMessage(ctx, [textPart(text)]),
          metadata: { kind: 'reasoning', phase: type },
        }),
      ]
    }

    case 'data-usage': {
      const u = chunk.data ?? chunk
      state.usage = {
        inputTokens: u.inputTokens ?? u.promptTokens ?? state.usage?.inputTokens,
        outputTokens: u.outputTokens ?? u.completionTokens ?? state.usage?.outputTokens,
        cacheReadTokens: u.cacheReadTokens ?? state.usage?.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens ?? state.usage?.cacheWriteTokens,
        totalTokens: u.totalTokens ?? state.usage?.totalTokens,
      }
      return []
    }

    case 'data-turn-seq': {
      const seq = chunk.data?.seq
      if (typeof seq === 'number' && seq > state.lastSeq) state.lastSeq = seq
      return []
    }

    case 'data-permission-request': {
      return [
        statusUpdate(ctx, TaskState.TASK_STATE_AUTH_REQUIRED, {
          message: agentMessage(ctx, [dataPart(chunk.data ?? {})]),
          metadata: { transient: true, reason: 'permission-request' },
        }),
      ]
    }

    case 'error': {
      const text = chunk.errorText ?? chunk.message ?? chunk.error ?? 'Unknown error'
      return [
        statusUpdate(ctx, TaskState.TASK_STATE_FAILED, {
          message: agentMessage(ctx, [textPart(String(text))]),
        }),
      ]
    }

    case 'data-turn-complete': {
      const status = chunk.data?.status
      if (state.askUserPending) {
        const questionText = state.askUserPending.questions
          .map((q) => `${q.header}: ${q.question}`)
          .join('\n')
        return [
          statusUpdate(ctx, TaskState.TASK_STATE_INPUT_REQUIRED, {
            message: agentMessage(ctx, [textPart(questionText || 'The agent is waiting for your input.')]),
          }),
        ]
      }
      const finalState =
        status === 'aborted'
          ? TaskState.TASK_STATE_CANCELED
          : status === 'failed'
            ? TaskState.TASK_STATE_FAILED
            : TaskState.TASK_STATE_COMPLETED
      return [statusUpdate(ctx, finalState, { metadata: state.usage ? { usage: state.usage } : undefined })]
    }

    default:
      return []
  }
}
