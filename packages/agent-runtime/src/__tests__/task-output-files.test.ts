// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Per-task log files: header/footer, size cap with kept tail, retention sweep. */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'fs'
import { join } from 'path'
import { TaskOutputWriter, cleanupTaskOutputs, taskOutputDir, taskOutputRoot } from '../task-output'
import { TaskRegistry } from '../task-registry'

const DIR = '/tmp/test-task-output-files'

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('TaskOutputWriter', () => {
  test('writes a header, the output, then a footer', () => {
    const path = join(DIR, 't_1.log')
    const w = new TaskOutputWriter(path, { taskId: 't_1', source: 'shell', title: 'bun test\nsecond line', startedAt: 0, extra: { cwd: '/w' } })
    w.append('line 1\n')
    w.append('line 2\n')
    w.finish({ status: 'completed', exitCode: 0, elapsedMs: 12 })
    const text = readFileSync(path, 'utf-8')
    expect(text.startsWith('---\ntask_id: t_1\nsource: shell\ntitle: bun test second line\ncwd: /w\n')).toBe(true)
    expect(text).toContain('line 1\nline 2\n')
    expect(text).toMatch(/status: completed\nexit_code: 0\nelapsed_ms: 12\n/)
    w.append('after finish')
    expect(readFileSync(path, 'utf-8')).not.toContain('after finish')
  })

  test('caps the file and keeps the tail of what was dropped', () => {
    const path = join(DIR, 't_2.log')
    const w = new TaskOutputWriter(path, { taskId: 't_2', source: 'shell', title: 'noisy', startedAt: 0 }, 100)
    w.append('a'.repeat(80))
    w.append('b'.repeat(500) + 'THE END')
    w.finish({ status: 'completed', elapsedMs: 1 })
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('bytes truncated')
    expect(text).toContain('THE END')
  })

  test('an unwritable path never throws', () => {
    writeFileSync(join(DIR, 'file'), '')
    const w = new TaskOutputWriter(join(DIR, 'file', 'nested', 't.log'), { taskId: 't', source: 'shell', title: 'x', startedAt: 0 })
    expect(() => { w.append('x'); w.finish({ status: 'completed', elapsedMs: 0 }) }).not.toThrow()
  })
})

describe('cleanupTaskOutputs', () => {
  test('removes old logs and empty session dirs, keeps fresh ones', () => {
    const root = taskOutputRoot(DIR)
    const oldDir = taskOutputDir(DIR, 'old-session')
    const newDir = taskOutputDir(DIR, 'new/session')
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(oldDir, 't_old.log'), 'x')
    writeFileSync(join(newDir, 't_new.log'), 'x')
    const past = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(join(oldDir, 't_old.log'), past, past)

    expect(newDir.endsWith('new_session')).toBe(true)
    expect(cleanupTaskOutputs(root)).toBe(1)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(join(newDir, 't_new.log'))).toBe(true)
  })
})

describe('registry writes', () => {
  test('a subagent task logs its output under the session dir', async () => {
    const reg = new TaskRegistry({ outputDir: taskOutputDir(DIR, 'chat'), workspaceDir: DIR })
    const task = reg.registerTask({ source: 'subagent', title: 'explore: auth' })
    task.append('read 4 files\n')
    task.finish('completed', { summary: 'auth lives in src/auth' })
    const text = readFileSync(task.entry.outputFile!, 'utf-8')
    expect(text).toContain('source: subagent')
    expect(text).toContain('read 4 files')
    expect(text).toContain('status: completed')
    reg.killAll()
  })

  test('a dormant task has no file until activated', () => {
    const reg = new TaskRegistry({ outputDir: taskOutputDir(DIR, 'chat'), workspaceDir: DIR })
    const entry = reg.registerRemote({ id: 't_card0002', source: 'work_item', title: 'card', apiTracked: true, dormant: true })
    expect(entry.outputFile).toBeUndefined()
    reg.activate(entry.id)
    expect(existsSync(entry.outputFile!)).toBe(true)
    reg.killAll()
  })
})
