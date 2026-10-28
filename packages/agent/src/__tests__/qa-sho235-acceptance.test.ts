// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-235.
 *
 * The dev's unit tests pin the detector in isolation; these drive the real
 * `runAgentLoop` with the two turns that were actually killed on 2026-10-27, so
 * the fix is proven where Russell saw it — a healthy turn that used to die with
 * "5 consecutive tool calls failed with no progress".
 *
 * Acceptance criteria covered:
 *   1  five parallel failing calls in one turn carry on; five failing *turns* stop
 *   3  the classifier table (141 / grep-1 / sed-2 / 127 / timed-out)
 *   4  replays of session 38c77ea0 and the #content batch
 *   5  genuine thrash still stops
 *   6  identical_calls still fires at 10, per call, inside one turn
 */
import { describe, test, expect } from 'bun:test'
import type { AgentTool, StreamFn } from '@mariozechner/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from '@mariozechner/pi-ai'
import { runAgentLoop } from '../agent-loop'
import { LoopDetector } from '../loop-detector'

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function fakeModel(): Model<Api> {
  return {
    id: 'fake', name: 'fake', api: 'openai-completions', provider: 'openai',
    baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000, maxTokens: 100,
  } as Model<Api>
}

type Step =
  | { calls: Array<{ name: string; arguments: Record<string, any> }> }
  | { text: string }

/** Plays the scripted turns back in order, whatever the loop asks for. */
function scriptedStream(steps: Step[]): StreamFn {
  let turn = 0
  return ((_model: Model<Api>) => {
    const stream = createAssistantMessageEventStream()
    const step = steps[Math.min(turn++, steps.length - 1)]
    queueMicrotask(() => {
      if ('text' in step) {
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: step.text }],
          api: 'openai-completions', provider: 'openai', model: 'fake',
          usage, stopReason: 'stop', timestamp: 0,
        } as AssistantMessage
        stream.push({ type: 'start', partial: message } as AssistantMessageEvent)
        stream.push({ type: 'done', reason: 'stop', message } as AssistantMessageEvent)
        return
      }
      const content = step.calls.map((c, i) => ({
        type: 'toolCall' as const,
        id: `call_${turn}_${i}`,
        name: c.name,
        arguments: c.arguments,
      }))
      const message = {
        role: 'assistant', content,
        api: 'openai-completions', provider: 'openai', model: 'fake',
        usage, stopReason: 'toolUse', timestamp: 0,
      } as AssistantMessage
      stream.push({ type: 'start', partial: message } as AssistantMessageEvent)
      content.forEach((toolCall, contentIndex) => {
        stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: message } as AssistantMessageEvent)
      })
      stream.push({ type: 'done', reason: 'toolUse', message } as AssistantMessageEvent)
    })
    return stream
  }) as StreamFn
}

/** An `exec` tool that answers with the next scripted output, in call order. */
function scriptedExec(outputs: any[]): { tool: AgentTool; seen: any[] } {
  const seen: any[] = []
  const tool: AgentTool = {
    name: 'exec',
    description: 'Run a shell command',
    label: 'exec',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    } as any,
    execute: async (_id: string, params: any) => {
      const output = outputs[Math.min(seen.length, outputs.length - 1)]
      seen.push({ params, output })
      const isError = output?.error != null
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        details: output,
        ...(isError ? { isError: true } : {}),
      } as any
    },
  }
  return { tool, seen }
}

function run(streamFn: StreamFn, tool: AgentTool) {
  return runAgentLoop({
    model: 'claude-sonnet-4-5',
    system: 'test',
    history: [],
    prompt: 'go',
    tools: [tool],
    streamFn,
    maxIterations: 30,
  })
}

/**
 * Classifier probe: with a window of one turn, `recordTurnEnd` reports
 * `no_progress` exactly when that single call was judged unproductive.
 * `recordTurnEnd` only runs the no-progress check, so the identical-call and
 * cycle detectors cannot colour the answer.
 */
function classifiedAsFailure(output: any): boolean {
  const d = new LoopDetector({ maxConsecutiveNoProgress: 1 })
  d.recordAndCheck('exec', { command: 'the command' }, output)
  return d.recordTurnEnd().loopDetected === true
}

