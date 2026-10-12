// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The wrapper reads `node:child_process` at call time, so a mock installed
// before the import is what these assertions observe. mock.module is
// process-global; this file runs in its own process via run-tests-isolated.

import { describe, expect, mock, test } from 'bun:test'
import { promisify } from 'node:util'

type Call = { fn: string; args: unknown[] }
const calls: Call[] = []

function record(fn: string) {
  return (...args: unknown[]) => {
    calls.push({ fn, args })
    return { fn }
  }
}

const fakeExec = record('exec')
const fakeExecFile = record('execFile')
;(fakeExec as unknown as { [k: symbol]: unknown })[promisify.custom] = (cmd: string, opts?: unknown) => {
  calls.push({ fn: 'exec.custom', args: [cmd, opts] })
  return Promise.resolve({ stdout: 'out', stderr: '' })
}
;(fakeExecFile as unknown as { [k: symbol]: unknown })[promisify.custom] = (...args: unknown[]) => {
  calls.push({ fn: 'execFile.custom', args })
  return Promise.resolve({ stdout: 'file-out', stderr: '' })
}

const fake = {
  spawn: record('spawn'),
  spawnSync: record('spawnSync'),
  exec: fakeExec,
  execSync: record('execSync'),
  execFile: fakeExecFile,
  execFileSync: record('execFileSync'),
  fork: record('fork'),
}
mock.module('node:child_process', () => fake)
mock.module('child_process', () => fake)

const cp = await import('../child-process')

function last(fn: string): unknown[] {
  const found = calls.filter((c) => c.fn === fn)
  const call = found[found.length - 1]
  if (!call) throw new Error(`no call to ${fn}`)
  return call.args
}

describe('child_process windowsHide default', () => {
  test('spawn merges windowsHide into an options object and does not mutate it', () => {
    const opts = { cwd: '/tmp' }
    cp.spawn('git', ['status'], opts)
    expect(opts).toEqual({ cwd: '/tmp' })
    expect(last('spawn')[2]).toEqual({ cwd: '/tmp', windowsHide: true })
  })

  test('spawn treats a bare options object as options, not argv', () => {
    cp.spawn('git', { cwd: '/repo' })
    expect(last('spawn')[1]).toEqual({ cwd: '/repo', windowsHide: true })
  })

  test('spawn appends options when the caller passed only argv', () => {
    cp.spawn('git', ['status'])
    expect(last('spawn')[2]).toEqual({ windowsHide: true })
  })

  test('an explicit windowsHide is preserved by identity', () => {
    const opts = { cwd: '/tmp', windowsHide: false }
    cp.spawn('git', ['status'], opts)
    expect(last('spawn')[2]).toBe(opts)
  })

  test('exec inserts options ahead of a callback', () => {
    const cb = () => {}
    cp.exec('echo hi', cb)
    const args = last('exec')
    expect(args[1]).toEqual({ windowsHide: true })
    expect(args[2]).toBe(cb)
  })

  test('exec replaces null options', () => {
    const cb = () => {}
    cp.exec('echo hi', null as unknown as undefined, cb)
    const args = last('exec')
    expect(args[1]).toEqual({ windowsHide: true })
    expect(args[2]).toBe(cb)
  })

  test('execFile keeps a null argv and still hides the window', () => {
    const cb = () => {}
    cp.execFile('npm.cmd', null, cb)
    const args = last('execFile')
    expect(args[1]).toBeNull()
    expect(args[2]).toEqual({ windowsHide: true })
    expect(args[3]).toBe(cb)
  })

  test('execFileSync merges into the options that follow a null argv', () => {
    const opts = { cwd: '/x' }
    // Node accepts `null` argv at runtime; the published type only allows an array.
    const execFileSync = cp.execFileSync as (file: string, args: null, options: { cwd: string }) => unknown
    execFileSync('git', null, opts)
    expect(opts).toEqual({ cwd: '/x' })
    expect(last('execFileSync')).toEqual(['git', null, { cwd: '/x', windowsHide: true }])
  })

  test('execFile fills an undefined or null options slot ahead of the callback', () => {
    const cb = () => {}
    const execFile = cp.execFile as (...args: unknown[]) => unknown
    execFile('git', ['status'], undefined, cb)
    expect(last('execFile')).toEqual(['git', ['status'], { windowsHide: true }, cb])
    execFile('git', ['status'], null, cb)
    expect(last('execFile')).toEqual(['git', ['status'], { windowsHide: true }, cb])
  })

  test('spawn fills an undefined options slot instead of appending past it', () => {
    const spawn = cp.spawn as (...args: unknown[]) => unknown
    spawn('git', ['status'], undefined)
    expect(last('spawn')).toEqual(['git', ['status'], { windowsHide: true }])
  })

  test('execFile with no argv or options inserts options before the callback', () => {
    const cb = () => {}
    cp.execFile('git', cb)
    expect(last('execFile')).toEqual(['git', { windowsHide: true }, cb])
  })

  test('execSync merges windowsHide without dropping encoding', () => {
    cp.execSync('echo hi', { encoding: 'utf8' })
    expect(last('execSync')[1]).toEqual({ encoding: 'utf8', windowsHide: true })
  })

  test('spawnSync and fork get the same default', () => {
    cp.spawnSync('git', ['status'])
    cp.fork('worker.js')
    expect(last('spawnSync')[2]).toEqual({ windowsHide: true })
    expect(last('fork')[1]).toEqual({ windowsHide: true })
  })

  test('promisify(exec) still resolves { stdout, stderr } and hides the window', async () => {
    const execAsync = promisify(cp.exec)
    const result = await execAsync('echo hi')
    expect(result).toEqual({ stdout: 'out', stderr: '' })
    expect(last('exec.custom')[1]).toEqual({ windowsHide: true })
  })

  test('promisify(execFile) hides the window', async () => {
    const execFileAsync = promisify(cp.execFile)
    const result = await execFileAsync('git', ['status'])
    expect(result).toEqual({ stdout: 'file-out', stderr: '' })
    expect(last('execFile.custom')[2]).toEqual({ windowsHide: true })
  })
})
