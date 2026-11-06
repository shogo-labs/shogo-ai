// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-349 — per-project workspace-drive sizing.
 *
 * Pure logic only (no DB, no VM): the plan ceiling, the never-shrink clamp, the
 * route's validation and the response the Settings panel reads. The substrate
 * behaviour (a drive actually growing on a live guest) is the staging e2e.
 */

import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_WORKSPACE_DISK_GIB,
  MAX_WORKSPACE_DISK_GIB,
  resolveWorkspaceDiskMiB,
  workspaceDiskCeilingGiB,
} from '../config/instance-sizes'
import {
  describeProjectDisk,
  instanceMinScale,
  planDiskChange,
  readRuntimeDiskUsage,
} from '../services/project-disk.service'
import { diskStringToMiB } from '../lib/metal-warm-pool-controller'

describe('resolveWorkspaceDiskMiB', () => {
  it('uses the fleet default when the project never asked', () => {
    expect(resolveWorkspaceDiskMiB(null, 'micro')).toBe(DEFAULT_WORKSPACE_DISK_GIB * 1024)
    expect(resolveWorkspaceDiskMiB(undefined, 'large')).toBe(DEFAULT_WORKSPACE_DISK_GIB * 1024)
  })

  it('honours a request inside the tier ceiling', () => {
    expect(resolveWorkspaceDiskMiB(40, 'medium')).toBe(40 * 1024)
    expect(resolveWorkspaceDiskMiB(80, 'large')).toBe(80 * 1024)
  })

  it('never shrinks below the default, even when asked to', () => {
    // ext4 cannot shrink online and the drive is sparse: a smaller request only
    // caps future growth, it does not give space back.
    expect(resolveWorkspaceDiskMiB(5, 'medium')).toBe(DEFAULT_WORKSPACE_DISK_GIB * 1024)
    expect(resolveWorkspaceDiskMiB(0, 'medium')).toBe(DEFAULT_WORKSPACE_DISK_GIB * 1024)
    expect(resolveWorkspaceDiskMiB(-10, 'medium')).toBe(DEFAULT_WORKSPACE_DISK_GIB * 1024)
  })

  it('clamps to the tier after a downgrade', () => {
    // A project that asked for 80 GiB while on `large` keeps 80 GiB of drive;
    // the micro ceiling only caps what it may ask for NEXT.
    expect(resolveWorkspaceDiskMiB(80, 'micro')).toBe(workspaceDiskCeilingGiB('micro') * 1024)
    expect(resolveWorkspaceDiskMiB(80, 'micro')).toBe(20 * 1024)
  })

  it('never exceeds the fleet hard cap', () => {
    for (const size of ['micro', 'small', 'medium', 'large', 'xlarge'] as const) {
      expect(workspaceDiskCeilingGiB(size)).toBeLessThanOrEqual(MAX_WORKSPACE_DISK_GIB)
      expect(workspaceDiskCeilingGiB(size)).toBeGreaterThanOrEqual(DEFAULT_WORKSPACE_DISK_GIB)
    }
  })
})

describe('planDiskChange', () => {
  it('accepts a size inside the ceiling and floors it at the default', () => {
    expect(planDiskChange(40, 'medium')).toEqual({ ok: true, sizeGiB: 40 })
    expect(planDiskChange(12, 'medium')).toEqual({ ok: true, sizeGiB: DEFAULT_WORKSPACE_DISK_GIB })
    expect(planDiskChange('40', 'medium')).toEqual({ ok: true, sizeGiB: 40 })
  })

  it('rejects anything above the tier ceiling with a readable message', () => {
    const plan = planDiskChange(120, 'medium')
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.status).toBe(422)
      expect(plan.code).toBe('plan_ceiling')
      expect(plan.message).toContain('40 GiB')
    }
  })

  it('rejects a non-numeric or non-positive size', () => {
    expect(planDiskChange('lots', 'medium').ok).toBe(false)
    expect(planDiskChange(undefined, 'medium').ok).toBe(false)
    expect(planDiskChange(0, 'medium').ok).toBe(false)
  })
})

