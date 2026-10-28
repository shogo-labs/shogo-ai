// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-26: `bun dev:all` clears its API/web ports with `kill -9`. That is
 * correct for a leftover dev stack and fatal for the running Shogo desktop
 * app, whose long-lived API child owns port 39100 and is not respawned by
 * anything except the app itself.
 *
 * These tests pin the guard: a pid recorded in `<SHOGO_DATA_DIR>/api.pid` is
 * never signalled, and everything else on the port still is.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readProtectedPids } from '../lib/protected-pids'
import { killPidsOnPort } from '../dev-all'

describe('readProtectedPids', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = join(
      tmpdir(),
      `shogo-protected-pids-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(dataDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('reads the desktop app API pid from $SHOGO_DATA_DIR/api.pid', () => {
    writeFileSync(join(dataDir, 'api.pid'), '4321\n')

    expect([...readProtectedPids({ SHOGO_DATA_DIR: dataDir })]).toEqual([4321])
  })

  test('is empty when SHOGO_DATA_DIR is unset (not running under the app)', () => {
    expect(readProtectedPids({}).size).toBe(0)
  })

  test('is empty when the pid file is missing', () => {
    expect(readProtectedPids({ SHOGO_DATA_DIR: dataDir }).size).toBe(0)
  })

  test('ignores a garbage pid file instead of throwing', () => {
    writeFileSync(join(dataDir, 'api.pid'), 'not-a-pid')

    expect(readProtectedPids({ SHOGO_DATA_DIR: dataDir }).size).toBe(0)
  })
})

describe('killPidsOnPort', () => {
  test('refuses to signal the desktop app pid and kills the rest', async () => {
    const killed: number[] = []
    const warnings: string[] = []
    const protectedPids = new Set([4321])

    const result = await killPidsOnPort(8002, {
      listPids: async () => [4321, 9999],
      killPid: (pid) => killed.push(pid),
      protectedPids,
      log: (message) => warnings.push(message),
    })

    expect(killed).toEqual([9999])
    expect(result.killed).toEqual([9999])
    expect(result.spared).toEqual([4321])
    expect(warnings.join('\n')).toContain('held by the running Shogo desktop app')
    expect(warnings.join('\n')).toContain('4321')
  })

  test('still kills every listener when nothing is protected', async () => {
    const killed: number[] = []

    const result = await killPidsOnPort(8002, {
      listPids: async () => [1111, 2222],
      killPid: (pid) => killed.push(pid),
      log: () => {},
    })

    expect(killed).toEqual([1111, 2222])
    expect(result.spared).toEqual([])
  })

  test('an already-dead pid does not abort the sweep', async () => {
    const killed: number[] = []

    const result = await killPidsOnPort(8002, {
      listPids: async () => [1111, 2222],
      killPid: (pid) => {
        if (pid === 1111) throw new Error('ESRCH')
        killed.push(pid)
      },
      log: () => {},
    })

    expect(killed).toEqual([2222])
  })
})
