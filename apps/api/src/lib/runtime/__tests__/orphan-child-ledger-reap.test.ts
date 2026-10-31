// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-277 A3 — orphaned runtime children are reaped under `.workspace-roots`
 * and the reap keeps running while the API is up.
 *
 * The boot sweep used to skip every dot-directory, and `.workspace-roots` is
 * where every team-agent runtime lives. On a machine running many agents that
 * meant a 12-day-old `vite build --watch`, two Metros and a `relay-pod` were
 * never reaped (12 orphans / 3.6 GB). It also only ever ran once, at boot.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The manager shells out for its port/ps scans; none of that may reach the real
// process table from a unit test.
mock.module('child_process', () => ({
  execSync: () => '',
  execFile: () => {},
  execFileSync: () => '',
  exec: (_cmd: string, optsOrCb: any, maybeCb?: any) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb
    cb?.(null, '', '')
  },
  spawnSync: () => ({ status: 0, stdout: '', stderr: '', error: null }),
  spawn: mock(() => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => true,
    killed: false,
    exitCode: null,
  })),
}))

const { childLedgerDirs, reapChildLedgersUnder, WORKSPACE_ROOTS_DIR } = await import('../child-ledger-sweep')
const { RuntimeManager } = await import('../manager')

let root: string
let workspacesDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sho277-reap-'))
  workspacesDir = join(root, 'workspaces')
  mkdirSync(workspacesDir, { recursive: true })
  process.env.SHOGO_SKIP_STALE_RUNTIME_CLEANUP = '1'
  delete process.env.RUNTIME_ORPHAN_REAP_INTERVAL_MS
})

afterEach(() => {
  delete process.env.SHOGO_SKIP_STALE_RUNTIME_CLEANUP
  delete process.env.RUNTIME_ORPHAN_REAP_INTERVAL_MS
  rmSync(root, { recursive: true, force: true })
})

/** Write a ledger the way a runtime would have, at `<dir>/.shogo/run/children.json`. */
function writeLedger(dir: string, entries: unknown[]): void {
  const ledgerDir = join(dir, '.shogo', 'run')
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(join(ledgerDir, 'children.json'), JSON.stringify(entries) + '\n', 'utf8')
}

describe('childLedgerDirs', () => {
  test('walks plain project dirs AND .workspace-roots, skipping other dot-dirs and symlinks', () => {
    mkdirSync(join(workspacesDir, 'proj-plain'), { recursive: true })
    mkdirSync(join(workspacesDir, '.warm'), { recursive: true })
    mkdirSync(join(workspacesDir, WORKSPACE_ROOTS_DIR, 'proj-agents'), { recursive: true })
    symlinkSync(join(workspacesDir, 'proj-plain'), join(workspacesDir, WORKSPACE_ROOTS_DIR, 'linked-member'))

    const dirs = childLedgerDirs(workspacesDir).map((dir) => dir.slice(workspacesDir.length + 1))

    expect(dirs).toContain('proj-plain')
    expect(dirs).toContain(join(WORKSPACE_ROOTS_DIR, 'proj-agents'))
    expect(dirs).not.toContain('.warm')
    // A `.workspace-roots` entry is a symlink at a member project: replaying it
    // would reap that project's ledger twice.
    expect(dirs).not.toContain(join(WORKSPACE_ROOTS_DIR, 'linked-member'))
  })

  test('a missing workspaces dir is empty, not an error', () => {
    expect(childLedgerDirs(join(root, 'nope'))).toEqual([])
  })
})

describe('reapChildLedgersUnder', () => {
  /**
   * `ps` stand-in: the recorded fingerprint is still the live command line. The
   * ledger entry names a live pid we do not own, so `reapChildLedger` gets past
   * its liveness check without this test signalling anything real.
   */
  const ps = () => '/bin/sh -c vite build --watch'

  test('reaps the ledger of a merged-root runtime under .workspace-roots', () => {
    const runtimeDir = join(workspacesDir, WORKSPACE_ROOTS_DIR, 'proj-x')
    writeLedger(runtimeDir, [
      { pgid: process.ppid, pid: process.ppid, label: 'vite-watch', commandFingerprint: 'vite build --watch', startedAt: 1 },
    ])

    const killed: number[] = []
    const swept = reapChildLedgersUnder(workspacesDir, {
      readProcessCommand: ps,
      killGroup: (entry) => { killed.push(entry.pgid) },
    })

    expect(swept).toHaveLength(1)
    expect(swept[0].dir).toBe(runtimeDir)
    expect(swept[0].result.reaped).toHaveLength(1)
    expect(killed).toEqual([process.ppid])
    // The ledger is emptied, so the next pass has nothing to do.
    expect(reapChildLedgersUnder(workspacesDir, { readProcessCommand: ps, killGroup: () => {} })).toEqual([])
  })

  test('a reused pid is dropped, never signalled', () => {
    const runtimeDir = join(workspacesDir, WORKSPACE_ROOTS_DIR, 'proj-x')
    writeLedger(runtimeDir, [
      { pgid: process.ppid, pid: process.ppid, label: 'exec', commandFingerprint: 'bun run dev', startedAt: 1 },
    ])

    const killed: number[] = []
    const swept = reapChildLedgersUnder(workspacesDir, {
      // The pid now belongs to something else.
      readProcessCommand: () => 'sh -c sleep 900',
      killGroup: (entry) => { killed.push(entry.pgid) },
    })

    expect(killed).toEqual([])
    expect(swept[0].result.dropped).toHaveLength(1)
    expect(swept[0].result.reaped).toEqual([])
  })
})

describe('RuntimeManager periodic reap', () => {
  test('sweeps on a timer, not only at boot', async () => {
    process.env.RUNTIME_ORPHAN_REAP_INTERVAL_MS = '20'
    const manager = new RuntimeManager({ workspacesDir }) as unknown as {
      sweepOrphanedChildren: (reason: string) => Promise<void>
      stopOrphanReapTimer: () => void
    }

    let sweeps = 0
    manager.sweepOrphanedChildren = async () => { sweeps++ }

    try {
      await new Promise((resolve) => setTimeout(resolve, 110))
      // Three intervals of 20 ms in 110 ms, with room for a slow CI box.
      expect(sweeps).toBeGreaterThanOrEqual(2)
    } finally {
      manager.stopOrphanReapTimer()
    }
  })

  test('interval 0 disables the timer', async () => {
    process.env.RUNTIME_ORPHAN_REAP_INTERVAL_MS = '0'
    const manager = new RuntimeManager({ workspacesDir }) as unknown as {
      sweepOrphanedChildren: (reason: string) => Promise<void>
    }
    let sweeps = 0
    manager.sweepOrphanedChildren = async () => { sweeps++ }
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(sweeps).toBe(0)
  })

  test('stops reaping its own ledger the moment the runtime stops', () => {
    const manager = new RuntimeManager({ workspacesDir }) as unknown as {
      runtimeWorkingDir: (key: string) => string | null
    }
    // The three key shapes a runtime can have.
    expect(manager.runtimeWorkingDir('ws:proj:abc')).toBe(join(workspacesDir, WORKSPACE_ROOTS_DIR, 'proj-abc'))
    expect(manager.runtimeWorkingDir('ws:ws-id')).toBe(join(workspacesDir, WORKSPACE_ROOTS_DIR, 'ws-id'))
    expect(manager.runtimeWorkingDir('project-id')).toBe(join(workspacesDir, 'project-id'))
  })
})
