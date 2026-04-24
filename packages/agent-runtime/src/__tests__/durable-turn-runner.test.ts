// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for DurableTurnRunner (Phase 8).
 *
 * We inject a fake `runAgentLoop` via the `_runLoopForTests` hook so these
 * tests run offline — no provider mocking, no pi-agent-core wiring.
 */

import { describe, test, expect } from 'bun:test'
import {
  runDurableTurn,
  classifyAttempt,
  type TurnCheckpoint,
  type DurableTurnRunnerOptions,
} from '../durable-turn-runner'
import type { AgentLoopOptions, AgentLoopResult } from '../agent-loop'
import { ToolIdempotencyRegistry } from '../tool-idempotency'

function makeResult(partial: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    text: '',
    toolCalls: [],
    iterations: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    newMessages: [],
    maxIterationsExhausted: false,
    ...partial,
  }
}

function baseOptions(
  scripted: AgentLoopResult[],
  extra: Partial<DurableTurnRunnerOptions> = {},
): DurableTurnRunnerOptions {
  const fake = async (_opts: AgentLoopOptions) => {
    const next = scripted.shift()
    if (!next) throw new Error('Test bug: ran out of scripted loop results')
    return next
  }
  return {
    model: 'claude-sonnet-4-5',
    system: 'Test system',
    history: [],
    prompt: 'Start',
    tools: [],
    _runLoopForTests: fake,
    ...extra,
  }
}

