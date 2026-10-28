// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction (SHO-235): the no-progress breaker counted *tool calls*, so one
 * model turn that fired five calls in parallel filled the window by itself and
 * the turn was killed before the model saw a single error. It also treated
 * ordinary shell exits as failures — `| head` closing the pipe (141) and `grep`
 * finding nothing (1) both looked like thrash.
 *
 * These tests pin the fixed behaviour: no-progress is counted per turn (a turn
 * is unproductive only when every call in it failed) and only real failures
 * count.
 */
import { describe, test, expect } from 'bun:test'
import { LoopDetector } from '../loop-detector'

/**
 * The no-progress stop is off by default (round 2). These tests opt into
 * round 1's threshold so the turn-counting path keeps its coverage.
 */
const OPT_IN = { maxConsecutiveNoProgress: 5 }

/** Five turns, one call each, all with the same output shape. */
function tripsAfterFiveTurns(output: any): boolean {
  const d = new LoopDetector(OPT_IN)
  let last
  for (let i = 0; i < 5; i++) {
    d.recordAndCheck('exec', { command: `attempt ${i}` }, output)
    last = d.recordTurnEnd()
  }
  return last?.loopDetected === true
}

describe('LoopDetector — no-progress counts turns, not calls', () => {
  test('five failing calls in ONE turn do not stop it; four more failing turns do', () => {
    const d = new LoopDetector(OPT_IN)

    // One mistake the model has not even been told about yet: five parallel
    // calls that all fail validation.
    for (let i = 0; i < 5; i++) {
      const check = d.recordAndCheck(
        'work_item_update',
        { key: `SHO-${i}` },
        { error: `invalid argument 'key' — expected 'item'` },
      )
      expect(check.loopDetected).toBe(false)
    }
    expect(d.recordTurnEnd().loopDetected).toBe(false)

    // Four further turns where the model got the error and failed anyway: the
    // fifth unproductive turn is the stop.
    for (let turn = 2; turn <= 4; turn++) {
      d.recordAndCheck('work_item_update', { item: 'SHO-235', bogus: turn }, { error: 'unknown field' })
      expect(d.recordTurnEnd().loopDetected).toBe(false)
    }
    d.recordAndCheck('work_item_update', { item: 'SHO-235', bogus: 5 }, { error: 'unknown field' })
    const fifth = d.recordTurnEnd()

    expect(fifth.loopDetected).toBe(true)
    expect(fifth.reason).toBe('no_progress')
    expect(fifth.pattern).toBe(
      '5 turns in a row where every tool call failed — stop and ask for help instead of retrying',
    )
  })

  test('a turn with one success among four failures resets the streak', () => {
    const d = new LoopDetector(OPT_IN)

    for (let turn = 0; turn < 4; turn++) {
      d.recordAndCheck('exec', { command: `curl http://metrics.internal/${turn}` }, { exitCode: 7, stderr: 'Could not resolve host' })
      expect(d.recordTurnEnd().loopDetected).toBe(false)
    }

    // The fifth turn: four failures and one real result — progress.
    for (let i = 0; i < 4; i++) {
      d.recordAndCheck('exec', { command: `curl http://metrics.internal/x${i}` }, { exitCode: 7, stderr: 'Could not resolve host' })
    }
    d.recordAndCheck('read_file', { path: 'AGENTS.md' }, { content: '# Agents' })
    expect(d.recordTurnEnd().loopDetected).toBe(false)

    // The counter started over: four more failing turns are still tolerated.
    for (let turn = 0; turn < 4; turn++) {
      d.recordAndCheck('exec', { command: `curl http://metrics.internal/y${turn}` }, { exitCode: 7, stderr: 'Could not resolve host' })
      expect(d.recordTurnEnd().loopDetected).toBe(false)
    }
  })

  test('a turn that made no tool calls neither counts nor resets', () => {
    const d = new LoopDetector(OPT_IN)

    for (let turn = 0; turn < 3; turn++) {
      d.recordAndCheck('exec', { command: `curl http://metrics.internal/${turn}` }, { exitCode: 7, stderr: 'Could not resolve host' })
      d.recordTurnEnd()
    }
    expect(d.recordTurnEnd().loopDetected).toBe(false)
    expect(d.recordTurnEnd().loopDetected).toBe(false)

    for (let turn = 0; turn < 2; turn++) {
      d.recordAndCheck('exec', { command: `curl http://metrics.internal/z${turn}` }, { exitCode: 7, stderr: 'Could not resolve host' })
      const check = d.recordTurnEnd()
      expect(check.loopDetected).toBe(turn === 1)
    }
  })
})

