// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/lib/a2a/event-mapper.ts — pure functions, no mocking
// required. Covers every pod chunk type, the ask_user -> INPUT_REQUIRED
// override, and the data-permission-request -> AUTH_REQUIRED transient
// status update.

import { describe, expect, it } from 'bun:test'
import { TaskState } from '@a2a-js/sdk'
import type { TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { createEventMapperState, mapPodChunkToA2AEvents, type EventMapperState } from '../event-mapper'

const ctx = { taskId: 'task-1', contextId: 'ctx-1' }

function freshState(): EventMapperState {
  return createEventMapperState()
}

describe('createEventMapperState', () => {
  it('starts with lastSeq 0 and no usage/askUserPending', () => {
    const state = freshState()
    expect(state.lastSeq).toBe(0)
    expect(state.usage).toBeUndefined()
    expect(state.askUserPending).toBeUndefined()
  })
})

describe('mapPodChunkToA2AEvents — malformed input', () => {
  it('returns [] for null', () => {
    expect(mapPodChunkToA2AEvents(null, freshState(), ctx)).toEqual([])
  })
  it('returns [] for a non-object', () => {
    expect(mapPodChunkToA2AEvents('oops', freshState(), ctx)).toEqual([])
  })
  it('returns [] for an unknown chunk type', () => {
    expect(mapPodChunkToA2AEvents({ type: 'something-unhandled' }, freshState(), ctx)).toEqual([])
  })
})

describe('text-delta / text-end', () => {
  it('text-delta emits one artifactUpdate with append:true, lastChunk:false', () => {
    const events = mapPodChunkToA2AEvents({ type: 'text-delta', delta: 'Hello' }, freshState(), ctx)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('artifactUpdate')
    const data = events[0].data as TaskArtifactUpdateEvent
    expect(data.taskId).toBe('task-1')
    expect(data.contextId).toBe('ctx-1')
    expect(data.append).toBe(true)
    expect(data.lastChunk).toBe(false)
    expect(data.artifact?.artifactId).toBe('response')
    expect(data.artifact?.parts[0]).toMatchObject({ content: { $case: 'text', value: 'Hello' } })
  })

  it('text-delta with an empty delta emits nothing', () => {
    expect(mapPodChunkToA2AEvents({ type: 'text-delta', delta: '' }, freshState(), ctx)).toEqual([])
  })

  it('text-end emits nothing (lastChunk comes from the terminal status instead)', () => {
    expect(mapPodChunkToA2AEvents({ type: 'text-end' }, freshState(), ctx)).toEqual([])
  })
})

describe('tool-input-available / tool-output-available / tool-output-error', () => {
  it('non-ask_user tool call emits a WORKING statusUpdate carrying a DataPart', () => {
    const events = mapPodChunkToA2AEvents(
      { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'a.ts' } },
      freshState(),
      ctx,
    )
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('statusUpdate')
    const data = events[0].data as TaskStatusUpdateEvent
    expect(data.status?.state).toBe(TaskState.TASK_STATE_WORKING)
    const part = data.status?.message?.parts[0]
    expect(part?.content).toMatchObject({
      $case: 'data',
      value: { toolCallId: 'call-1', toolName: 'read_file', input: { path: 'a.ts' } },
    })
  })

  it('ask_user tool call sets state.askUserPending with parsed questions', () => {
    const state = freshState()
    mapPodChunkToA2AEvents(
      {
        type: 'tool-input-available',
        toolCallId: 'call-ask',
        toolName: 'ask_user',
        input: { questions: [{ header: 'Name', question: 'What is your name?' }] },
      },
      state,
      ctx,
    )
    expect(state.askUserPending).toEqual({
      toolCallId: 'call-ask',
      questions: [{ header: 'Name', question: 'What is your name?' }],
    })
  })

  it('ask_user with malformed/missing questions still sets askUserPending with an empty list', () => {
    const state = freshState()
    mapPodChunkToA2AEvents({ type: 'tool-input-available', toolCallId: 'call-ask', toolName: 'ask_user' }, state, ctx)
    expect(state.askUserPending).toEqual({ toolCallId: 'call-ask', questions: [] })
  })

  it('tool-output-available for the pending ask_user toolCallId clears askUserPending', () => {
    const state = freshState()
    state.askUserPending = { toolCallId: 'call-1', questions: [] }
    mapPodChunkToA2AEvents({ type: 'tool-output-available', toolCallId: 'call-1', output: 'ok' }, state, ctx)
    expect(state.askUserPending).toBeUndefined()
  })

  it('tool-output-available for a different toolCallId leaves askUserPending untouched', () => {
    const state = freshState()
    state.askUserPending = { toolCallId: 'call-1', questions: [] }
    mapPodChunkToA2AEvents({ type: 'tool-output-available', toolCallId: 'call-2', output: 'ok' }, state, ctx)
    expect(state.askUserPending).toEqual({ toolCallId: 'call-1', questions: [] })
  })

  it('tool-output-error emits WORKING with the error message and clears matching askUserPending', () => {
    const state = freshState()
    state.askUserPending = { toolCallId: 'call-1', questions: [] }
    const events = mapPodChunkToA2AEvents(
      { type: 'tool-output-error', toolCallId: 'call-1', errorText: 'boom' },
      state,
      ctx,
    )
    expect(state.askUserPending).toBeUndefined()
    const data = events[0].data as TaskStatusUpdateEvent
    expect(data.status?.message?.parts[0].content).toMatchObject({
      $case: 'data',
      value: { toolCallId: 'call-1', error: 'boom' },
    })
  })
})

