// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — writable-state retention: the large-database cadence limit and the
 * end-of-day restore points (`{id}/project-data/daily/<date>.tar.gz`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import { utcDate, type DailyCopyResult, type DataLineage, type DataWriteOutcome } from './project-data-archive'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any
const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000

class TestPool extends MetalWarmPool {
  events: string[] = []
  copyResult: DailyCopyResult | Error = 'copied'

  protected override async uploadDataGuarded(
    projectId: string,
    _bytes: Uint8Array,
    _opts: { lineage: DataLineage; preserveOnRefusal?: boolean },
  ): Promise<DataWriteOutcome> {
    this.events.push(`upload ${projectId}`)
    return { status: 'written', etag: `"${projectId}-new"` }
  }

  protected override async copyDataToDaily(projectId: string, date: string): Promise<DailyCopyResult> {
    this.events.push(`copy ${projectId} ${date}`)
    if (this.copyResult instanceof Error) throw this.copyResult
    return this.copyResult
  }

  add(projectId: string, extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = {
      projectId,
      handle: HANDLE,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(projectId, a)
    return a
  }
}

function makePool(dir: string, over: Partial<typeof config> = {}): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    projectDataLargeBytes: 100 * MB,
    projectDataLargeMinIntervalMs: 15 * 60 * 1000,
    ...over,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0 } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

/** A guest whose every export returns fresh bytes of `size`. */
function changingGuest(size = 4) {
  let n = 0
  globalThis.fetch = mock(async () => {
    n++
    return new Response(new Uint8Array(size), { status: 200, headers: { ETag: `t${n}` } })
  }) as any
}

describe('writable-state retention', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-data-retention-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  describe('large-database cadence limit', () => {
    test('a large archive uploaded recently skips the periodic export entirely', async () => {
      const pool = makePool(dir)
      const a = pool.add('p1', {
        dataParentEtag: '"e"',
        dataLastDailyCopyDate: utcDate(Date.now()),
        dataLastBytes: 200 * MB,
        dataLastUploadAt: Date.now() - 60_000,
      })
      const fetchSpy = mock(async () => new Response(new Uint8Array(4), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      expect(await pool.saveProjectDataToStore(a)).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(pool.events).toEqual([])
    })

    test('a large archive uploads again once the interval has passed', async () => {
      const pool = makePool(dir)
      const a = pool.add('p1', {
        dataParentEtag: '"e"',
        dataLastDailyCopyDate: utcDate(Date.now()),
        dataLastBytes: 200 * MB,
        dataLastUploadAt: Date.now() - 16 * 60_000,
      })
      changingGuest()
      expect(await pool.saveProjectDataToStore(a)).toBe(true)
      expect(pool.events).toEqual(['upload p1'])
      expect(a.dataLastBytes).toBe(4)
    })

    test('final and recycle exports are never limited', async () => {
      const pool = makePool(dir)
      const recent = {
        dataParentEtag: '"e"',
        dataLastDailyCopyDate: utcDate(Date.now()),
        dataLastBytes: 200 * MB,
        dataLastUploadAt: Date.now() - 60_000,
      }
      changingGuest()
      expect(await pool.saveProjectDataToStore(pool.add('p1', recent), { final: true })).toBe(true)
      expect(
        await pool.saveProjectDataToStore(pool.add('p2', recent), { final: true, reason: 'recycle' }),
      ).toBe(true)
      expect(pool.events).toEqual(['upload p1', 'upload p2'])
    })

    test('small databases keep the normal cadence', async () => {
      const pool = makePool(dir)
      const a = pool.add('p1', {
        dataParentEtag: '"e"',
        dataLastDailyCopyDate: utcDate(Date.now()),
        dataLastBytes: 5 * MB,
        dataLastUploadAt: Date.now() - 1000,
      })
      changingGuest()
      expect(await pool.saveProjectDataToStore(a)).toBe(true)
    })

    test('applies per workspace member', async () => {
      const pool = makePool(dir)
      const today = utcDate(Date.now())
      const a = pool.add('ws:w1', {
        workspaceMemberIds: ['big', 'small'],
        memberData: {
          big: { parentEtag: '"b"', lastBytes: 300 * MB, lastUploadAt: Date.now() - 1000, lastDailyCopyDate: today },
          small: { parentEtag: '"s"', lastBytes: 1 * MB, lastUploadAt: Date.now() - 1000, lastDailyCopyDate: today },
        },
      })
      changingGuest()
      await pool.saveProjectDataToStore(a)
      expect(pool.events).toEqual(['upload small'])
    })
  })

  describe('daily restore points', () => {
    test("the first upload of a new UTC day copies yesterday's final state first", async () => {
      const pool = makePool(dir)
      const now = Date.now()
      const a = pool.add('p1', { dataParentEtag: '"e"', dataLastDailyCopyDate: utcDate(now - DAY) })
      changingGuest()
      await pool.saveProjectDataToStore(a)
      expect(pool.events).toEqual([`copy p1 ${utcDate(now - DAY)}`, 'upload p1'])
      expect(a.dataLastDailyCopyDate).toBe(utcDate(now))

      // Later uploads the same day overwrite in place, with no further copies.
      await pool.saveProjectDataToStore(a)
      expect(pool.events.filter((e) => e.startsWith('copy'))).toHaveLength(1)
    })

    test('an existing restore point counts as done (e.g. after a resume)', async () => {
      const pool = makePool(dir)
      pool.copyResult = 'exists'
      const a = pool.add('p1', { dataParentEtag: '"e"' })
      changingGuest()
      await pool.saveProjectDataToStore(a)
      expect(a.dataLastDailyCopyDate).toBe(utcDate(Date.now()))
    })

    test('a failed copy never blocks the backup, and retries next cycle', async () => {
      const pool = makePool(dir)
      pool.copyResult = new Error('503 slow down')
      const a = pool.add('p1', { dataParentEtag: '"e"' })
      changingGuest()
      expect(await pool.saveProjectDataToStore(a)).toBe(true)
      expect(a.dataLastDailyCopyDate).toBeUndefined()

      pool.copyResult = 'copied'
      await pool.saveProjectDataToStore(a)
      expect(pool.events.filter((e) => e.startsWith('copy'))).toHaveLength(2)
      expect(a.dataLastDailyCopyDate).toBe(utcDate(Date.now()))
    })

    test('a project with no archive yet has nothing to copy', async () => {
      const pool = makePool(dir)
      const a = pool.add('p1')
      changingGuest()
      await pool.saveProjectDataToStore(a)
      expect(pool.events).toEqual(['upload p1'])
    })

    test('workspace members get their own restore points', async () => {
      const pool = makePool(dir)
      const a = pool.add('ws:w1', {
        workspaceMemberIds: ['m1'],
        memberData: { m1: { parentEtag: '"m"' } },
      })
      changingGuest()
      await pool.saveProjectDataToStore(a)
      expect(pool.events).toEqual([`copy m1 ${utcDate(Date.now() - DAY)}`, 'upload m1'])
      expect(a.memberData?.m1.lastDailyCopyDate).toBe(utcDate(Date.now()))
    })
  })
})
