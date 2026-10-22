// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-144: the child ledger is advisory. It exists so a supervisor that
 * outlives the runtime can reap what the runtime started, and its one hard rule
 * is that a *stale* entry is never signalled — a pid that now belongs to an
 * unrelated process must be dropped, not killed.
 *
 * The entries are keyed on real pids (a live `sleep`), because the ledger's own
 * housekeeping prunes an entry whose process is already gone.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  addChildLedgerEntry,
  childLedgerPath,
  commandFingerprint,
  matchesFingerprint,
  readChildLedger,
  reapChildLedger,
  removeChildLedgerEntry,
  type ChildLedgerEntry,
} from '../child-ledger'

const dirs: string[] = []
const children: ChildProcess[] = []

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-ledger-'))
  dirs.push(dir)
  return dir
}

/** A real, live process whose pid an entry can safely point at. */
function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  })
  children.push(child)
  return child
}

function entryFor(child: ChildProcess, overrides: Partial<ChildLedgerEntry> = {}): ChildLedgerEntry {
  const pid = child.pid as number
  return {
    pgid: pid,
    pid,
    label: 'exec',
    commandFingerprint: `bash -c sleep 600 -- ${pid}`,
    startedAt: Date.now(),
    ...overrides,
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone, or no group of its own on Windows.
    }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('child ledger storage', () => {
  test('records, replaces by pid and removes an entry', () => {
    const workspace = tempWorkspace()
    const first = spawnSleeper()
    const second = spawnSleeper()
    addChildLedgerEntry(workspace, entryFor(first))
    addChildLedgerEntry(workspace, entryFor(second, { label: 'api-sidecar' }))
    expect(readChildLedger(workspace).map((e) => e.pid)).toEqual([first.pid, second.pid])

    removeChildLedgerEntry(workspace, first.pid as number)
    expect(readChildLedger(workspace).map((e) => e.pid)).toEqual([second.pid])
  })

  test('an entry whose process already exited is pruned by the next write', async () => {
    const workspace = tempWorkspace()
    const first = spawnSleeper()
    const second = spawnSleeper()
    addChildLedgerEntry(workspace, entryFor(first))
    const exited = new Promise<void>((resolve) => first.once('exit', () => resolve()))
    first.kill('SIGKILL')
    await exited
    addChildLedgerEntry(workspace, entryFor(second))
    expect(readChildLedger(workspace).map((e) => e.pid)).toEqual([second.pid])
  })

  test('a malformed ledger reads as empty instead of throwing', () => {
    const workspace = tempWorkspace()
    addChildLedgerEntry(workspace, entryFor(spawnSleeper()))
    writeFileSync(childLedgerPath(workspace), '{ not json', 'utf8')
    expect(readChildLedger(workspace)).toEqual([])
  })

  test('a fingerprint survives a long command and a re-rendered one', () => {
    const long = `bash -c ${'echo hi && '.repeat(60)}sleep 600`
    const fingerprint = commandFingerprint(long)
    expect(fingerprint.length).toBeLessThanOrEqual(160)
    const recorded: ChildLedgerEntry = {
      pgid: 1, pid: 1, label: 'exec', commandFingerprint: fingerprint, startedAt: 0,
    }
    expect(matchesFingerprint(long, recorded)).toBe(true)
    // `ps` pads and folds whitespace; the comparison must not care.
    expect(matchesFingerprint(`  ${long.replace(/ && /g, '   &&   ')}  `, recorded)).toBe(true)
    expect(matchesFingerprint('bun run server.tsx', recorded)).toBe(false)
  })
})

describe('reapChildLedger', () => {
  test('a stale entry whose pid now belongs to another process is never signalled', () => {
    const workspace = tempWorkspace()
    const alive = spawnSleeper()
    addChildLedgerEntry(workspace, entryFor(alive))
    const killed: number[] = []

    const result = reapChildLedger(workspace, {
      // The pid is alive, but it is not our process any more.
      readProcessCommand: () => '/usr/sbin/cupsd -l',
      killGroup: (e) => killed.push(e.pgid),
    })

    expect(killed).toEqual([])
    expect(result.reaped).toEqual([])
    expect(result.dropped.map((e) => e.pid)).toEqual([alive.pid])
    // The entry is gone, so no later pass can signal that pid either.
    expect(readChildLedger(workspace)).toEqual([])
  })

  test('an entry whose process is gone is dropped silently', () => {
    const workspace = tempWorkspace()
    const alive = spawnSleeper()
    addChildLedgerEntry(workspace, entryFor(alive))
    alive.kill('SIGKILL')
    const killed: number[] = []
    const result = reapChildLedger(workspace, {
      readProcessCommand: () => null,
      killGroup: (e) => killed.push(e.pgid),
    })
    expect(killed).toEqual([])
    expect(result.dropped.length).toBe(1)
    expect(readChildLedger(workspace)).toEqual([])
  })

  test('a matching entry is killed and removed; an unreadable one is kept for the next pass', () => {
    const workspace = tempWorkspace()
    const matching = spawnSleeper()
    const unreadable = spawnSleeper()
    addChildLedgerEntry(workspace, entryFor(matching))
    addChildLedgerEntry(workspace, entryFor(unreadable, { commandFingerprint: 'bun run server.tsx' }))
    const killed: number[] = []

    const result = reapChildLedger(workspace, {
      readProcessCommand: (pid) => {
        if (pid === matching.pid) return `/bin/bash -c sleep 600 -- ${pid}`
        // The process table could not be read for the other one.
        throw new Error('ps failed')
      },
      killGroup: (e) => killed.push(e.pgid),
    })

    expect(killed).toEqual([matching.pid as number])
    expect(result.reaped.map((e) => e.pid)).toEqual([matching.pid as number])
    // A failed lookup is not evidence of a reused pid: keep it and retry.
    expect(readChildLedger(workspace).map((e) => e.pid)).toEqual([unreadable.pid as number])
  })

  test('never signals our own group', () => {
    const workspace = tempWorkspace()
    mkdirSync(dirname(childLedgerPath(workspace)), { recursive: true })
    writeFileSync(
      childLedgerPath(workspace),
      JSON.stringify([{
        pgid: process.pid, pid: process.pid, label: 'exec',
        commandFingerprint: 'bun test', startedAt: Date.now(),
      }]),
      'utf8',
    )
    const killed: number[] = []
    reapChildLedger(workspace, {
      readProcessCommand: () => 'bun test',
      killGroup: (e) => killed.push(e.pgid),
    })
    expect(killed).toEqual([])
  })
})