describe('reasoning-*', () => {
  it('is suppressed by default (includeReasoning unset)', () => {
    expect(mapPodChunkToA2AEvents({ type: 'reasoning-delta', delta: 'thinking...' }, freshState(), ctx)).toEqual([])
  })

  it('is surfaced as a WORKING update with metadata.kind=reasoning when includeReasoning:true', () => {
    const events = mapPodChunkToA2AEvents(
      { type: 'reasoning-delta', delta: 'thinking...' },
      freshState(),
      ctx,
      { includeReasoning: true },
    )
    expect(events).toHaveLength(1)
    const data = events[0].data as TaskStatusUpdateEvent
    expect(data.status?.state).toBe(TaskState.TASK_STATE_WORKING)
    expect(data.metadata).toMatchObject({ kind: 'reasoning', phase: 'reasoning-delta' })
    expect(data.status?.message?.parts[0].content).toMatchObject({ $case: 'text', value: 'thinking...' })
  })
})

describe('data-usage', () => {
  it('accumulates fields across multiple chunks without emitting an event', () => {
    const state = freshState()
    expect(mapPodChunkToA2AEvents({ type: 'data-usage', data: { inputTokens: 10 } }, state, ctx)).toEqual([])
    expect(state.usage).toMatchObject({ inputTokens: 10 })
    mapPodChunkToA2AEvents({ type: 'data-usage', data: { outputTokens: 5 } }, state, ctx)
    // Previously recorded inputTokens must survive the second, partial update.
    expect(state.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('accepts the promptTokens/completionTokens aliases', () => {
    const state = freshState()
    mapPodChunkToA2AEvents({ type: 'data-usage', data: { promptTokens: 3, completionTokens: 7 } }, state, ctx)
    expect(state.usage).toMatchObject({ inputTokens: 3, outputTokens: 7 })
  })
})

describe('data-turn-seq', () => {
  it('only moves lastSeq forward, never backward', () => {
    const state = freshState()
    mapPodChunkToA2AEvents({ type: 'data-turn-seq', data: { seq: 5 } }, state, ctx)
    expect(state.lastSeq).toBe(5)
    mapPodChunkToA2AEvents({ type: 'data-turn-seq', data: { seq: 2 } }, state, ctx)
    expect(state.lastSeq).toBe(5)
    mapPodChunkToA2AEvents({ type: 'data-turn-seq', data: { seq: 9 } }, state, ctx)
    expect(state.lastSeq).toBe(9)
  })
  it('emits no event', () => {
    expect(mapPodChunkToA2AEvents({ type: 'data-turn-seq', data: { seq: 1 } }, freshState(), ctx)).toEqual([])
  })
})

describe('data-permission-request', () => {
  it('maps to a transient AUTH_REQUIRED statusUpdate', () => {
    const events = mapPodChunkToA2AEvents(
      { type: 'data-permission-request', data: { tool: 'run_command', command: 'rm -rf /' } },
      freshState(),
      ctx,
    )
    expect(events).toHaveLength(1)
    const data = events[0].data as TaskStatusUpdateEvent
    expect(data.status?.state).toBe(TaskState.TASK_STATE_AUTH_REQUIRED)
    expect(data.metadata).toMatchObject({ transient: true, reason: 'permission-request' })
  })
})

describe('error', () => {
  it('maps to a FAILED statusUpdate carrying the error text', () => {
    const events = mapPodChunkToA2AEvents({ type: 'error', errorText: 'pod crashed' }, freshState(), ctx)
    const data = events[0].data as TaskStatusUpdateEvent
    expect(data.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    expect(data.status?.message?.parts[0].content).toMatchObject({ $case: 'text', value: 'pod crashed' })
  })

  it('falls back to a generic message when no error text is present', () => {
    const events = mapPodChunkToA2AEvents({ type: 'error' }, freshState(), ctx)
    const data = events[0].data as TaskStatusUpdateEvent
    expect(data.status?.message?.parts[0].content).toMatchObject({ $case: 'text', value: 'Unknown error' })
  })
})

describe('data-turn-complete', () => {
  it('maps a normal completion to COMPLETED, merging accumulated usage into metadata', () => {
    const state = freshState()
    mapPodChunkToA2AEvents({ type: 'data-usage', data: { totalTokens: 42 } }, state, ctx)
    const events = mapPodChunkToA2AEvents({ type: 'data-turn-complete', data: { status: 'completed' } }, state, ctx)
    const data = events[0].data as TaskStatusUpdateEvent
    expect(data.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(data.metadata).toMatchObject({ usage: { totalTokens: 42 } })
  })

  it('maps status:"aborted" to CANCELED', () => {
    const events = mapPodChunkToA2AEvents({ type: 'data-turn-complete', data: { status: 'aborted' } }, freshState(), ctx)
    expect((events[0].data as TaskStatusUpdateEvent).status?.state).toBe(TaskState.TASK_STATE_CANCELED)
  })

  it('maps status:"failed" to FAILED', () => {
    const events = mapPodChunkToA2AEvents({ type: 'data-turn-complete', data: { status: 'failed' } }, freshState(), ctx)
    expect((events[0].data as TaskStatusUpdateEvent).status?.state).toBe(TaskState.TASK_STATE_FAILED)
  })

  it('overrides to INPUT_REQUIRED when an ask_user call is still pending, regardless of data.status', () => {
    const state = freshState()
    state.askUserPending = {
      toolCallId: 'call-1',
      questions: [{ header: 'Confirm', question: 'Proceed with deletion?' }],
    }
    const events = mapPodChunkToA2AEvents({ type: 'data-turn-complete', data: { status: 'completed' } }, state, ctx)
    expect(events).toHaveLength(1)
    const data = events[0].data as TaskStatusUpdateEvent
    expect(data.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    expect(data.status?.message?.parts[0].content).toMatchObject({
      $case: 'text',
      value: 'Confirm: Proceed with deletion?',
    })
  })

  it('uses a generic prompt when the pending ask_user call had no parsed questions', () => {
    const state = freshState()
    state.askUserPending = { toolCallId: 'call-1', questions: [] }
    const events = mapPodChunkToA2AEvents({ type: 'data-turn-complete', data: {} }, state, ctx)
    const data = events[0].data as TaskStatusUpdateEvent
    expect(data.status?.message?.parts[0].content).toMatchObject({
      $case: 'text',
      value: 'The agent is waiting for your input.',
    })
  })
})
