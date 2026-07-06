// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the orphan firecracker-process reaper — the safety net for the
 * churn leak where partial boot/restore/assign failures left live `firecracker`
 * children untracked by the pool (they accumulated until the host thrashed).
 * We seed the manager's private proc bookkeeping directly (no real FC host) and
 * assert only untracked-AND-aged processes are killed.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { FirecrackerVMManager } from './firecracker-vm-manager'

const dirs: string[] = []

function makeMgr() {
  const dir = mkdtempSync(join(tmpdir(), 'fcmgr-'))
  dirs.push(dir)
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
  }
  return new FirecrackerVMManager(cfg as any)
}

function fakeProc(id: string, killed: string[]) {
  return { kill: () => { killed.push(id); return true }, exitCode: null, killed: false }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('FirecrackerVMManager.reapOrphans', () => {
  test('kills untracked procs older than the grace; keeps tracked and young', () => {
    const mgr = makeMgr()
    const killed: string[] = []
    const now = Date.now()
    ;(mgr as any).procs = new Map([
      ['tracked', fakeProc('tracked', killed)],
      ['orphan-old', fakeProc('orphan-old', killed)],
      ['orphan-young', fakeProc('orphan-young', killed)],
    ])
    ;(mgr as any).spawnedAt = new Map([
      ['tracked', now],
      ['orphan-old', now - 200_000], // untracked + past grace → reap
      ['orphan-young', now - 1_000], // untracked but still booting → keep
    ])

    const n = mgr.reapOrphans(new Set(['tracked']), 120_000)

    expect(n).toBe(1)
    expect(killed).toEqual(['orphan-old'])
    expect((mgr as any).procs.has('tracked')).toBe(true)
    expect((mgr as any).procs.has('orphan-young')).toBe(true)
    expect((mgr as any).procs.has('orphan-old')).toBe(false)
    expect(mgr.procCount()).toBe(2)
  })

  test('reaps nothing when every process is tracked', () => {
    const mgr = makeMgr()
    const killed: string[] = []
    const now = Date.now()
    ;(mgr as any).procs = new Map([
      ['a', fakeProc('a', killed)],
      ['b', fakeProc('b', killed)],
    ])
    ;(mgr as any).spawnedAt = new Map([['a', now - 999_999], ['b', now - 999_999]])

    const n = mgr.reapOrphans(new Set(['a', 'b']), 120_000)

    expect(n).toBe(0)
    expect(killed).toEqual([])
    expect(mgr.procCount()).toBe(2)
  })
})
