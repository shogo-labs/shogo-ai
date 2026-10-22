// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A finished result belongs to the agent that started it until that agent
 * reads it. Retention is a lease released by `markConsumed`, not a wall clock:
 * the short window only applies once the result has been read, an unread one
 * survives the dock window, a restart does not mark it read, and when memory is
 * finally evicted the output file rebuilds it.
 */

import { describe, test, expect } from 'bun:test'
import { TaskRegistry } from '../task-registry'
import type { TaskOutputRow } from '../task-output'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function unreadFinished(reg: TaskRegistry, title = 'explore') {
  const task = reg.registerTask({ source: 'subagent', title, backgrounded: true, notify: true })
  task.finish('completed', { summary: `${title}: the report` })
  return task
}

describe('result retention is gated on consumption', () => {
  test('an unread result outlives the dock window and wait still returns it', async () => {
    const reg = new TaskRegistry({ retentionMs: 20, unreadRetentionMs: 5_000 })
    const task = unreadFinished(reg)

    await sleep(60)

    expect(reg.get(task.entry.id)).toBeDefined()
    const outcome = await reg.wait([task.entry.id], { timeoutMs: 0 })
    expect(outcome.kind).toBe('finished')
    expect((outcome as { task?: { result?: { summary?: string } } }).task?.result?.summary).toBe('explore: the report')
  })

  test('after it is read the normal window applies', async () => {
    const reg = new TaskRegistry({ retentionMs: 20, unreadRetentionMs: 5_000 })
    const task = unreadFinished(reg)

    reg.markConsumed([task.entry.id])
    await sleep(60)

    expect(reg.get(task.entry.id)).toBeUndefined()
  })

  test('a result nobody was told about is evicted on the normal window', async () => {
    const reg = new TaskRegistry({ retentionMs: 20, unreadRetentionMs: 5_000 })
    const task = reg.registerTask({ source: 'subagent', title: 'foreground' })
    task.finish('completed', { summary: 'ok' })

    await sleep(60)

    expect(reg.get(task.entry.id)).toBeUndefined()
  })

  test('memory stays bounded: the oldest unread results are dropped first', async () => {
    const reg = new TaskRegistry({ maxUnconsumed: 2, unreadRetentionMs: 60_000 })
    const a = unreadFinished(reg, 'a')
    await sleep(2)
    const b = unreadFinished(reg, 'b')
    await sleep(2)
    const c = unreadFinished(reg, 'c')

    expect(reg.get(a.entry.id)).toBeUndefined()
    expect(reg.get(b.entry.id)).toBeDefined()
    expect(reg.get(c.entry.id)).toBeDefined()
  })

  test('the cap drops one read row per excess unread result, not every read row', async () => {
    const reg = new TaskRegistry({ maxUnconsumed: 2, retentionMs: 60_000, unreadRetentionMs: 60_000 })
    const reads = ['r1', 'r2', 'r3'].map((title) => {
      const task = reg.registerTask({ source: 'subagent', title })
      task.finish('completed', { summary: 'ok' })
      return task
    })
    const unread = [unreadFinished(reg, 'u1'), unreadFinished(reg, 'u2')]
    // Two unread results, a cap of two: nothing has to go yet.
    expect(reads.every((t) => reg.get(t.entry.id))).toBe(true)

    unread.push(unreadFinished(reg, 'u3'))

    // Exactly one read row made room for the third unread result.
    expect(reads.filter((t) => reg.get(t.entry.id))).toHaveLength(2)
    expect(unread.every((t) => reg.get(t.entry.id))).toBe(true)
  })
})

describe('a restart does not mark an unread result read', () => {
  test('consumed and backgrounded survive the snapshot', async () => {
    const reg = new TaskRegistry({ retentionMs: 20, unreadRetentionMs: 5_000 })
    const task = unreadFinished(reg)
    const snap = reg.snapshot()

    const restored = new TaskRegistry({ retentionMs: 20, unreadRetentionMs: 5_000 })
    restored.restoreStale(snap)

    expect(restored.get(task.entry.id)?.consumed).toBe(false)
    await sleep(60)
    expect(restored.get(task.entry.id)).toBeDefined()
    expect((await restored.wait([task.entry.id], { timeoutMs: 0 })).kind).toBe('finished')
  })

  test('an unread result older than the dock window is still in the snapshot', async () => {
    const reg = new TaskRegistry({ retentionMs: 20 })
    const task = unreadFinished(reg)
    // Finished well outside the 10-minute window the dock shows, never read.
    task.entry.finishedAt = Date.now() - 11 * 60_000

    const snap = reg.snapshot()
    expect(snap.map((s) => s.runId)).toContain(task.entry.id)
    expect(snap.find((s) => s.runId === task.entry.id)?.consumed).toBe(false)

    const restored = new TaskRegistry({ retentionMs: 20 })
    restored.restoreStale(snap)
    expect(restored.get(task.entry.id)?.consumed).toBe(false)
    expect((await restored.wait([task.entry.id], { timeoutMs: 0 })).kind).toBe('finished')
  })
})

describe('recovery from the output file', () => {
  function row(overrides: Partial<TaskOutputRow> = {}): TaskOutputRow {
    const now = Date.now()
    return {
      taskId: 't_gone0001',
      source: 'shell',
      title: 'bun test',
      startedAt: now - 600_000,
      path: '/tmp/.shogo/tasks/s/t_gone0001.log',
      status: 'failed',
      exitCode: 1,
      elapsedMs: 4_210,
      finishedAt: now - 590_000,
      modifiedAt: now - 590_000,
      ...overrides,
    }
  }

  test('an evicted result is rebuilt from its log, marked recovered', async () => {
    const rows = new Map<string, TaskOutputRow>([['t_gone0001', row()]])
    const reg = new TaskRegistry({ resolveOutputRow: (id) => rows.get(id) ?? null })

    expect(reg.get('t_gone0001')).toBeUndefined()
    const entry = await reg.resolveFinished('t_gone0001')

    expect(entry?.recovered).toBe(true)
    expect(entry?.status).toBe('failed')
    expect(entry?.result?.exitCode).toBe(1)
    expect(reg.get('t_gone0001')).toBeDefined()
    expect((await reg.wait(['t_gone0001'], { timeoutMs: 0 })).kind).toBe('finished')
  })

  test('no log means nothing to recover', async () => {
    const reg = new TaskRegistry({ resolveOutputRow: () => null })
    expect(await reg.resolveFinished('t_missing1')).toBeNull()
  })

  test('an entry still in memory is returned as it is, not recovered twice', async () => {
    const rows = new Map<string, TaskOutputRow>()
    const reg = new TaskRegistry({ resolveOutputRow: (id) => rows.get(id) ?? null })
    const task = reg.registerTask({ source: 'subagent', title: 'explore', backgrounded: true })
    rows.set(task.entry.id, row({ taskId: task.entry.id }))

    const entry = await reg.resolveFinished(task.entry.id)
    expect(entry?.recovered).toBeUndefined()
    expect(entry?.status).toBe('running')
  })

  test('names the output path a missing task would have written', () => {
    const reg = new TaskRegistry({ outputDir: '/ws/.shogo/tasks/s', workspaceDir: '/ws' })
    expect(reg.outputPathFor('t_abcdef01')).toBe('.shogo/tasks/s/t_abcdef01.log')
  })
})
