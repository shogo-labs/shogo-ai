// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `listTaskOutputRows` reads the per-task logs back into dock rows, which is
 * the fallback when no session snapshot survived a restart: a footer block
 * means the task settled (and how), no footer means the runtime died under it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { TaskOutputWriter, listTaskOutputRows, taskOutputDir } from '../task-output'

let dir: string
let counter = 0

beforeEach(() => {
  dir = join(tmpdir(), `task-output-rows-${process.pid}-${++counter}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFinishedLog(taskId: string, status: 'completed' | 'failed', title = 'bun test') {
  const path = join(dir, `${taskId}.log`)
  const writer = new TaskOutputWriter(path, {
    taskId,
    source: 'shell',
    title,
    startedAt: Date.now() - 42_000,
  })
  writer.append('3 pass\n0 fail\n')
  writer.finish({ status, exitCode: status === 'failed' ? 1 : 0, elapsedMs: 42_000 })
  return path
}

describe('listTaskOutputRows', () => {
  test('a settled log gives back its identity, outcome and finish time', () => {
    const path = writeFinishedLog('t_1a2b3c4d', 'failed')
    const [row] = listTaskOutputRows(dir)
    expect(row?.taskId).toBe('t_1a2b3c4d')
    expect(row?.title).toBe('bun test')
    expect(row?.source).toBe('shell')
    expect(row?.path).toBe(path)
    expect(row?.status).toBe('failed')
    expect(row?.exitCode).toBe(1)
    expect(row?.elapsedMs).toBe(42_000)
    expect(row?.finishedAt).toBeGreaterThan(0)
    expect(row?.startedAt).toBeLessThan(row!.finishedAt!)
  })

  test('a log with no footer is a task the runtime died under', () => {
    writeFileSync(
      join(dir, 't_5e6f7a8b.log'),
      ['---', 'task_id: t_5e6f7a8b', 'source: shell', 'title: bun dev', `started_at: ${new Date().toISOString()}`, '---', '', 'ready on 8081', ''].join('\n'),
    )
    const [row] = listTaskOutputRows(dir)
    expect(row?.taskId).toBe('t_5e6f7a8b')
    expect(row?.status).toBeUndefined()
    expect(row?.finishedAt).toBeUndefined()
  })

  test('rows come back newest first and stay inside the age window', () => {
    writeFinishedLog('t_aaaaaaa1', 'completed', 'older')
    const newer = writeFinishedLog('t_aaaaaaa2', 'completed', 'newer')
    const now = Date.now() / 1000
    utimesSync(join(dir, 't_aaaaaaa1.log'), now - 120, now - 120)
    utimesSync(newer, now, now)

    expect(listTaskOutputRows(dir).map((r) => r.title)).toEqual(['newer', 'older'])
    expect(listTaskOutputRows(dir, { maxAgeMs: 60_000 }).map((r) => r.title)).toEqual(['newer'])
  })

  test('a missing directory is not an error', () => {
    expect(listTaskOutputRows(join(dir, 'nope'))).toEqual([])
  })

  test('taskOutputDir keeps one directory per session name', () => {
    expect(taskOutputDir('/ws', 'a/b')).toBe('/ws/.shogo/tasks/a_b')
  })
})
