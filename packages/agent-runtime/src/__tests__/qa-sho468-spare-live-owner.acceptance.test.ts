// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-468 real-process acceptance test.
 *
 * The timer orphan sweep must NOT kill children whose ownerPid is still alive.
 * This test:
 *   1. Spawns a real `sleep` and records it in a temp ledger with
 *      ownerPid = process.pid (us) + our ownerFingerprint.
 *   2. Runs `reapChildLedger` with `spareLiveOwners: true, reapOwnerless: false`
 *      (the timer opts) → `sleep` must still be running.
 *   3. Rewrites the ledger entry with a dead ownerPid.
 *   4. Runs the sweep again → `sleep` is now reaped.
 *
 * This test fails on `main` before SHO-468 because `addChildLedgerEntry` does
 * not stamp `ownerPid`, so `spareLiveOwners` has nothing to compare against and
 * falls through to the default reap — killing the live job.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  addChildLedgerEntry,
  childLedgerPath,
  reapChildLedger,
  type ChildLedgerEntry,
} from '@shogo-ai/sdk/child-ledger'

const IS_WINDOWS = process.platform === 'win32'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sho468-'))
  dirs.push(d)
  return d
}

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe.skipIf(IS_WINDOWS)('SHO-468: timer sweep spares live-owner children', () => {
  test('a live child whose owner is running is not reaped by the timer sweep', async () => {
    const workspaceDir = tempDir()

    // Spawn a real `sleep` that will outlive this test without a SIGKILL.
    const child = spawn('sleep', ['1500'], {
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
    const childPid = child.pid as number

    // Record the child — addChildLedgerEntry stamps ownerPid = process.pid.
    addChildLedgerEntry(workspaceDir, {
      pgid: childPid,
      pid: childPid,
      label: 'exec',
      commandFingerprint: 'sleep 1500',
      startedAt: Date.now(),
    })

    // Confirm the child is alive before the sweep.
    expect(isAlive(childPid)).toBe(true)

    // Run with timer opts: spareLiveOwners=true, reapOwnerless=false.
    const result1 = reapChildLedger(workspaceDir, {
      spareLiveOwners: true,
      reapOwnerless: false,
    })

    // Child must be spared — it belongs to us (process.pid), still alive.
    expect(result1.reaped).toHaveLength(0)
    expect(result1.spared).toHaveLength(1)
    expect(isAlive(childPid)).toBe(true)

    // Now rewrite the entry with a dead ownerPid to simulate an orphan.
    const ledgerPath = childLedgerPath(workspaceDir)
    const deadEntry: ChildLedgerEntry = {
      pgid: childPid,
      pid: childPid,
      label: 'exec',
      commandFingerprint: 'sleep 1500',
      startedAt: Date.now(),
      ownerPid: 99999999,
      ownerFingerprint: 'dead-runtime',
    }
    mkdirSync(dirname(ledgerPath), { recursive: true })
    writeFileSync(ledgerPath, JSON.stringify([deadEntry]) + '\n', 'utf8')

    // A second sweep: dead owner → child is now a true orphan → reaped.
    const result2 = reapChildLedger(workspaceDir, {
      spareLiveOwners: true,
      reapOwnerless: false,
    })

    expect(result2.reaped).toHaveLength(1)
    expect(result2.spared).toHaveLength(0)

    // Give the SIGKILL a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(isAlive(childPid)).toBe(false)
  })
})
