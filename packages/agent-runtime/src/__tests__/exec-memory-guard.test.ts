// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 *   bun test packages/agent-runtime/src/__tests__/exec-memory-guard.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  memoryKillNote,
  sampleOnce,
  sampleTreeRssKb,
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

/** Bytes the over-budget test's child really holds: 192 MB, above the ceiling. */
const MEMORY_HOG_MB = 192

/**
 * Ceiling for the integration test. A command budget, not a rounding test: far
 * above a `sleep` (~2 MB) or a bare runtime's footprint, so only the memory the
 * command really holds can breach it.
 */
const OVER_BUDGET_MB = 64

/**
 * Source of the child the over-budget test runs: hold the 192 MB above and
 * write every page so the resident set is real rather than reserved, then idle
 * long enough for the guard to sample it.
 *
 * The buffer has to stay **reachable**. `const hog = Buffer.alloc(…)` followed
 * by a timer that never mentions `hog` is dead the moment the script body
 * returns; the collector frees the 192 MB milliseconds later and the child
 * measures ~23 MB for the rest of its life, so the guard correctly never
 * strikes. That was SHO-154: on ubuntu-latest the test read 23-52 MB instead of
 * the ~218 MB the child had briefly held. `report` reads the buffer on every
 * tick, which pins it and lets the test see the child is still holding it.
 */
const MEMORY_HOG_SCRIPT =
  `const bytes = ${MEMORY_HOG_MB} * 1024 * 1024\n` +
  `const hog = Buffer.alloc(bytes, 1)\n` +
  `function report() {\n` +
  `  if (hog[0] !== 1 || hog[hog.length - 1] !== 1) process.exit(2)\n` +
  `  console.log('[memory-hog] holding=${MEMORY_HOG_MB} rss=' + process.memoryUsage().rss)\n` +
  `}\n` +
  `report()\n` +
  `setInterval(report, 500)\n` +
  `setTimeout(() => process.exit(0), 60000)\n`

/** The child's own account of what it holds: its last `[memory-hog]` line. */
function hogReport(stdout: string): { rssKb: number } | null {
  const matches = [...stdout.matchAll(/\[memory-hog\] holding=\d+ rss=(\d+)/g)]
  const last = matches[matches.length - 1]
  return last ? { rssKb: Math.floor(Number(last[1]) / 1024) } : null
}

/**
 * Per-pid RSS of the sampled tree, for the day the over-budget reading is wrong
 * again. It separates the two possible causes in the failure message: "the
 * pages are not resident" (the child's own reading is small too) from "the
 * sample misses the holder" (the child reads large, the tree does not).
 */
function describeTree(pid: number): string {
  let rows: string[]
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,args='], { encoding: 'utf-8' })
    rows = out.split('\n').filter((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line)
      return !!m && Number(m[3]) === pid
    })
  } catch {
    // No `ps` (Windows runs its own sampler path); the child's reading still prints.
    return '(no ps on this platform)'
  }
  return rows.length
    ? `tree of pgid ${pid} (pid ppid pgid rssKb args):\n    ${rows.join('\n    ')}`
    : `no process carried pgid ${pid}`
}

/** Quote a path for the shell `sandboxExecAsync` will run the command under. */
function quotePath(value: string): string {
  return process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`
}

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
    // What the command *is* has to matter: `sleep 30` is ~1.5 MB on
    // ubuntu-24.04 and ~2 MB on macOS, so a 1 MB ceiling struck here and never
    // on CI, no matter how many samples were taken. Run a child that really
    // holds 192 MB instead, under a ceiling a plain process stays well below —
    // so only the allocation can breach it.
    process.env.SHOGO_EXEC_MEMORY_MB = String(OVER_BUDGET_MB)
    process.env.SHOGO_EXEC_MEMORY_STRIKES = '1'
    const hogScript = join(dir, 'memory-hog.js')
    writeFileSync(hogScript, MEMORY_HOG_SCRIPT)
    const handle = sandboxExecAsync({
      command: `${quotePath(process.execPath)} ${quotePath(hogScript)}`,
      workspaceDir: dir,
    })
    expect(trackedExecPids()).toContain(handle.pid!)

    // Two things make a single reading unreliable on a loaded runner. The child
    // is not holding its memory the moment it is spawned — it still has a
    // runtime to start and 192 MB to touch — and a `ps` read can be slow enough
    // that one sample lands before that. So wait for the child's own report
    // that it holds its buffer, then sample while the OS reports the group over
    // the ceiling, and stop as soon as the guard has killed it. Sampling once
    // and hoping is what turned "the guard never struck" into a 20 s test
    // timeout with no guard output at all.
    const ceilingKb = OVER_BUDGET_MB * 1024
    const deadline = Date.now() + 20_000
    let holding: { rssKb: number } | null = null
    let measuredKb = 0
    while (Date.now() < deadline && !handle.exited()) {
      holding ??= hogReport(handle.stdout())
      if (holding) {
        const sizes = await sampleTreeRssKb([handle.pid!])
        measuredKb = Math.max(measuredKb, sizes.get(handle.pid!) ?? 0)
        if (measuredKb > ceilingKb) await sampleOnce()
      }
      if (handle.exited()) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!holding) {
      throw new Error(
        `the child never reported holding its ${MEMORY_HOG_MB} MB (exited=${handle.exited()}), ` +
          `so nothing could be sampled. stdout:\n${handle.stdout()}\nstderr:\n${handle.stderr()}`,
      )
    }
    if (measuredKb <= ceilingKb) {
      throw new Error(
        `the sampler never saw the command above the ${OVER_BUDGET_MB} MB ceiling ` +
          `(peak ${Math.floor(measuredKb / 1024)} MB), while the child itself reported holding ` +
          `${Math.floor(holding.rssKb / 1024)} MB. ${describeTree(handle.pid!)}`,
      )
    }

    const result = await Promise.race([
      handle.done,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ])
    if (!result) {
      handle.kill('SIGKILL')
      throw new Error(
        `the guard did not stop a command the OS reports at ${Math.floor(measuredKb / 1024)} MB, ` +
          `over the ${OVER_BUDGET_MB} MB ceiling. ${describeTree(handle.pid!)}`,
      )
    }

    expect(result.killed).toBe(true)
    expect(result.killReason).toContain('out of memory')
    expect(result.stderr).toContain('out of memory')
    // The note reports what the guard measured, and that reading has to clear
    // the ceiling — not merely be a command that looks big.
    const reported = /using (\d+) MB/.exec(result.killReason ?? '')
    expect(Number(reported?.[1])).toBeGreaterThan(OVER_BUDGET_MB)
    expect(trackedExecPids()).not.toContain(handle.pid!)
  }, 60_000)

  test('a command that exits on its own is untracked', async () => {
    const handle = sandboxExecAsync({ command: 'echo hi', workspaceDir: dir })
    const result = await handle.done
    expect(result.exitCode).toBe(0)
    expect(result.killReason).toBeUndefined()
    expect(trackedExecPids()).not.toContain(handle.pid!)
  }, 20_000)
})