describe('runDurableTurn', () => {
  test('completes a single attempt when the loop naturally finishes', async () => {
    const opts = baseOptions([
      makeResult({ text: 'done', outputTokens: 10, lastStopReason: 'end_turn' }),
    ])
    const checkpoints: TurnCheckpoint[] = []

    const res = await runDurableTurn({ ...opts, onCheckpoint: cp => checkpoints.push(cp) })

    expect(res.terminationReason).toBe('completed')
    expect(res.attempts).toHaveLength(1)
    expect(res.text).toBe('done')
    expect(res.error).toBeUndefined()
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]?.reason).toBe('attempt_end')
    expect(checkpoints[0]?.willContinue).toBe(false)
  })

  test('auto-continues on max_tokens (lastStopReason=length)', async () => {
    const scripted: AgentLoopResult[] = [
      makeResult({
        text: 'part A',
        outputTokens: 100,
        maxIterationsExhausted: true,
        lastStopReason: 'length',
      }),
      makeResult({
        text: 'part B',
        outputTokens: 50,
        lastStopReason: 'end_turn',
      }),
    ]
    const opts = baseOptions(scripted, { maxContinuations: 5 })
    const checkpoints: TurnCheckpoint[] = []

    const res = await runDurableTurn({ ...opts, onCheckpoint: cp => checkpoints.push(cp) })

    expect(res.terminationReason).toBe('completed')
    expect(res.attempts).toHaveLength(2)
    expect(res.text).toBe('part A\n\npart B')
    expect(res.outputTokens).toBe(150)
    expect(checkpoints.map(c => c.reason)).toEqual([
      'continuation_max_tokens',
      'attempt_end',
    ])
    expect(checkpoints[0]?.willContinue).toBe(true)
  })

  test('auto-continues on iteration_limit (maxIterationsExhausted, no length)', async () => {
    const scripted: AgentLoopResult[] = [
      makeResult({
        text: 'step1',
        iterations: 10,
        outputTokens: 30,
        maxIterationsExhausted: true,
        error: new Error('Reached maximum iteration limit'),
        toolCalls: [{ name: 'read_file', input: {}, output: {} } as any],
      }),
      makeResult({
        text: 'step2-final',
        outputTokens: 20,
        lastStopReason: 'end_turn',
      }),
    ]
    const opts = baseOptions(scripted)
    const checkpoints: TurnCheckpoint[] = []

    const res = await runDurableTurn({ ...opts, onCheckpoint: cp => checkpoints.push(cp) })

    expect(res.terminationReason).toBe('completed')
    expect(res.attempts).toHaveLength(2)
    expect(checkpoints[0]?.reason).toBe('continuation_iteration_limit')
  })

  test('retries a transient provider error (no tool calls, no output)', async () => {
    const scripted: AgentLoopResult[] = [
      makeResult({ error: new Error('ECONNRESET transient'), outputTokens: 0 }),
      makeResult({ text: 'ok', outputTokens: 5, lastStopReason: 'end_turn' }),
    ]
    const opts = baseOptions(scripted, { providerRetriesPerAttempt: 2 })

    const res = await runDurableTurn(opts)

    expect(res.terminationReason).toBe('completed')
    expect(res.text).toBe('ok')
    // First attemptResult was an internal provider retry so `.attempts` sees
    // the surviving final attempt only (provider retries do not push).
    expect(res.attempts).toHaveLength(1)
  })

  test('surfaces non-recoverable billing errors as provider_fatal', async () => {
    const scripted: AgentLoopResult[] = [
      makeResult({
        error: new Error('HTTP 401: unauthorized - billing disabled'),
        outputTokens: 0,
      }),
    ]
    const opts = baseOptions(scripted, { providerRetriesPerAttempt: 2 })
    const checkpoints: TurnCheckpoint[] = []

    const res = await runDurableTurn({ ...opts, onCheckpoint: cp => checkpoints.push(cp) })

    expect(res.terminationReason).toBe('provider_fatal')
    expect(res.error?.message).toMatch(/unauthorized|billing|401/i)
    expect(checkpoints[0]?.reason).toMatch(/^terminal_/)
  })

  test('respects maxContinuations budget and stops with max_continuations', async () => {
    const scripted: AgentLoopResult[] = Array.from({ length: 10 }, () =>
      makeResult({
        text: 'chunk',
        outputTokens: 5,
        maxIterationsExhausted: true,
        lastStopReason: 'length',
      }),
    )
    const opts = baseOptions(scripted, { maxContinuations: 2 })

    const res = await runDurableTurn(opts)

    expect(res.terminationReason).toBe('max_continuations')
    // 1 initial + 2 continuations = 3 attempts
    expect(res.attempts).toHaveLength(3)
  })

  test('short-circuits when signal is aborted before next attempt', async () => {
    const ac = new AbortController()
    const scripted: AgentLoopResult[] = [
      makeResult({
        text: 'partial',
        outputTokens: 10,
        maxIterationsExhausted: true,
        lastStopReason: 'length',
      }),
      makeResult({ text: 'should not be reached', outputTokens: 1 }),
    ]
    const opts = baseOptions(scripted, {
      maxContinuations: 5,
      signal: ac.signal,
      prepareNextHistory: async () => {
        ac.abort()
        return null
      },
    })

    const res = await runDurableTurn(opts)

    // prepareNextHistory returning null is "host_cancelled"; aborting the
    // signal inside it is belt-and-suspenders — either outcome proves we
    // did NOT run the second attempt.
    expect(['host_cancelled', 'user_abort']).toContain(res.terminationReason)
    expect(res.attempts).toHaveLength(1)
  })

  test('triggers the no-silent-EOF gate on empty completion', async () => {
    const scripted: AgentLoopResult[] = [
      makeResult({ text: '', outputTokens: 0, toolCalls: [], lastStopReason: 'end_turn' }),
    ]
    const opts = baseOptions(scripted)
    const checkpoints: TurnCheckpoint[] = []

    const res = await runDurableTurn({ ...opts, onCheckpoint: cp => checkpoints.push(cp) })

    expect(res.terminationReason).toBe('provider_fatal')
    expect(res.error?.message).toMatch(/without emitting any output/)
    expect(checkpoints.find(c => c.reason === 'terminal_silent_empty')).toBeDefined()
  })

  test('uses default continuation prompt that references resume intent', async () => {
    const scripted: AgentLoopResult[] = [
      makeResult({
        text: 'first',
        outputTokens: 10,
        maxIterationsExhausted: true,
        lastStopReason: 'length',
      }),
      makeResult({ text: 'second', outputTokens: 5, lastStopReason: 'end_turn' }),
    ]
    const captured: AgentLoopOptions[] = []
    const res = await runDurableTurn({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Original user prompt',
      tools: [],
      _runLoopForTests: async (o) => {
        captured.push(o)
        const next = scripted.shift()
        if (!next) throw new Error('no more')
        return next
      },
    })

    expect(res.terminationReason).toBe('completed')
    expect(captured).toHaveLength(2)
    expect(captured[0]?.prompt).toBe('Original user prompt')
    // Continuation prompt must be non-empty, DIFFERENT from the original,
    // and should mention resuming.
    expect(captured[1]?.prompt).not.toBe(captured[0]?.prompt)
    expect(captured[1]?.prompt?.toLowerCase()).toMatch(/resume|continue|pick/i)
  })

  test('aborts with host_cancelled when prepareNextHistory throws (f5)', async () => {
    const scripted: AgentLoopResult[] = [
      makeResult({
        text: 'part1',
        outputTokens: 10,
        maxIterationsExhausted: true,
        lastStopReason: 'length',
      }),
      makeResult({ text: 'should not reach', outputTokens: 1 }),
    ]
    const checkpoints: TurnCheckpoint[] = []
    const opts = baseOptions(scripted, {
      prepareNextHistory: async () => {
        throw new Error('session store unreachable')
      },
    })

    const res = await runDurableTurn({ ...opts, onCheckpoint: cp => checkpoints.push(cp) })

    expect(res.terminationReason).toBe('host_cancelled')
    expect(res.attempts).toHaveLength(1)
    expect(checkpoints.find(c => c.reason === 'terminal_history_sync_failed')).toBeDefined()
  })

  test('refuses provider retry when registry has unfinished mutating tool (f1)', async () => {
    const registry = new ToolIdempotencyRegistry()
    registry.start('call-write-1', 'write_file', { path: '/tmp/a' }, { readOnly: false, mutating: true })
    // Not finished on purpose — this simulates a mid-stream failure right
    // after a mutating tool started but before its result streamed back.

    const scripted: AgentLoopResult[] = [
      makeResult({ error: new Error('ECONNRESET during mutation'), outputTokens: 0 }),
    ]
    const opts = baseOptions(scripted, {
      providerRetriesPerAttempt: 5,
      toolRegistry: registry,
    })

    const res = await runDurableTurn(opts)

    // With an unfinished mutating tool, the retry is refused and the
    // outer classifier surfaces the error as provider_fatal.
    expect(res.terminationReason).toBe('provider_fatal')
    expect(res.attempts).toHaveLength(1)
  })

  test('still retries provider error when only READ-ONLY tools are unfinished (f1)', async () => {
    const registry = new ToolIdempotencyRegistry()
    registry.start('call-read-1', 'read_file', { path: '/tmp/a' }, { readOnly: true, mutating: false })
    // read_file is classified read-only, so replaying is safe.

    const scripted: AgentLoopResult[] = [
      makeResult({ error: new Error('ECONNRESET transient'), outputTokens: 0 }),
      makeResult({ text: 'finished', outputTokens: 5, lastStopReason: 'end_turn' }),
    ]
    const opts = baseOptions(scripted, {
      providerRetriesPerAttempt: 2,
      toolRegistry: registry,
    })

    const res = await runDurableTurn(opts)

    expect(res.terminationReason).toBe('completed')
    expect(res.text).toBe('finished')
  })
})

