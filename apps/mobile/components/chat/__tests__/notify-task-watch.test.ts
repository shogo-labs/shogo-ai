// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-31 — an open chat window has to notice the wake turn a finished
 * background task produces.
 *
 * The wake is queued by the API, so the window only learns about it by
 * asking. These tests pin the two decisions that make that safe: the wait is
 * armed by background work this window can see (a listed notify task, or a
 * turn that started one), and it stops as soon as the wake's reply is in the
 * transcript instead of polling an idle chat forever.
 */

import { describe, expect, test } from 'bun:test'
import { lastTurnStartedBackgroundWork, watchForNotifyWake } from '../notify-task-watch'
import type { ChatTurnStatus } from '../probe-turn-status'

function harness(script: {
  tasks: Array<readonly string[] | null>
  turns?: ChatTurnStatus[]
  settledAfter?: number
  maxWaitMs?: number
  maxTicks?: number
}) {
  let clock = 0
  let tick = 0
  const calls: string[] = []
  const tasks = [...script.tasks]
  const turns = [...(script.turns ?? [])]
  let reloads = 0

  const run = watchForNotifyWake({
    probeTasks: async () => {
      calls.push('tasks')
      return tasks.length > 1 ? tasks.shift()! : tasks[0]
    },
    probeTurn: async () => {
      calls.push('turn')
      tick += 1
      return turns.shift() ?? 'unknown'
    },
    attach: () => {
      calls.push('attach')
    },
    reload: async () => {
      calls.push('reload')
      reloads += 1
    },
    isSettled: () => script.settledAfter !== undefined && reloads >= script.settledAfter,
    isCancelled: () => script.maxTicks !== undefined && calls.length >= script.maxTicks,
    sleep: async () => {
      clock += 1_000
    },
    now: () => clock,
    maxWaitMs: script.maxWaitMs ?? 60_000,
    intervalMs: 1_000,
  })

  return { run, calls }
}

describe('watchForNotifyWake', () => {
  test('does not probe the turn while a task is still listed', async () => {
    const { run, calls } = harness({ tasks: [['task-1']], maxWaitMs: 3_000, maxTicks: 3 })
    await run
    expect(calls.filter((call) => call === 'turn')).toHaveLength(0)
    expect(calls.filter((call) => call === 'tasks')).toHaveLength(3)
  })

  // QA round 1 (SHO-31): the cap used to apply to the whole loop, so a task
  // still running at 5:00 ended the watch and its wake was never fetched.
  test('keeps polling a task that is still listed past the wait window', async () => {
    const { run, calls } = harness({ tasks: [['task-1']], maxWaitMs: 5_000, maxTicks: 40 })
    await run
    expect(calls.filter((call) => call === 'tasks')).toHaveLength(40)
    expect(calls.filter((call) => call === 'turn')).toHaveLength(0)
  })

  test('starts the wait clock only once the list comes back empty', async () => {
    // Five polls with a task listed (t = 0…4 s), then empty. The 5 s wait must
    // begin there, not at t = 0, or the watch would already be one second from
    // giving up when the task finishes.
    const { run, calls } = harness({
      tasks: [['task-1'], ['task-1'], ['task-1'], ['task-1'], ['task-1'], []],
      turns: ['completed'],
      maxWaitMs: 5_000,
      maxTicks: 40,
    })
    await run
    const tasksCalls = calls.filter((call) => call === 'tasks').length
    // 5 listed + 6 empty-phase polls (t = 5…10 s) before the wake window ends.
    expect(tasksCalls).toBe(11)
    expect(tasksCalls).toBeLessThan(40)
    expect(calls.filter((call) => call === 'turn')).toHaveLength(6)
  })

  test('resets the wait when a new task starts while waiting', async () => {
    const { run, calls } = harness({
      tasks: [[], [], ['task-2'], [], []],
      turns: ['unknown'],
      maxWaitMs: 3_000,
      maxTicks: 40,
    })
    await run
    const turnCalls = calls.filter((call) => call === 'turn').length
    // Empty at t=0,1 then listed at t=2 (clock resets), then empty t=3,4,5,6.
    expect(turnCalls).toBe(6)
  })

  test('attaches as soon as the wake turn is live', async () => {
    const { run, calls } = harness({ tasks: [[]], turns: ['unknown', 'unknown', 'active'] })
    await run
    expect(calls).toContain('attach')
    expect(calls.filter((call) => call === 'reload')).toHaveLength(2)
  })

  test('repaints history and stops once the wake reply is saved', async () => {
    const { run, calls } = harness({ tasks: [[]], turns: ['completed'], settledAfter: 1 })
    await run
    expect(calls).toContain('reload')
    expect(calls.filter((call) => call === 'reload')).toHaveLength(1)
    expect(calls).not.toContain('attach')
  })

  test('keeps waiting when the task list cannot be read', async () => {
    const { run, calls } = harness({ tasks: [null], maxWaitMs: 3_000, maxTicks: 4 })
    await run
    expect(calls).not.toContain('turn')
    expect(calls.filter((call) => call === 'tasks')).toHaveLength(4)
  })

  test('gives up after the wait window instead of polling forever', async () => {
    const { run, calls } = harness({ tasks: [[]], turns: ['unknown'], maxWaitMs: 5_000 })
    await run
    expect(calls.filter((call) => call === 'turn')).toHaveLength(6)
  })
})

describe('lastTurnStartedBackgroundWork', () => {
  const assistant = (parts: any[]) => ({ id: 'a1', role: 'assistant', parts })
  const user = { id: 'u1', role: 'user', content: 'start the build', parts: [{ type: 'text', text: 'start the build' }] }

  test('a backgrounded exec arms the wake watch', () => {
    const messages = [
      user,
      assistant([
        {
          type: 'tool-invocation',
          toolInvocation: { toolName: 'exec', args: { command: 'sleep 5', background: true }, state: 'result' },
        },
      ]),
    ]
    expect(lastTurnStartedBackgroundWork(messages)).toBe(true)
  })

  test('a command that outlived its timeout counts too', () => {
    const messages = [
      user,
      assistant([
        {
          type: 'dynamic-tool',
          toolName: 'exec',
          state: 'output-available',
          input: { command: 'bun test' },
          output: { status: 'running', task_id: 't_1' },
        },
      ]),
    ]
    expect(lastTurnStartedBackgroundWork(messages)).toBe(true)
  })

  test('persisted parts stored as JSON text are parsed', () => {
    const messages = [
      user,
      {
        id: 'a1',
        role: 'assistant',
        parts: JSON.stringify([
          { type: 'tool-invocation', toolInvocation: { toolName: 'exec', args: { command: 'make', background: true } } },
        ]),
      },
    ]
    expect(lastTurnStartedBackgroundWork(messages)).toBe(true)
  })

  test('a foreground exec does not', () => {
    const messages = [
      user,
      assistant([
        {
          type: 'tool-invocation',
          toolInvocation: { toolName: 'exec', args: { command: 'ls' }, result: { stdout: '' } },
        },
      ]),
    ]
    expect(lastTurnStartedBackgroundWork(messages)).toBe(false)
  })

  test('an answered wake reply that started nothing does not', () => {
    const messages = [
      user,
      { id: 'u2', role: 'user', content: '[Task update] build (t_1) completed.' },
      assistant([{ type: 'text', text: 'wake-ack: the build finished' }]),
    ]
    expect(lastTurnStartedBackgroundWork(messages)).toBe(false)
  })

  test('no assistant turn yet', () => {
    expect(lastTurnStartedBackgroundWork([user])).toBe(false)
    expect(lastTurnStartedBackgroundWork([])).toBe(false)
  })
})
