// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A `sleep` used to check on a background task cannot see the finish early and
 * always spends the whole delay, so the runtime steers it to `wait` — but only
 * when the sleep is plainly tied to that task. Most real sleeps wait on CI, a
 * port, a rebuild or a retry, which `wait` cannot see (Russell's sample: ~12% of
 * 2,484 sleeps were task polls), so those must run untouched.
 */

import { describe, test, expect } from 'bun:test'
import { findPolledTasks, type RunningTaskRef } from '../exec-poll'

const serve: RunningTaskRef = {
  id: 't_serve',
  command: 'bun run dev > /tmp/serve.log 2>&1',
  outputFile: '.shogo/tasks/chat-1/t_serve.log',
}

const other: RunningTaskRef = {
  id: 't_build',
  command: 'bun run build',
  outputFile: '.shogo/tasks/chat-1/t_build.log',
}

describe('findPolledTasks — a sleep that reads a running task', () => {
  test('a sleep in front of the file the task redirects to is a poll', () => {
    expect(findPolledTasks('sleep 30 && tail /tmp/serve.log', [serve, other])).toEqual({
      ids: ['t_serve'],
      reason: 'reads_task_output',
    })
    expect(findPolledTasks('sleep 30 && tail -20 ./serve.log', [{ ...serve, command: 'bun run dev > ./serve.log' }])?.ids).toEqual([
      't_serve',
    ])
  })

  test("a sleep in front of the task's own output file is a poll", () => {
    expect(findPolledTasks('sleep 20; cat .shogo/tasks/chat-1/t_serve.log', [serve, other])?.ids).toEqual(['t_serve'])
    expect(findPolledTasks('sleep 20; tail -5 .shogo/tasks/chat-1/t_build.log', [serve, other])?.ids).toEqual(['t_build'])
  })

  test('an absolute path to the same output file matches too', () => {
    const poll = 'sleep 10 && cat /Users/someone/ws/.shogo/tasks/chat-1/t_serve.log'
    expect(findPolledTasks(poll, [serve])?.ids).toEqual(['t_serve'])
  })

  test('only the tasks it reads are named, not every running task', () => {
    const poll = 'sleep 10 && tail /tmp/serve.log'
    expect(findPolledTasks(poll, [serve, other])?.ids).toEqual(['t_serve'])
  })
})

describe('findPolledTasks — a sleep that only waits', () => {
  test('a bare sleep waits on whatever is running', () => {
    expect(findPolledTasks('sleep 30', [serve, other])).toEqual({ ids: ['t_serve', 't_build'], reason: 'bare_wait' })
    expect(findPolledTasks('sleep 15; echo waited', [other])).toEqual({ ids: ['t_build'], reason: 'bare_wait' })
    expect(findPolledTasks('sleep 0.5', [other])?.reason).toBe('bare_wait')
  })
})

describe('findPolledTasks — sleeps that are not a task poll', () => {
  test('CI, a port, a rebuild, a retry or a kill-then-verify is left alone', () => {
    expect(findPolledTasks('sleep 75; gh pr checks 1633', [serve, other])).toBeNull()
    expect(findPolledTasks('sleep 2 && curl -s localhost:3000', [serve, other])).toBeNull()
    expect(findPolledTasks('sleep 2 && tail .shogo/logs/build.log', [serve, other])).toBeNull()
    expect(findPolledTasks('until curl -sf localhost:3000; do sleep 1; done', [serve, other])).toBeNull()
    expect(findPolledTasks('kill 1234; sleep 1; ps aux | rg vite', [serve, other])).toBeNull()
    expect(findPolledTasks('sleep 5 && netstat -tlnp | rg 3000', [serve, other])).toBeNull()
  })

  test('a task id alone, with no output path, is not enough', () => {
    expect(findPolledTasks('sleep 10 && rg t_serve logs/', [serve, other])).toBeNull()
  })

  test('a sleep in front of task_list is still the poll it started from', () => {
    expect(findPolledTasks('sleep 15 && task_list', [serve, other])).toEqual({
      ids: ['t_serve', 't_build'],
      reason: 'bare_wait',
    })
  })

  test('with nothing running a sleep is never a poll', () => {
    expect(findPolledTasks('sleep 30 && cat .shogo/tasks/chat-1/t_serve.log', [])).toBeNull()
    expect(findPolledTasks('sleep 30', [])).toBeNull()
  })

  test('a project script or a build is not a poll', () => {
    expect(findPolledTasks('bun test', [serve])).toBeNull()
    expect(findPolledTasks('bun run typecheck', [serve])).toBeNull()
    expect(findPolledTasks('./scripts/run.sh', [serve])).toBeNull()
    expect(findPolledTasks('rg -n "sleep" src', [serve])).toBeNull()
  })

  test('a sleep that belongs to a backgrounded job is not the agent waiting', () => {
    expect(findPolledTasks('nohup sleep 30 > /dev/null 2>&1 &', [serve])).toBeNull()
  })
})
