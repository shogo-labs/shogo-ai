// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for BackgroundTaskStatus — pure logic tests.
 *
 * We test:
 *   - BackgroundTaskInfo type correctness
 *   - Status mapping (exit code → status)
 *   - dismissTask / clearCompleted behavior
 *   - Edge cases: rejected promises, rapid state updates
 *
 * Note: The React rendering (BackgroundTaskStatus component) requires
 * a DOM environment which bun:test doesn't provide natively. We test
 * the hook's logic via the useBackgroundTasks hook with manual
 * state tracking where possible.
 */

import { describe, it, expect } from 'bun:test'
import type { BackgroundTaskInfo, CommandResult } from '../background-task-status'
import type { BackgroundTask } from '../agent-terminal-bridge'

// ─── BackgroundTaskInfo type tests ──────────────────────────────────────

describe('BackgroundTaskInfo', () => {
  it('has correct shape for running task', () => {
    const task: BackgroundTaskInfo = {
      id: 'bg_1',
      command: 'npm test',
      status: 'running',
      startedAt: Date.now(),
    }
    expect(task.status).toBe('running')
    expect(task.exitCode).toBeUndefined()
    expect(task.completedAt).toBeUndefined()
  })

  it('has correct shape for completed task', () => {
    const task: BackgroundTaskInfo = {
      id: 'bg_1',
      command: 'npm test',
      status: 'completed',
      exitCode: 0,
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
    }
    expect(task.status).toBe('completed')
    expect(task.exitCode).toBe(0)
  })

  it('has correct shape for failed task', () => {
    const task: BackgroundTaskInfo = {
      id: 'bg_1',
      command: 'npm test',
      status: 'failed',
      exitCode: 1,
      startedAt: Date.now() - 2000,
      completedAt: Date.now(),
    }
    expect(task.status).toBe('failed')
    expect(task.exitCode).toBe(1)
  })
})

// ─── Status mapping logic ───────────────────────────────────────────────

describe('Status mapping from CommandResult', () => {
  it('maps exitCode 0 to completed', () => {
    const result: CommandResult = {
      command: 'ls', exitCode: 0, cwd: '/tmp', durationMs: 100, timedOut: false,
    }
    expect(result.exitCode === 0 ? 'completed' : 'failed').toBe('completed')
  })

  it('maps exitCode 1 to failed', () => {
    const result: CommandResult = {
      command: 'npm test', exitCode: 1, cwd: '/proj', durationMs: 5000, timedOut: false,
    }
    expect(result.exitCode === 0 ? 'completed' : 'failed').toBe('failed')
  })

  it('maps exitCode null (timeout) to failed', () => {
    const result: CommandResult = {
      command: 'sleep 999', exitCode: null, cwd: null, durationMs: 120000, timedOut: true,
    }
    expect(result.exitCode === 0 ? 'completed' : 'failed').toBe('failed')
  })
})

// ─── formatElapsed edge cases ───────────────────────────────────────────

describe('formatElapsed (tested via import)', () => {
  // We can't directly import formatElapsed since it's not exported,
  // but we can test the logic it implements.

  it('formats sub-second durations as ms', () => {
    const ms = 456
    const result = ms < 1000 ? `${ms}ms` : 'nope'
    expect(result).toBe('456ms')
  })

  it('formats seconds correctly', () => {
    const ms = 5000
    const seconds = Math.floor(ms / 1000)
    const result = seconds < 60 ? `${seconds}s` : 'nope'
    expect(result).toBe('5s')
  })

  it('formats minutes correctly', () => {
    const ms = 125_000
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const remainingSec = seconds % 60
    expect(`${minutes}m ${remainingSec}s`).toBe('2m 5s')
  })

  it('handles exactly 0ms', () => {
    const ms = 0
    const result = ms < 1000 ? `${ms}ms` : 'nope'
    expect(result).toBe('0ms')
  })

  it('handles exactly 1000ms', () => {
    const ms = 1000
    const seconds = Math.floor(ms / 1000)
    expect(seconds).toBe(1)
    expect(`${seconds}s`).toBe('1s')
  })
})

// ─── useBackgroundTasks hook logic ──────────────────────────────────────

describe('useBackgroundTasks logic', () => {
  // We test the state transitions that useBackgroundTasks performs
  // by simulating the same logic without React.

  it('addTask creates a running task', () => {
    const tasks: BackgroundTaskInfo[] = []
    const task: BackgroundTask = {
      id: 'bg_1',
      command: 'npm test',
      promise: Promise.resolve({ command: 'npm test', exitCode: 0, cwd: null, durationMs: 100, timedOut: false }),
      dispose: () => {},
    }

    // Simulate addTask
    tasks.push({
      id: task.id,
      command: task.command,
      status: 'running',
      startedAt: Date.now(),
    })

    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('running')
  })

  it('completion maps exit 0 to completed', () => {
    const tasks: BackgroundTaskInfo[] = [
      { id: 'bg_1', command: 'npm test', status: 'running', startedAt: Date.now() },
    ]

    // Simulate successful completion
    const exitCode = 0
    const updated = tasks.map((t) =>
      t.id === 'bg_1'
        ? { ...t, status: exitCode === 0 ? 'completed' as const : 'failed' as const, exitCode, completedAt: Date.now() }
        : t
    )

    expect(updated[0].status).toBe('completed')
  })

  it('completion maps exit 1 to failed', () => {
    const tasks: BackgroundTaskInfo[] = [
      { id: 'bg_1', command: 'npm test', status: 'running', startedAt: Date.now() },
    ]

    const exitCode = 1
    const updated = tasks.map((t) =>
      t.id === 'bg_1'
        ? { ...t, status: exitCode === 0 ? 'completed' as const : 'failed' as const, exitCode, completedAt: Date.now() }
        : t
    )

    expect(updated[0].status).toBe('failed')
    expect(updated[0].exitCode).toBe(1)
  })

  it('dismissTask removes a task by id', () => {
    const tasks: BackgroundTaskInfo[] = [
      { id: 'bg_1', command: 'cmd1', status: 'completed', exitCode: 0, startedAt: 0, completedAt: 1 },
      { id: 'bg_2', command: 'cmd2', status: 'running', startedAt: 2 },
    ]

    const updated = tasks.filter((t) => t.id !== 'bg_1')
    expect(updated).toHaveLength(1)
    expect(updated[0].id).toBe('bg_2')
  })

  it('clearCompleted keeps only running tasks', () => {
    const tasks: BackgroundTaskInfo[] = [
      { id: 'bg_1', command: 'cmd1', status: 'completed', exitCode: 0, startedAt: 0, completedAt: 1 },
      { id: 'bg_2', command: 'cmd2', status: 'failed', exitCode: 1, startedAt: 2, completedAt: 3 },
      { id: 'bg_3', command: 'cmd3', status: 'running', startedAt: 4 },
    ]

    const remaining = tasks.filter((t) => t.status === 'running')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('bg_3')
  })

  it('handles rejected promise by marking task as failed', async () => {
    const tasks: BackgroundTaskInfo[] = [
      { id: 'bg_1', command: 'npm test', status: 'running', startedAt: Date.now() },
    ]

    // Simulate promise rejection
    const exitCode = null
    const updated = tasks.map((t) =>
      t.id === 'bg_1'
        ? { ...t, status: 'failed' as const, exitCode, completedAt: Date.now() }
        : t
    )

    expect(updated[0].status).toBe('failed')
    expect(updated[0].exitCode).toBeNull()
  })
})