describe('classifyAttempt', () => {
  test('flags loopBreak as terminal loop_detected', () => {
    const r = makeResult({ loopBreak: { reason: 'repetition' } as any })
    const c = classifyAttempt(r)
    expect(c.fatal).toBe(true)
    expect(c.fatalLabel).toBe('loop_detected')
  })

  test('length stop => max_tokens continuation', () => {
    const r = makeResult({
      maxIterationsExhausted: true,
      lastStopReason: 'length',
    })
    const c = classifyAttempt(r)
    expect(c.fatal).toBe(false)
    expect(c.reason).toBe('max_tokens')
  })

  test('billing error is terminal even without maxIterationsExhausted', () => {
    const r = makeResult({ error: new Error('billing disabled: insufficient credits') })
    const c = classifyAttempt(r)
    expect(c.fatal).toBe(true)
    expect(c.fatalLabel).toBe('billing_or_auth')
  })

  test('context overflow is terminal with a dedicated label', () => {
    const r = makeResult({ error: new Error('Prompt is too long — context overflow') })
    const c = classifyAttempt(r)
    expect(c.fatal).toBe(true)
    expect(c.fatalLabel).toBe('context_overflow')
  })
})

describe('ToolIdempotencyRegistry', () => {
  test('tracks lifecycle: plan → start → completed', () => {
    const reg = new ToolIdempotencyRegistry()
    reg.plan('call-1', 'read_file')
    expect(reg.get('call-1')?.state).toBe('planned')

    reg.start('call-1', 'read_file', { path: '/tmp/x' })
    expect(reg.get('call-1')?.state).toBe('started')
    expect(reg.get('call-1')?.args).toEqual({ path: '/tmp/x' })

    reg.finish('call-1', { ok: true }, false)
    expect(reg.get('call-1')?.state).toBe('completed')
    expect(reg.isCompleted('call-1')).toBe(true)
  })

  test('lists started-but-unfinished mutating tools (danger zone)', () => {
    const reg = new ToolIdempotencyRegistry()
    reg.start('c1', 'write_file', { path: '/a' })
    reg.start('c2', 'read_file', { path: '/b' })
    reg.finish('c2', 'ok', false)
    reg.start('c3', 'exec', { cmd: 'rm -rf /' })
    reg.finish('c3', 'done', false)
    reg.start('c4', 'edit_file', { path: '/c' })

    const unfinished = reg.listStartedButUnfinished()
    expect(unfinished.map(u => u.toolCallId).sort()).toEqual(['c1', 'c4'])
    const muts = unfinished.filter(r => r.cls.mutating)
    expect(muts).toHaveLength(2)
  })

  test('classifies unknown tools as mutating by default', () => {
    const reg = new ToolIdempotencyRegistry()
    const rec = reg.plan('c1', 'some_unknown_custom_tool')
    expect(rec.cls.mutating).toBe(true)
    expect(rec.cls.readOnly).toBe(false)
  })

  test('classifies mcp_*_read tools as read-only', () => {
    const reg = new ToolIdempotencyRegistry()
    const rec = reg.plan('c1', 'mcp_github_read')
    expect(rec.cls.readOnly).toBe(true)
    expect(rec.cls.mutating).toBe(false)
  })

  test('reset() clears all state and resets the attempt counter', () => {
    const reg = new ToolIdempotencyRegistry()
    reg.beginAttempt(5)
    reg.start('c1', 'exec', {})
    expect(reg.snapshot()).toHaveLength(1)

    reg.reset()
    expect(reg.snapshot()).toHaveLength(0)
    const rec = reg.plan('c2', 'exec')
    // reset() should have rewound attempt → 1
    expect(rec.attempt).toBe(1)
  })
})
