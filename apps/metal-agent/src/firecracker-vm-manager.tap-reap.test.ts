// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the orphan-TAP reclaimer. Each `fctap<n>` holds one of a host's
 * 16384 /30 blocks, and every VM removed without going through `stopVM` used to
 * leave its device behind — the leak that eventually exhausted the address space
 * in production and turned every /assign into `ip addr add 172.16.8282.225/30`.
 *
 * The reclaimer deletes host devices, so the interesting property is not "does it
 * delete" but "what can it never delete": a warm/assigned/suspended VM's tap, a
 * tap a firecracker still has open, or one just handed to a booting VM. Tests
 * drive the host-inventory and delete seams so no netlink call is made.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { FirecrackerVMManager } from './firecracker-vm-manager'
import type { HostTap } from './net'

const dirs: string[] = []

/** Manager with the host tap inventory + delete stubbed; records deletions. */
function makeMgr(taps: HostTap[]) {
  const dir = mkdtempSync(join(tmpdir(), 'fctap-'))
  dirs.push(dir)
  const deleted: string[] = []
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
  }
  class TestMgr extends FirecrackerVMManager {
    protected hostTaps(): HostTap[] {
      return taps
    }
    protected deleteTap(name: string): void {
      deleted.push(name)
      taps = taps.filter((t) => t.name !== name) // the device is gone now
    }
  }
  return { mgr: new TestMgr(cfg as any), deleted, setTaps: (t: HostTap[]) => (taps = t) }
}

const tap = (index: number, attached = false): HostTap => ({ index, name: `fctap${index}`, attached })

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('FirecrackerVMManager.reconcileOrphanTaps', () => {
  test('reclaims an unowned, unattached tap — but only on the second sweep', () => {
    const { mgr, deleted } = makeMgr([tap(7)])

    // First sighting only records suspicion: a single sweep is never enough,
    // so a tap that looks orphaned for one instant of bad bookkeeping survives.
    const first = mgr.reconcileOrphanTaps(new Set(), 1000)
    expect(first.removed).toBe(0)
    expect(first.suspected).toBe(1)
    expect(deleted).toEqual([])

    const second = mgr.reconcileOrphanTaps(new Set(), 1000)
    expect(second.removed).toBe(1)
    expect(deleted).toEqual(['fctap7'])
  })

  test('never touches a tap the pool still owns, however many sweeps run', () => {
    // 3 = warm/assigned VM, 4 = suspended VM (no process, tap deliberately kept).
    const { mgr, deleted } = makeMgr([tap(3, true), tap(4), tap(9)])
    const owned = new Set([3, 4])

    for (let i = 0; i < 5; i++) mgr.reconcileOrphanTaps(owned, 1000)

    expect(deleted).toEqual(['fctap9'])
  })

  test('never touches a tap a process still holds open, even if unowned', () => {
    // The kernel's own answer outranks our bookkeeping: NO-CARRIER is absent, so
    // a firecracker has this fd. If the pool has lost track of that VM, killing
    // its networking is strictly worse than leaking one /30.
    const { mgr, deleted } = makeMgr([tap(11, true)])

    for (let i = 0; i < 3; i++) mgr.reconcileOrphanTaps(new Set(), 1000)

    expect(deleted).toEqual([])
  })

  test('never touches an index just handed to a booting VM', () => {
    const { mgr, deleted, setTaps } = makeMgr([])
    const n = (mgr as any).nextVmIndex() as number
    // Mid-cold-boot: setupTap has run, the VM is in no pool map yet, and FC has
    // not opened the fd — the exact window a naive sweep would delete.
    setTaps([tap(n)])

    for (let i = 0; i < 3; i++) mgr.reconcileOrphanTaps(new Set(), 60_000)
    expect(deleted).toEqual([])

    // Wind the reservation back past the window: nothing ever claimed the index,
    // so the boot died somewhere and this is a real leak.
    ;(mgr as any).reservedAt.set(n, Date.now() - 120_000)
    mgr.reconcileOrphanTaps(new Set(), 60_000)
    mgr.reconcileOrphanTaps(new Set(), 60_000)
    expect(deleted).toEqual([`fctap${n}`])
  })

  test('a tap that stops looking orphaned loses its strike', () => {
    const { mgr, deleted, setTaps } = makeMgr([tap(5)])

    mgr.reconcileOrphanTaps(new Set(), 1000) // strike 1
    setTaps([tap(5, true)]) // a VM claimed index 5 (or was re-registered)
    mgr.reconcileOrphanTaps(new Set(), 1000)
    setTaps([tap(5)]) // unattached again — must start over, not delete
    mgr.reconcileOrphanTaps(new Set(), 1000)

    expect(deleted).toEqual([])
    expect(mgr.reconcileOrphanTaps(new Set(), 1000).removed).toBe(1)
  })

  test('bounded per sweep so a large backlog drains gradually', () => {
    const many = Array.from({ length: 10 }, (_, i) => tap(i))
    const { mgr, deleted } = makeMgr(many)

    mgr.reconcileOrphanTaps(new Set(), 1000, 4) // all 10 get a strike
    expect(deleted).toEqual([])
    expect(mgr.reconcileOrphanTaps(new Set(), 1000, 4).removed).toBe(4)
    expect(mgr.reconcileOrphanTaps(new Set(), 1000, 4).removed).toBe(4)
    expect(mgr.reconcileOrphanTaps(new Set(), 1000, 4).removed).toBe(2)
    expect(deleted).toHaveLength(10)
  })

  test('reports taps in use for the capacity gauge', () => {
    const { mgr } = makeMgr([tap(1, true), tap(2, true), tap(3)])

    expect(mgr.reconcileOrphanTaps(new Set([1, 2, 3]), 1000).inUse).toBe(3)
  })
})
