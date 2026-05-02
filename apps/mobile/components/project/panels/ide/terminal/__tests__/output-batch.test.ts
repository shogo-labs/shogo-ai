// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, mock, test } from 'bun:test'
import { OutputBatcher, type Scheduler } from '../output-batch'

/** Test scheduler that fires the callback synchronously on the next tick. */
function makeManualScheduler(): {
  scheduler: Scheduler
  drain: () => void
  pending: number
} {
  const queue: Array<() => void> = []
  return {
    scheduler: (cb) => {
      queue.push(cb)
    },
    drain() {
      while (queue.length) queue.shift()!()
    },
    get pending() {
      return queue.length
    },
  }
}

describe('OutputBatcher', () => {
  test('buffers append() calls and flushes on the next scheduler tick', () => {
    const commit = mock(() => {})
    const sched = makeManualScheduler()
    const b = new OutputBatcher(commit as never, sched.scheduler)

    b.append('s1', 'hello ')
    b.append('s1', 'world')

    expect(commit).not.toHaveBeenCalled()
    sched.drain()
    expect(commit).toHaveBeenCalledTimes(1)
    const snapshot = commit.mock.calls[0][0] as Map<string, string>
    expect(snapshot.get('s1')).toBe('hello world')
  })

  test('coalesces multiple appends across several sessions into one commit', () => {
    const commit = mock(() => {})
    const sched = makeManualScheduler()
    const b = new OutputBatcher(commit as never, sched.scheduler)

    b.append('a', '1')
    b.append('b', '2')
    b.append('a', '3')

    sched.drain()
    expect(commit).toHaveBeenCalledTimes(1)
    const snapshot = commit.mock.calls[0][0] as Map<string, string>
    expect(snapshot.get('a')).toBe('13')
    expect(snapshot.get('b')).toBe('2')
  })

  test('schedules at most once per pending tick (no duplicate flushes)', () => {
    const commit = mock(() => {})
    const sched = makeManualScheduler()
    const b = new OutputBatcher(commit as never, sched.scheduler)

    b.append('a', '1')
    b.append('a', '2')
    b.append('a', '3')

    expect(sched.pending).toBe(1)
  })

  test('flushNow() commits synchronously and resets the schedule flag', () => {
    const commit = mock(() => {})
    const sched = makeManualScheduler()
    const b = new OutputBatcher(commit as never, sched.scheduler)

    b.append('a', 'x')
    b.flushNow()
    expect(commit).toHaveBeenCalledTimes(1)

    // The next append re-arms the scheduler.
    b.append('a', 'y')
    expect(sched.pending).toBeGreaterThan(0)
  })

  test('clear(id) drops only that session’s pending bytes', () => {
    const commit = mock(() => {})
    const sched = makeManualScheduler()
    const b = new OutputBatcher(commit as never, sched.scheduler)

    b.append('a', 'aaa')
    b.append('b', 'bbb')
    b.clear('a')
    b.flushNow()

    const snapshot = commit.mock.calls[0][0] as Map<string, string>
    expect(snapshot.has('a')).toBe(false)
    expect(snapshot.get('b')).toBe('bbb')
  })

  test('reset() drops everything and prevents an in-flight tick from committing', () => {
    const commit = mock(() => {})
    const sched = makeManualScheduler()
    const b = new OutputBatcher(commit as never, sched.scheduler)

    b.append('a', 'x')
    b.reset()
    sched.drain()
    expect(commit).not.toHaveBeenCalled()
  })

  test('append("") is a no-op', () => {
    const commit = mock(() => {})
    const sched = makeManualScheduler()
    const b = new OutputBatcher(commit as never, sched.scheduler)
    b.append('a', '')
    sched.drain()
    expect(commit).not.toHaveBeenCalled()
  })

  test('flushNow() with nothing pending does not commit', () => {
    const commit = mock(() => {})
    const sched = makeManualScheduler()
    const b = new OutputBatcher(commit as never, sched.scheduler)
    b.flushNow()
    expect(commit).not.toHaveBeenCalled()
  })
})
