// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `FirecrackerVMManager.reclaimIdle` / `deflate` — the one balloon-inflate path,
 * shared by the idle reaper and the pre-snapshot reclaim (SHO-534).
 *
 * Driven through the real FcApi against a stubbed `fetch`, so these pin the wire
 * bodies Firecracker sees (the PATCH /balloon target and the stats reads) rather
 * than a mocked-out balloon: the sizing rules only matter if they reach FC.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { FirecrackerVMManager, type FcVmHandle } from './firecracker-vm-manager'

const dirs: string[] = []

function makeMgr() {
  const dir = mkdtempSync(join(tmpdir(), 'fc-reclaim-'))
  dirs.push(dir)
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    balloonPollMs: 1,
  }
  return new FirecrackerVMManager(cfg as typeof config)
}

function handle(memoryMB = 4096): FcVmHandle {
  return { id: 'vm1', socketPath: '/tmp/fake.sock', memoryMB } as unknown as FcVmHandle
}

interface Call {
  method?: string
  path: string
  body?: any
}

/**
 * Stub FC: `stats` is read on every GET /balloon/statistics (the last element
 * repeats), and every PATCH /balloon target is recorded. `null` = no stats, the
 * agent-booted-without-stats case (FC answers 400 on that path).
 */
function stubFc(stats: Array<{ targetMib: number; actualMib: number; availableMib: number; freeMib: number }> | null) {
  const realFetch = globalThis.fetch
  const calls: Call[] = []
  const patches: number[] = []
  let statReads = 0
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const path = String(url).replace(/^http:\/\/localhost/, '')
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, path, body })
    if (path === '/balloon/statistics') {
      if (!stats) return new Response('no balloon device', { status: 400 })
      const s = stats[Math.min(statReads++, stats.length - 1)]
      return new Response(
        JSON.stringify({
          target_mib: s.targetMib,
          actual_mib: s.actualMib,
          available_memory: s.availableMib * 1024 * 1024,
          free_memory: s.freeMib * 1024 * 1024,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (path === '/balloon' && init.method === 'PATCH') patches.push(body.amount_mib)
    return new Response(null, { status: 204 })
  }) as any
  return {
    calls,
    patches,
    statReadCount: () => statReads,
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('reclaimIdle', () => {
  test('inflates what the guest can spare, leaving the floor as headroom', async () => {
    // 4 GiB guest, 3.6 GiB available, 256 MiB floor → target 3344 MiB.
    const fc = stubFc([{ targetMib: 0, actualMib: 0, availableMib: 3600, freeMib: 900 }])
    try {
      const r = await makeMgr().reclaimIdle(handle(), { floorMiB: 256, maxWaitMs: 0 })
      expect(r).toEqual({ reclaimedMiB: 3344, increasedMiB: 3344, statsAvailable: true })
      expect(fc.patches).toEqual([3344])
    } finally {
      fc.restore()
    }
  })

  test('never lowers a target the VM already has (idle VM topped up before its snapshot)', async () => {
    // Already reclaimed to 3344 and mostly empty: a fresh stats read sees little
    // available. Re-computing blindly would set a SMALLER target, handing RAM
    // back to the guest right before it is snapshotted.
    const fc = stubFc([{ targetMib: 3344, actualMib: 3344, availableMib: 300, freeMib: 100 }])
    try {
      const r = await makeMgr().reclaimIdle(handle(), { floorMiB: 256, maxWaitMs: 0 })
      expect(r.reclaimedMiB).toBe(3344)
      expect(r.increasedMiB).toBe(0) // nothing newly taken from the guest
      expect(fc.patches).toEqual([])
    } finally {
      fc.restore()
    }
  })

  test('skips a VM with no balloon stats — never a blind inflate', async () => {
    const fc = stubFc(null)
    try {
      const r = await makeMgr().reclaimIdle(handle(), { floorMiB: 256, maxWaitMs: 0 })
      expect(r).toEqual({ reclaimedMiB: 0, increasedMiB: 0, statsAvailable: false })
      expect(fc.patches).toEqual([])
    } finally {
      fc.restore()
    }
  })

  test('a guest with nothing above the floor is left alone', async () => {
    const fc = stubFc([{ targetMib: 0, actualMib: 0, availableMib: 200, freeMib: 60 }])
    try {
      const r = await makeMgr().reclaimIdle(handle(), { floorMiB: 256, maxWaitMs: 0 })
      expect(r).toEqual({ reclaimedMiB: 0, increasedMiB: 0, statsAvailable: true })
      expect(fc.patches).toEqual([])
    } finally {
      fc.restore()
    }
  })

  test('with no wait budget it sets the target and returns (a reaper tick cannot stall)', async () => {
    const fc = stubFc([{ targetMib: 0, actualMib: 0, availableMib: 3600, freeMib: 900 }])
    try {
      await makeMgr().reclaimIdle(handle(), { floorMiB: 256, maxWaitMs: 0 })
      // one stats read to size the target, one PATCH — no polling after it
      expect(fc.statReadCount()).toBe(1)
      expect(fc.patches).toEqual([3344])
    } finally {
      fc.restore()
    }
  })

  test('the snapshot path waits for the driver to converge', async () => {
    // The driver hands pages back over several reads; the poll stops as soon as
    // `actual` reaches the target, so the pause that follows sees reclaimed RAM.
    const fc = stubFc([
      { targetMib: 0, actualMib: 0, availableMib: 3600, freeMib: 900 },
      { targetMib: 3344, actualMib: 64, availableMib: 3600, freeMib: 900 },
      { targetMib: 3344, actualMib: 1800, availableMib: 3600, freeMib: 900 },
      { targetMib: 3344, actualMib: 3344, availableMib: 3600, freeMib: 900 },
    ])
    try {
      const r = await makeMgr().reclaimIdle(handle(), { floorMiB: 256, maxWaitMs: 5_000 })
      expect(r.reclaimedMiB).toBe(3344)
      expect(fc.patches).toEqual([3344])
      expect(fc.statReadCount()).toBeGreaterThan(1)
    } finally {
      fc.restore()
    }
  })

  test('a VM an idle pass already ballooned is waited out, not re-inflated', async () => {
    // The idle pass sets a target and returns (no wait); the snapshot that follows
    // must still wait for the guest to actually hand the pages over, or the mem
    // image is written with RAM still resident.
    const fc = stubFc([
      { targetMib: 3344, actualMib: 200, availableMib: 300, freeMib: 100 },
      { targetMib: 3344, actualMib: 900, availableMib: 300, freeMib: 100 },
      { targetMib: 3344, actualMib: 3344, availableMib: 300, freeMib: 100 },
    ])
    try {
      const r = await makeMgr().reclaimIdle(handle(), { floorMiB: 256, maxWaitMs: 5_000 })
      expect(r.reclaimedMiB).toBe(3344)
      expect(r.increasedMiB).toBe(0)
      expect(fc.patches).toEqual([]) // never lowered, never re-sent
      expect(fc.statReadCount()).toBeGreaterThan(1) // but it did wait
    } finally {
      fc.restore()
    }
  })
})

describe('deflate', () => {
  test('returns every ballooned page to the guest', async () => {
    const fc = stubFc([{ targetMib: 3344, actualMib: 3344, availableMib: 300, freeMib: 100 }])
    try {
      await makeMgr().deflate(handle())
      expect(fc.patches).toEqual([0])
    } finally {
      fc.restore()
    }
  })
})