describe('describeProjectDisk', () => {
  it('reports the effective size, the ceiling and whether it can grow', () => {
    const body = describeProjectDisk({ requestedGiB: 30, instanceSize: 'medium', substrate: 'metal' })
    expect(body.requestedGiB).toBe(30)
    expect(body.effectiveGiB).toBe(30)
    expect(body.defaultGiB).toBe(DEFAULT_WORKSPACE_DISK_GIB)
    expect(body.maxGiB).toBe(40)
    expect(body.canIncrease).toBe(true)
    expect(body.usage).toBeNull()
    expect(body.substrate).toBe('metal')
  })

  it('pins canIncrease=false with a reason at the ceiling', () => {
    const body = describeProjectDisk({ requestedGiB: 40, instanceSize: 'medium', substrate: 'metal' })
    expect(body.canIncrease).toBe(false)
    expect(body.reason).toBe('plan_ceiling')
  })

  it('passes measured usage through with a timestamp', () => {
    const measuredAt = new Date('2026-11-06T00:00:00Z')
    const body = describeProjectDisk({
      requestedGiB: null,
      instanceSize: 'micro',
      substrate: 'metal',
      usage: { usedBytes: 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
      measuredAt,
    })
    expect(body.usage).toEqual({
      usedBytes: 1024 ** 3,
      totalBytes: 20 * 1024 ** 3,
      measuredAt: '2026-11-06T00:00:00.000Z',
    })
  })
})

describe('instanceMinScale', () => {
  it('keeps always-on tiers always-on through a disk change', () => {
    expect(instanceMinScale('micro')).toBe(0)
    expect(instanceMinScale('medium')).toBe(1)
  })
})

describe('diskStringToMiB', () => {
  it('parses the quantities the resize path sends', () => {
    expect(diskStringToMiB('40Gi')).toBe(40 * 1024)
    expect(diskStringToMiB('40960Mi')).toBe(40960)
    expect(diskStringToMiB('20')).toBe(20)
  })

  it('returns undefined for anything it cannot trust', () => {
    expect(diskStringToMiB(undefined)).toBeUndefined()
    expect(diskStringToMiB('')).toBeUndefined()
    expect(diskStringToMiB('lots')).toBeUndefined()
    expect(diskStringToMiB('-5Gi')).toBeUndefined()
  })
})

describe('readRuntimeDiskUsage (passive)', () => {
  const okFetch = (body: unknown, calls: string[]): typeof fetch =>
    (async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

  it('never wakes a project: no URL means no request at all', async () => {
    // AC 8 — opening Settings → Disk on a sleeping project must not cold-boot a
    // VM. The passive resolver answers undefined, so nothing is fetched.
    const calls: string[] = []
    const usage = await readRuntimeDiskUsage('p1', 'ws-1', {
      peekUrl: () => undefined,
      token: () => 'tok',
      fetchImpl: okFetch({ usedBytes: 1, totalBytes: 2 }, calls),
    })
    expect(usage).toBeNull()
    expect(calls).toEqual([])
  })

  it('reads statfs from a runtime that is already up', async () => {
    const calls: string[] = []
    const usage = await readRuntimeDiskUsage('p1', 'ws-1', {
      peekUrl: () => 'http://10.0.0.5:8080/',
      token: () => 'tok',
      fetchImpl: okFetch({ usedBytes: 3 * 1024 ** 3, totalBytes: 40 * 1024 ** 3 }, calls),
    })
    expect(calls).toEqual(['http://10.0.0.5:8080/pool/workspace-drive'])
    expect(usage).toEqual({ usedBytes: 3 * 1024 ** 3, totalBytes: 40 * 1024 ** 3 })
  })

  it('answers null for a non-2xx or a malformed body instead of throwing', async () => {
    const notOk = (async () => new Response('nope', { status: 409 })) as unknown as typeof fetch
    expect(
      await readRuntimeDiskUsage('p1', 'ws-1', {
        peekUrl: () => 'http://10.0.0.5:8080',
        token: () => 'tok',
        fetchImpl: notOk,
      }),
    ).toBeNull()
    const junk = okFetch({ used: 1 }, [])
    expect(
      await readRuntimeDiskUsage('p1', 'ws-1', {
        peekUrl: () => 'http://10.0.0.5:8080',
        token: () => 'tok',
        fetchImpl: junk,
      }),
    ).toBeNull()
  })
})
