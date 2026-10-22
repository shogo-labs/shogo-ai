// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 *   bun test packages/agent-runtime/src/__tests__/exec-memory-guard.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  memoryKillNote,
  sampleOnce,
  trackExecProcess,
  trackedExecPids,
} from '../exec-memory-guard'
import { sandboxExecAsync } from '../sandbox-exec'

const ENV_KEYS = ['SHOGO_EXEC_PIDS_FILE', 'SHOGO_EXEC_MEMORY_MB', 'SHOGO_EXEC_MEMORY_STRIKES', 'SHOGO_EXEC_MEMORY_SAMPLE_MS']
let saved: Record<string, string | undefined>
let dir: string
let untracks: Array<() => void>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  dir = mkdtempSync(join(tmpdir(), 'exec-guard-'))
  process.env.SHOGO_EXEC_PIDS_FILE = join(dir, 'pids.json')
  process.env.SHOGO_EXEC_MEMORY_SAMPLE_MS = '600000'
  delete process.env.SHOGO_EXEC_MEMORY_MB
  delete process.env.SHOGO_EXEC_MEMORY_STRIKES
  untracks = []
})

afterEach(() => {
  for (const u of untracks) u()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(dir, { recursive: true, force: true })
})

function track(pid: number, onKill: (note: string) => void = () => {}) {
  const untrack = trackExecProcess({ pid, killForMemory: onKill })
  untracks.push(untrack)
  return untrack
}

const readPids = () => JSON.parse(readFileSync(process.env.SHOGO_EXEC_PIDS_FILE!, 'utf-8')).pids

const fakeSample = (sizesMB: Record<number, number>) => async (roots: number[]) =>
  new Map(roots.filter((r) => r in sizesMB).map((r) => [r, sizesMB[r]! * 1024] as [number, number]))

describe('exec PID publishing', () => {
  test('writes live exec PIDs for the runtime watchdog and removes them on untrack', () => {
    const a = track(1111)
    track(2222)
    expect(readPids().sort()).toEqual([1111, 2222])
    a()
    a()
    expect(readPids()).toEqual([2222])
  })

  test('ignores non-positive PIDs', () => {
    track(0)
    expect(trackedExecPids()).toEqual([])
    expect(existsSync(process.env.SHOGO_EXEC_PIDS_FILE!)).toBe(false)
  })
})

describe('memory budget for exec commands', () => {
  test('stops only the largest command after consecutive breaches', async () => {
    process.env.SHOGO_EXEC_MEMORY_MB = '1000'
    const killed: Record<number, string> = {}
    track(10, (note) => { killed[10] = note })
    track(20, (note) => { killed[20] = note })
    const sample = fakeSample({ 10: 300, 20: 900 })

    await sampleOnce(sample)
    expect(killed).toEqual({})

    await sampleOnce(sample)
    expect(Object.keys(killed)).toEqual(['20'])
    expect(killed[20]).toContain('out of memory')
    expect(trackedExecPids()).toEqual([10])
    expect(readPids()).toEqual([10])
  })

  test('a reading under budget resets the strike count', async () => {
    process.env.SHOGO_EXEC_MEMORY_MB = '1000'
    let kills = 0
    track(10, () => { kills++ })
    await sampleOnce(fakeSample({ 10: 1500 }))
    await sampleOnce(fakeSample({ 10: 200 }))
    await sampleOnce(fakeSample({ 10: 1500 }))
    expect(kills).toBe(0)
  })

  test('does nothing without a budget', async () => {
    let kills = 0
    track(10, () => { kills++ })
    await sampleOnce(fakeSample({ 10: 99999 }))
    await sampleOnce(fakeSample({ 10: 99999 }))
    expect(kills).toBe(0)
  })

  test('the note names the command size, the total and the limit', () => {
    const note = memoryKillNote(9000, 13500, 8192)
    expect(note).toContain('8.8 GB')
    expect(note).toContain('13.2 GB across all running commands')
    expect(note).toContain('8.0 GB limit')
  })
})

describe('sandboxExecAsync integration', () => {
  test('a command over budget is stopped and the reason lands in its output', async () => {
    process.env.SHOGO_EXEC_MEMORY_MB = '1'
    process.env.SHOGO_EXEC_MEMORY_STRIKES = '1'
    const handle = sandboxExecAsync({ command: 'sleep 30', workspaceDir: dir })
    expect(trackedExecPids()).toContain(handle.pid!)

    // One `ps` read is a snapshot of an instant: a process group that has just
    // been forked can still read as empty (or under budget) on a loaded runner,
    // and a single missed sample means the guard never strikes and `done` never
    // resolves — which surfaces here as the 20 s timeout, not as a guard
    // failure. Sample the way the real timer does, repeatedly, until the breach
    // lands.
    for (let i = 0; i < 40 && !handle.exited(); i++) {
      await sampleOnce()
      if (handle.exited()) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const result = await handle.done

    expect(result.killed).toBe(true)
    expect(result.killReason).toContain('out of memory')
    expect(result.stderr).toContain('out of memory')
    expect(trackedExecPids()).not.toContain(handle.pid!)
  }, 20_000)

  test('a command that exits on its own is untracked', async () => {
    const handle = sandboxExecAsync({ command: 'echo hi', workspaceDir: dir })
    const result = await handle.done
    expect(result.exitCode).toBe(0)
    expect(result.killReason).toBeUndefined()
    expect(trackedExecPids()).not.toContain(handle.pid!)
  }, 20_000)
})