describe('LoopDetector — ordinary shell exits are progress, not thrash', () => {
  test('SIGPIPE from `| head`, grep data and grep no-match are productive', () => {
    // `awk … | grep … | head -120`: head closes the pipe, the writer sees 141.
    expect(tripsAfterFiveTurns({ exitCode: 141, stdout: 'line 1\nline 2\nline 3' })).toBe(false)
    expect(tripsAfterFiveTurns({ exitCode: 141, stdout: 'x', stderr: '' })).toBe(false)
    // `grep` that found lines.
    expect(tripsAfterFiveTurns({ exitCode: 1, stdout: 'a\nb' })).toBe(false)
    // `grep`/`rg`/`test`/`diff` with no match and no complaint.
    expect(tripsAfterFiveTurns({ exitCode: 1, stdout: '', stderr: '' })).toBe(false)
  })

  test('real failures are still unproductive', () => {
    expect(tripsAfterFiveTurns({ exitCode: 2, stdout: '', stderr: 'sed: illegal option -- 3' })).toBe(true)
    expect(tripsAfterFiveTurns({ exitCode: 127, stdout: '', stderr: 'sh: foo: command not found' })).toBe(true)
    expect(tripsAfterFiveTurns({ exitCode: 7, stdout: '', stderr: 'Could not resolve host' })).toBe(true)
  })

  test('a timed-out or killed call is a failure even when it printed data', () => {
    expect(tripsAfterFiveTurns({ exitCode: 0, stdout: 'partial', timedOut: true })).toBe(true)
    expect(tripsAfterFiveTurns({ exitCode: 1, stdout: 'x', timedOut: true })).toBe(true)
    expect(tripsAfterFiveTurns({ exitCode: 0, stdout: 'partial', killed: true })).toBe(true)
  })
})

describe('LoopDetector — replays of the stopped turns', () => {
  test('session 38c77ea0: grep + sed + three `| head` runs, one call per turn, no stop', () => {
    const d = new LoopDetector(OPT_IN)

    // The ten calls the workspace agent made, in order.
    const calls: Array<{ name: string; input: Record<string, any>; output: any }> = [
      { name: 'exec', input: { command: 'rg -n "loop" packages/agent' }, output: { exitCode: 0, stdout: 'packages/agent/src/loop-detector.ts:1: loop' } },
      { name: 'exec', input: { command: 'sed -n 1,40p loop-detector.ts' }, output: { exitCode: 0, stdout: '// SPDX…' } },
      { name: 'exec', input: { command: 'grep -n "no_progress" packages/agent/src/*.ts' }, output: { exitCode: 1, stdout: 'packages/agent/src/loop-detector.ts:150: no_progress', stderr: '' } },
      { name: 'exec', input: { command: 'git log --oneline -3' }, output: { exitCode: 0, stdout: '7cef371f6 fix\n21ce81915 chore' } },
      { name: 'exec', input: { command: 'awk "/turn_end/" agent-loop.ts | head -20' }, output: { exitCode: 141, stdout: 'case \'turn_end\': {\n…' } },
      { name: 'exec', input: { command: 'sed -3 -n 700,760p agent-loop.ts' }, output: { exitCode: 1, stdout: '', stderr: 'sed: illegal option -- 3' } },
      { name: 'exec', input: { command: 'awk "/tool_execution_end/" agent-loop.ts | head -120' }, output: { exitCode: 141, stdout: 'x'.repeat(8000) } },
      { name: 'exec', input: { command: 'awk "/recordAndCheck/" agent-loop.ts | head -120' }, output: { exitCode: 141, stdout: 'y'.repeat(8000) } },
      { name: 'exec', input: { command: 'awk "/loopDetector/" agent-loop.ts | head -120' }, output: { exitCode: 141, stdout: 'z'.repeat(8000) } },
      { name: 'exec', input: { command: 'ls packages/agent/src' }, output: { exitCode: 0, stdout: 'agent-loop.ts\nloop-detector.ts' } },
    ]

    let last
    for (const c of calls) {
      d.recordAndCheck(c.name, c.input, c.output)
      last = d.recordTurnEnd()
      expect(last.loopDetected).toBe(false)
    }
    expect(last?.loopDetected).toBe(false)
  })

  test('#content batch: five parallel calls that all fail validation do not stop the turn', () => {
    const d = new LoopDetector(OPT_IN)

    // work_item_update ×2, work_item_comment ×2, work_item_bulk_update — every
    // one used `key` instead of `item`.
    const batch = [
      ['work_item_update', { key: 'SHO-231', fields: { pr: '…' } }],
      ['work_item_update', { key: 'SHO-231', fields: { auto_merge: true } }],
      ['work_item_comment', { key: 'SHO-231', text: 'merged' }],
      ['work_item_comment', { key: 'SHO-231', text: '+1' }],
      ['work_item_bulk_update', { keys: ['SHO-231'], column: 'Done' }],
    ] as const

    for (const [name, input] of batch) {
      const check = d.recordAndCheck(name, input as any, {
        error: "missing required argument 'item'",
      })
      expect(check.loopDetected).toBe(false)
    }
    expect(d.recordTurnEnd().loopDetected).toBe(false)

    // The model is told, fixes it, and the next turn succeeds.
    d.recordAndCheck('work_item_update', { item: 'SHO-231', fields: { pr: '…' } }, { ok: true })
    expect(d.recordTurnEnd().loopDetected).toBe(false)
  })
})

