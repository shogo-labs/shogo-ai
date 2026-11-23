// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { resolve } from 'path'
import { TEST_CLOCK_PRELOAD_PATH, clockOffsetPreloadArgs } from '../lib/test-clock-offset'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const PRELOAD = TEST_CLOCK_PRELOAD_PATH

/**
 * The preload replaces `globalThis.Date`, so it is exercised in a child process:
 * shifting the clock inside the test runner would leak into every other suite in
 * the same run.
 */
function probe(offsetDays: number | null): { shiftedIso: string; explicitIso: string; pinnedIso: string } {
  const script = `
    import { setSystemTime } from 'bun:test'
    const shiftedIso = new Date().toISOString()
    const explicitIso = new Date('2026-01-01T00:00:00Z').toISOString()
    setSystemTime(new Date('2026-11-18T12:00:00Z'))
    console.log(JSON.stringify({ shiftedIso, explicitIso, pinnedIso: new Date().toISOString() }))
  `
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.SHOGO_TEST_CLOCK_OFFSET_DAYS
  if (offsetDays !== null) env.SHOGO_TEST_CLOCK_OFFSET_DAYS = String(offsetDays)
  const proc = spawnSync('bun', ['--no-env-file', '--preload', PRELOAD, '-e', script], { encoding: 'utf-8', env })
  if (proc.status !== 0) throw new Error(`probe failed: ${proc.stderr}`)
  return JSON.parse(proc.stdout.trim().split('\n').pop()!) as {
    shiftedIso: string
    explicitIso: string
    pinnedIso: string
  }
}

describe('test-clock-offset-preload', () => {
  test('shifts Date.now() and new Date() by the requested days', () => {
    const plain = probe(null)
    const shifted = probe(7)
    const delta = Date.parse(shifted.shiftedIso) - Date.parse(plain.shiftedIso)
    // Allow a second of slop for the two child processes starting.
    expect(delta).toBeGreaterThan(7 * 86_400_000 - 5_000)
    expect(delta).toBeLessThan(7 * 86_400_000 + 5_000)
  })

  test('leaves explicit dates alone — the offset changes today, not the calendar', () => {
    const shifted = probe(30)
    expect(shifted.explicitIso).toBe('2026-01-01T00:00:00.000Z')
  })

  test('a test that pins the clock wins over the offset', () => {
    // The trap the naive version fell into: pin 2026-11-18 under a +7d offset
    // and read 2026-11-25, which would report every pinned test as a bomb.
    expect(probe(7).pinnedIso).toBe('2026-11-18T12:00:00.000Z')
    expect(probe(90).pinnedIso).toBe('2026-11-18T12:00:00.000Z')
  })

  test('the isolated runner only adds the preload when the job asked for it', () => {
    expect(clockOffsetPreloadArgs({ PATH: '/bin' })).toEqual([])
    expect(clockOffsetPreloadArgs({ SHOGO_TEST_CLOCK_OFFSET_DAYS: '7' })).toEqual(['--preload', PRELOAD])
  })
})