describe('SHO-235 AC 4 — the turns that were actually killed', () => {
  test('session 38c77ea0: grep + one bad sed + three `| head` runs finish the turn', async () => {
    // One call per turn, exactly as the workspace agent made them: four clean
    // exits, a grep that found lines (exit 1), a sed usage error (exit 1 with
    // stderr), and three `awk | head` runs whose 141 is SIGPIPE, not failure.
    const outputs = [
      { exitCode: 0, stdout: 'packages/agent/src/loop-detector.ts' },
      { exitCode: 0, stdout: '// SPDX-License-Identifier: MIT' },
      { exitCode: 1, stdout: 'loop-detector.ts:150: no_progress', stderr: '' },
      { exitCode: 0, stdout: '21ce81915 chore: release 2.4.1' },
      { exitCode: 141, stdout: 'case \'turn_end\': {' },
      { exitCode: 1, stdout: '', stderr: 'sed: illegal option -- 3\nusage: sed' },
      { exitCode: 141, stdout: 'x'.repeat(8000) },
      { exitCode: 141, stdout: 'y'.repeat(8000) },
      { exitCode: 141, stdout: 'z'.repeat(8000) },
      { exitCode: 0, stdout: 'agent-loop.ts\nloop-detector.ts' },
    ]
    const { tool, seen } = scriptedExec(outputs)
    const result = await run(
      scriptedStream([
        ...outputs.map((_, i) => ({ calls: [{ name: 'exec', arguments: { command: `step ${i}` } }] })),
        { text: 'the loop detector counts turns now' },
      ]),
      tool,
    )

    expect(seen).toHaveLength(10)
    expect(result.loopBreak).toBeUndefined()
    expect(result.text).toBe('the loop detector counts turns now')
  })

  test('#content batch: five validation failures in one turn are one mistake', async () => {
    const invalid = { error: "missing required argument 'item'" }
    const { tool, seen } = scriptedExec([invalid, invalid, invalid, invalid, invalid, { exitCode: 0, stdout: 'ok' }])
    const result = await run(
      scriptedStream([
        {
          calls: ['update', 'update', 'comment', 'comment', 'bulk'].map((kind) => ({
            name: 'exec',
            arguments: { command: `work_item_${kind} --key SHO-231` },
          })),
        },
        { calls: [{ name: 'exec', arguments: { command: 'work_item_update --item SHO-231' } }] },
        { text: 'card moved' },
      ]),
      tool,
    )

    // All five errors reached the model; the sixth call succeeded.
    expect(seen).toHaveLength(6)
    expect(result.loopBreak).toBeUndefined()
    expect(result.text).toBe('card moved')
  })
})

describe('SHO-235 AC 1 — a batch is one retry, five failing turns are five', () => {
  test('five parallel failures carry on, then four more failing turns stop at the fifth', async () => {
    const miss = { error: 'File not found' }
    const { tool, seen } = scriptedExec([miss, miss, miss, miss, miss, miss, miss, miss, miss, { text: 'never' } as any])
    const result = await run(
      scriptedStream([
        // Turn 1: five calls, one mistake the model has not seen yet.
        { calls: [0, 1, 2, 3, 4].map((i) => ({ name: 'exec', arguments: { command: `cat missing-${i}` } })) },
        // Turns 2-5: one failure each — four more, so the fifth turn is the stop.
        ...['a', 'b', 'c', 'd'].map((n) => ({ calls: [{ name: 'exec', arguments: { command: `cat ${n}` } }] })),
        { text: 'never reached' },
      ]),
      tool,
    )

    expect(seen).toHaveLength(9)
    expect(result.loopBreak?.reason).toBe('no_progress')
    expect(result.text).not.toBe('never reached')
  })
})