describe('LoopDetector — the no-progress stop is OFF by default (round 2)', () => {
  test('20 fully failed turns never trip it with the default config', () => {
    const d = new LoopDetector()

    // Varied inputs and varied failures, so identical_calls / identical_outputs /
    // cycle cannot fire either: only a no-progress heuristic could stop this.
    for (let turn = 0; turn < 20; turn++) {
      d.recordAndCheck(
        'exec',
        { command: `curl http://metrics.internal:${9000 + turn}/api/signups` },
        { exitCode: 7, stdout: '', stderr: `Could not resolve host (attempt ${turn})` },
      )
      const check = d.recordTurnEnd()
      expect(check.loopDetected).toBe(false)
    }
  })

  test('0 and Infinity both mean off, and 0 does not trip on the first failed turn', () => {
    for (const maxConsecutiveNoProgress of [0, Infinity]) {
      const d = new LoopDetector({ maxConsecutiveNoProgress })

      // The bug the guard prevents: `slice(-0)` is the whole array, so a naive
      // threshold of 0 would report a loop on the very first closed turn.
      d.recordAndCheck('exec', { command: 'curl http://x' }, { exitCode: 7, stderr: 'Could not resolve host' })
      expect(d.recordTurnEnd().loopDetected).toBe(false)

      for (let turn = 1; turn < 8; turn++) {
        d.recordAndCheck('exec', { command: `curl http://x/${turn}` }, { exitCode: 7, stderr: 'Could not resolve host' })
        expect(d.recordTurnEnd().loopDetected).toBe(false)
      }
    }
  })

  test('opting in with 5 is the only way to get the stop back', () => {
    const d = new LoopDetector({ maxConsecutiveNoProgress: 5 })
    let last
    for (let turn = 0; turn < 5; turn++) {
      d.recordAndCheck('exec', { command: `curl http://x/${turn}` }, { exitCode: 7, stderr: 'Could not resolve host' })
      last = d.recordTurnEnd()
    }
    expect(last?.loopDetected).toBe(true)
    expect(last?.reason).toBe('no_progress')
  })
})

describe('LoopDetector — per-call detectors are unchanged', () => {
  test('identical_calls still fires at 10 inside one turn', () => {
    const d = new LoopDetector()
    let last
    for (let i = 0; i < 10; i++) {
      last = d.recordAndCheck('exec', { command: 'curl http://x' }, { exitCode: 0, stdout: 'ok' })
    }
    expect(last?.loopDetected).toBe(true)
    expect(last?.reason).toBe('identical_calls')
  })

  test('SHO-223 with the default config: 12 identical blank calls stop at 10 via identical_calls', () => {
    // The empty-argument model used to be stopped at 5 by the no-progress
    // breaker. That is off now, so the identical-call detector is what ends it —
    // and it ends it at 10, not 12.
    const d = new LoopDetector()
    const guardError = { error: "read_file: required argument 'path' was empty" }

    let last
    let fired = 0
    for (let turn = 0; turn < 12; turn++) {
      last = d.recordAndCheck('read_file', { path: '' }, guardError)
      const turnEnd = d.recordTurnEnd()
      expect(turnEnd.loopDetected).toBe(false) // no_progress is off
      if (last.loopDetected) {
        fired = turn + 1
        break
      }
    }

    expect(fired).toBe(10)
    expect(last?.reason).toBe('identical_calls')
    expect(last?.pattern).toBe('read_file called 10 times with identical input')
  })

  test('the cycle detector still fires at the window size', () => {
    const d = new LoopDetector({ cycleWindowSize: 6, minCycleLength: 2 })
    const steps: Array<[string, Record<string, any>, any]> = [
      ['read_file', { path: 'x' }, 'a'],
      ['write_file', { path: 'x', content: 'b' }, 'ok'],
      ['read_file', { path: 'x' }, 'a'],
      ['write_file', { path: 'x', content: 'b' }, 'ok'],
      ['read_file', { path: 'x' }, 'a'],
    ]
    for (const [name, input, output] of steps) d.recordAndCheck(name, input, output)
    const last = d.recordAndCheck('write_file', { path: 'x', content: 'b' }, 'ok')

    expect(last.loopDetected).toBe(true)
    expect(last.reason).toBe('cycle')
  })

  test('reset clears the turn window as well as the call history', () => {
    const d = new LoopDetector(OPT_IN)
    for (let turn = 0; turn < 4; turn++) {
      d.recordAndCheck('exec', { command: `curl http://x/${turn}` }, { exitCode: 7, stderr: 'Could not resolve host' })
      d.recordTurnEnd()
    }
    d.reset()

    d.recordAndCheck('exec', { command: 'curl http://x/after' }, { exitCode: 7, stderr: 'Could not resolve host' })
    expect(d.recordTurnEnd().loopDetected).toBe(false)
    expect(d.callCount).toBe(1)
  })
})