describe('SHO-235 AC 3 — the classifier table', () => {
  test('normal shell exits are progress', () => {
    // `awk … | head`: head closes the pipe, the writer reports SIGPIPE.
    expect(classifiedAsFailure({ exitCode: 141, stdout: 'eight kilobytes of log' })).toBe(false)
    // grep found lines.
    expect(classifiedAsFailure({ exitCode: 1, stdout: 'a\nb' })).toBe(false)
    // grep/rg/test/diff with no match and no complaint.
    expect(classifiedAsFailure({ exitCode: 1, stdout: '', stderr: '' })).toBe(false)
    // Nothing was said about stderr at all.
    expect(classifiedAsFailure({ exitCode: 1, stdout: '' })).toBe(false)
  })

  test('real failures are still failures', () => {
    expect(classifiedAsFailure({ exitCode: 2, stdout: '', stderr: 'sed: illegal option -- 3' })).toBe(true)
    expect(classifiedAsFailure({ exitCode: 127, stdout: '', stderr: 'sh: foo: command not found' })).toBe(true)
    expect(classifiedAsFailure({ exitCode: 7, stdout: '', stderr: 'Could not resolve host' })).toBe(true)
  })

  test('a timeout or a kill is a failure whatever it printed', () => {
    expect(classifiedAsFailure({ exitCode: 0, timedOut: true })).toBe(true)
    expect(classifiedAsFailure({ exitCode: 1, stdout: 'x', timedOut: true })).toBe(true)
    expect(classifiedAsFailure({ exitCode: 0, stdout: 'partial', killed: true })).toBe(true)
  })

  test('the rest of the classifier is untouched', () => {
    // Explicit success wins.
    expect(classifiedAsFailure({ exitCode: 0 })).toBe(false)
    expect(classifiedAsFailure({ ok: true })).toBe(false)
    // Explicit failure signals still fail.
    expect(classifiedAsFailure({ ok: false })).toBe(true)
    expect(classifiedAsFailure({ success: false })).toBe(true)
    expect(classifiedAsFailure({ status: 500, stdout: 'body' })).toBe(true)
    expect(classifiedAsFailure({ error: 'tool blew up' })).toBe(true)
    // Free text still gets the head-of-text scan.
    expect(classifiedAsFailure('Error: ENOENT no such file')).toBe(true)
    expect(classifiedAsFailure('4 files changed, 12 insertions(+)')).toBe(false)
  })
})

describe('SHO-235 AC 5 / AC 6 — what must not change', () => {
  test('AC 5: five turns of genuine thrash still stop', async () => {
    const unreachable = { exitCode: 7, stdout: '', stderr: 'curl: (7) Could not resolve host: metrics.internal' }
    const { tool, seen } = scriptedExec([unreachable, unreachable, unreachable, unreachable, unreachable])
    const result = await run(
      scriptedStream([
        ...['1', '2', '3', '4', '5'].map((n) => ({
          calls: [{ name: 'exec', arguments: { command: `curl http://metrics.internal/signups?p=${n}` } }],
        })),
        { text: 'never reached' },
      ]),
      tool,
    )

    expect(seen).toHaveLength(5)
    expect(result.loopBreak?.reason).toBe('no_progress')
    expect(result.loopBreak?.pattern).toBe(
      '5 turns in a row where every tool call failed — stop and ask for help instead of retrying',
    )
  })

  test('AC 6: identical_calls still fires at exactly 10, per call, inside one turn', () => {
    const d = new LoopDetector()
    for (let i = 0; i < 9; i++) {
      expect(d.recordAndCheck('exec', { command: 'curl http://x' }, { exitCode: 0, stdout: 'ok' }).loopDetected).toBe(false)
    }
    const tenth = d.recordAndCheck('exec', { command: 'curl http://x' }, { exitCode: 0, stdout: 'ok' })
    expect(tenth.loopDetected).toBe(true)
    expect(tenth.reason).toBe('identical_calls')
  })

  test('the no-progress check is no longer reachable from recordAndCheck alone', () => {
    // A consumer that records calls but never closes a turn gets the per-call
    // detectors only — this is what moved, and it must not silently come back.
    const d = new LoopDetector()
    for (let i = 0; i < 6; i++) {
      expect(d.recordAndCheck('exec', { command: `attempt ${i}` }, { exitCode: 7, stderr: 'Could not resolve host' }).loopDetected).toBe(false)
    }
  })
})
