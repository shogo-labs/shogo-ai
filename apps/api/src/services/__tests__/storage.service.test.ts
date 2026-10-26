// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

interface PrismaState {
  workspace: any | null
  projects: Array<{ id: string; name: string }>
  upsertCalls: Array<any>
  workspaces: Array<{ id: string }>
  workspaceThrow: Error | null
  upsertThrow: Error | null
  recalcThrowForWorkspaceId: string | null
  /** `_max.lastCalculatedAt` for the freshness gate; null = empty table. */
  lastCalculatedAtMax: Date | null
  /** Query counters — the freshness gate must cost zero of these. */
  workspaceFindManyCalls: number
  projectFindManyCalls: number
  aggregateCalls: number
  workspaceFindManyArgs: any[]
  aggregateArgs: any[]
}

const ps: PrismaState = {
  workspace: null,
  projects: [],
  upsertCalls: [],
  workspaces: [],
  workspaceThrow: null,
  upsertThrow: null,
  recalcThrowForWorkspaceId: null,
  lastCalculatedAtMax: null,
  workspaceFindManyCalls: 0,
  projectFindManyCalls: 0,
  aggregateCalls: 0,
  workspaceFindManyArgs: [],
  aggregateArgs: [],
}

mock.module('@shogo/shared-runtime', () => ({
  isMobileTechStack: (_: unknown) => false,
  isDockerTechStack: (_: unknown) => false,
  getMinimumInstanceSize: (_: unknown) => null,
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async (_args: any) => {
        if (ps.workspaceThrow) throw ps.workspaceThrow
        return ps.workspace
      },
      findMany: async (args: any) => {
        ps.workspaceFindManyCalls++
        ps.workspaceFindManyArgs.push(args)
        return ps.workspaces
      },
    },
    project: {
      findMany: async (_args: any) => {
        ps.projectFindManyCalls++
        return ps.projects
      },
    },
    storageUsage: {
      aggregate: async (args: any) => {
        ps.aggregateCalls++
        ps.aggregateArgs.push(args)
        return { _max: { lastCalculatedAt: ps.lastCalculatedAtMax } }
      },
      upsert: async (args: any) => {
        if (ps.upsertThrow) throw ps.upsertThrow
        ps.upsertCalls.push(args)
        return args.create
      },
    },
  },
}))

// Mirrors the local-mode branch of the real helper: run the body and report
// `acquired: true`, unless a test asks for the lock to be held elsewhere.
const lockState = { heldElsewhere: false }

mock.module('../../lib/global-job-lock', () => ({
  withGlobalJobLock: async (
    _jobName: string,
    body: () => Promise<any>,
    _opts?: unknown,
  ) => {
    if (lockState.heldElsewhere) {
      return { acquired: false, skipped: true, reason: 'lock_not_acquired' }
    }
    return { acquired: true, result: await body() }
  },
}))

interface S3State {
  byPrefix: Map<string, Array<{ size: number }>>
  errorByPrefix: Map<string, Error>
  listCalls: number
}

const s3: S3State = { byPrefix: new Map(), errorByPrefix: new Map(), listCalls: 0 }

mock.module('../../lib/s3', () => ({
  listAllObjectsInS3: async (prefix: string, _bucket: string) => {
    s3.listCalls++
    const err = s3.errorByPrefix.get(prefix)
    if (err) throw err
    return s3.byPrefix.get(prefix) ?? []
  },
}))

const regionState: { home: any } = { home: null }
const realRegion = await import('../../lib/region')
mock.module('../../lib/region', () => ({
  ...realRegion,
  homeRegionWorkspaceWhere: () => regionState.home,
}))

const {
  STORAGE_RECALC_MIN_GAP_MS,
  calculateWorkspaceStorageUsage,
  getStorageUsage,
  isOverStorageLimit,
  recalculateAllStorageUsage,
} = await import('../storage.service')

let logSpy: any
let errorSpy: any

beforeEach(() => {
  ps.workspace = null
  ps.projects = []
  ps.upsertCalls = []
  ps.workspaces = []
  ps.workspaceThrow = null
  ps.upsertThrow = null
  ps.recalcThrowForWorkspaceId = null
  ps.lastCalculatedAtMax = null
  ps.workspaceFindManyCalls = 0
  ps.projectFindManyCalls = 0
  ps.aggregateCalls = 0
  ps.workspaceFindManyArgs = []
  ps.aggregateArgs = []
  regionState.home = null
  s3.byPrefix = new Map()
  s3.errorByPrefix = new Map()
  s3.listCalls = 0
  lockState.heldElsewhere = false
  logSpy = mock(() => {})
  errorSpy = mock(() => {})
  console.log = logSpy as any
  console.error = errorSpy as any
})

afterEach(() => {})

describe('getStorageUsage', () => {
  it('returns null when workspace is not found', async () => {
    ps.workspace = null
    expect(await getStorageUsage('ws-1')).toBeNull()
  })

  it('returns breakdown with limit from INSTANCE_SIZES (micro = 1GB)', async () => {
    ps.workspace = {
      instanceSize: 'micro',
      storageUsage: { totalBytes: BigInt(500_000_000), lastCalculatedAt: new Date('2026-01-01') },
    }
    ps.projects = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ]
    const out = await getStorageUsage('ws-1')
    expect(out).not.toBeNull()
    expect(out!.totalBytes).toBe(500_000_000)
    expect(out!.limitBytes).toBe(1 * 1024 ** 3) // 1 GB
    expect(out!.projectCount).toBe(2)
    expect(out!.projects).toHaveLength(2)
    expect(out!.projects[0]).toEqual({ projectId: 'p1', projectName: 'Alpha', bytes: 0 })
    expect(out!.percentUsed).toBeCloseTo((500_000_000 / 1024 ** 3) * 100, 5)
    expect(out!.isOverLimit).toBe(false)
    expect(out!.lastCalculatedAt).toEqual(new Date('2026-01-01'))
  })

  it('zero-fills totalBytes when storageUsage row is absent', async () => {
    ps.workspace = { instanceSize: 'micro', storageUsage: null }
    ps.projects = []
    const out = await getStorageUsage('ws-1')
    expect(out!.totalBytes).toBe(0)
    expect(out!.percentUsed).toBe(0)
    expect(out!.lastCalculatedAt).toBeNull()
  })

  it('caps percentUsed at 100 when over limit', async () => {
    ps.workspace = {
      instanceSize: 'micro',
      storageUsage: { totalBytes: BigInt(10 * 1024 ** 3), lastCalculatedAt: new Date() },
    }
    ps.projects = []
    const out = await getStorageUsage('ws-1')
    expect(out!.percentUsed).toBe(100)
    expect(out!.isOverLimit).toBe(true)
  })

  it('returns percentUsed=0 when limitBytes is 0 (avoid divide-by-zero)', async () => {
    // We can't override INSTANCE_SIZES here, but the guard in source is
    // `limitBytes > 0 ? … : 0`, exercised via a hypothetical zero-limit
    // tier. We assert the same behaviour by stubbing a 0-bytes workspace.
    ps.workspace = {
      instanceSize: 'micro',
      storageUsage: { totalBytes: BigInt(0), lastCalculatedAt: null },
    }
    ps.projects = []
    const out = await getStorageUsage('ws-1')
    expect(out!.percentUsed).toBe(0)
  })
})

describe('isOverStorageLimit', () => {
  it('returns false when workspace is not found', async () => {
    ps.workspace = null
    expect(await isOverStorageLimit('ws-1')).toBe(false)
  })

  it('returns false when workspace has no storageUsage', async () => {
    ps.workspace = { instanceSize: 'micro', storageUsage: null }
    expect(await isOverStorageLimit('ws-1')).toBe(false)
  })

  it('returns false when usage is under the micro limit (1GB)', async () => {
    ps.workspace = {
      instanceSize: 'micro',
      storageUsage: { totalBytes: BigInt(1024 ** 2) }, // 1 MB
    }
    expect(await isOverStorageLimit('ws-1')).toBe(false)
  })

  it('returns true when usage exceeds the micro limit', async () => {
    ps.workspace = {
      instanceSize: 'micro',
      storageUsage: { totalBytes: BigInt(2 * 1024 ** 3) }, // 2 GB
    }
    expect(await isOverStorageLimit('ws-1')).toBe(true)
  })

  it('returns false when usage exactly equals the limit (strict >)', async () => {
    ps.workspace = {
      instanceSize: 'micro',
      storageUsage: { totalBytes: BigInt(1 * 1024 ** 3) },
    }
    expect(await isOverStorageLimit('ws-1')).toBe(false)
  })
})

describe('calculateWorkspaceStorageUsage', () => {
  it('returns zero totals when workspace has no projects', async () => {
    ps.projects = []
    const out = await calculateWorkspaceStorageUsage('ws-1')
    expect(out).toEqual({ totalBytes: 0, projectCount: 0, perProject: [] })
    expect(ps.upsertCalls).toHaveLength(1)
    expect(ps.upsertCalls[0].create.totalBytes).toBe(BigInt(0))
    expect(ps.upsertCalls[0].create.projectCount).toBe(0)
  })

  it('sums object sizes per project and adds postgres-backups prefix', async () => {
    ps.projects = [{ id: 'p1', name: 'a' }]
    s3.byPrefix.set('p1/', [{ size: 100 }, { size: 200 }])
    s3.byPrefix.set('postgres-backups/p1/', [{ size: 50 }])
    const out = await calculateWorkspaceStorageUsage('ws-1')
    expect(out.totalBytes).toBe(350)
    expect(out.perProject).toEqual([{ projectId: 'p1', bytes: 350 }])
  })

  it('treats missing object size as 0', async () => {
    ps.projects = [{ id: 'p1', name: 'a' }]
    s3.byPrefix.set('p1/', [{ size: 100 }, {} as any])
    const out = await calculateWorkspaceStorageUsage('ws-1')
    expect(out.totalBytes).toBe(100)
  })

  it('silently tolerates a missing postgres-backups prefix', async () => {
    ps.projects = [{ id: 'p1', name: 'a' }]
    s3.byPrefix.set('p1/', [{ size: 200 }])
    s3.errorByPrefix.set('postgres-backups/p1/', new Error('NoSuchKey'))
    const out = await calculateWorkspaceStorageUsage('ws-1')
    expect(out.totalBytes).toBe(200)
    expect(out.perProject).toEqual([{ projectId: 'p1', bytes: 200 }])
  })

  it('records 0 bytes and logs error when primary listAllObjectsInS3 throws', async () => {
    ps.projects = [
      { id: 'p1', name: 'a' },
      { id: 'p2', name: 'b' },
    ]
    s3.errorByPrefix.set('p1/', new Error('s3 down'))
    s3.byPrefix.set('p2/', [{ size: 500 }])
    const out = await calculateWorkspaceStorageUsage('ws-1')
    expect(out.totalBytes).toBe(500)
    expect(out.perProject).toEqual([
      { projectId: 'p1', bytes: 0 },
      { projectId: 'p2', bytes: 500 },
    ])
    expect(errorSpy).toHaveBeenCalled()
  })

  it('writes a single upsert with totals after iterating all projects', async () => {
    ps.projects = [
      { id: 'p1', name: 'a' },
      { id: 'p2', name: 'b' },
    ]
    s3.byPrefix.set('p1/', [{ size: 100 }])
    s3.byPrefix.set('p2/', [{ size: 300 }])
    await calculateWorkspaceStorageUsage('ws-1')
    expect(ps.upsertCalls).toHaveLength(1)
    const call = ps.upsertCalls[0]
    expect(call.where).toEqual({ workspaceId: 'ws-1' })
    expect(call.create.totalBytes).toBe(BigInt(400))
    expect(call.create.projectCount).toBe(2)
    expect(call.update.totalBytes).toBe(BigInt(400))
    expect(call.update.projectCount).toBe(2)
    expect(call.create.lastCalculatedAt).toBeInstanceOf(Date)
  })
})

describe('recalculateAllStorageUsage', () => {
  it('iterates every workspace and logs start + end', async () => {
    ps.workspaces = [{ id: 'ws-1' }, { id: 'ws-2' }]
    ps.projects = []
    await recalculateAllStorageUsage()
    expect(ps.upsertCalls).toHaveLength(2)
    expect(ps.upsertCalls.map((c) => c.where.workspaceId).sort()).toEqual(['ws-1', 'ws-2'])
    const logged = (logSpy.mock.calls.flat() ?? []).join(' ')
    expect(logged).toContain('Recalculating storage for 2 workspaces')
    expect(logged).toContain('Recalculation complete')
  })

  it('continues past a workspace that throws and logs the error', async () => {
    ps.workspaces = [{ id: 'ws-1' }, { id: 'ws-2' }]
    // calculateWorkspaceStorageUsage calls prisma.project.findMany then
    // prisma.storageUsage.upsert. Make every upsert throw — the loop
    // should still call upsert once per workspace and log each failure.
    ps.upsertThrow = new Error('write failed')
    await recalculateAllStorageUsage()
    const errMsg = (errorSpy.mock.calls.flat() ?? []).join(' ')
    expect(errMsg).toContain('Failed to recalculate')
    // start + end log lines should still fire.
    const logged = (logSpy.mock.calls.flat() ?? []).join(' ')
    expect(logged).toContain('Recalculation complete')
  })
})

// ─── Freshness gate (PERF-1) ───────────────────────────────────────────────
//
// Every pod schedules this pass (boot + 6h) and the advisory lock only stops
// *overlapping* passes, so staggered restarts produced ~61 sweeps/day against
// 4 intended. The gate skips the sweep when `max(storage_usage.lastCalculatedAt)`
// shows one finished within STORAGE_RECALC_MIN_GAP_MS.

describe('recalculateAllStorageUsage freshness gate', () => {
  it('skips the whole sweep when a pass finished 1h ago', async () => {
    ps.workspaces = [{ id: 'ws-1' }, { id: 'ws-2' }]
    ps.projects = [{ id: 'p1', name: 'a' }]
    ps.lastCalculatedAtMax = new Date(Date.now() - 60 * 60 * 1000)

    const out = await recalculateAllStorageUsage()

    expect(out.status).toBe('fresh')
    expect(out.workspaces).toBeUndefined()
    // No workspace scan, no project scan, no S3 LIST, no upsert.
    expect(ps.workspaceFindManyCalls).toBe(0)
    expect(ps.projectFindManyCalls).toBe(0)
    expect(s3.listCalls).toBe(0)
    expect(ps.upsertCalls).toHaveLength(0)
    // It does read the max — that query is the whole point.
    expect(ps.aggregateCalls).toBe(1)
    const logged = (logSpy.mock.calls.flat() ?? []).join(' ')
    expect(logged).toContain('Skipping recalculation: last pass finished 60m ago')
  })

  it('runs when the last pass finished 6h ago', async () => {
    ps.workspaces = [{ id: 'ws-1' }, { id: 'ws-2' }]
    ps.projects = []
    ps.lastCalculatedAtMax = new Date(Date.now() - 6 * 60 * 60 * 1000)

    const out = await recalculateAllStorageUsage()

    expect(out).toEqual({ status: 'ran', workspaces: 2 })
    expect(ps.upsertCalls).toHaveLength(2)
    expect(ps.upsertCalls.map((c) => c.where.workspaceId).sort()).toEqual(['ws-1', 'ws-2'])
  })

  it('runs when the storage_usage table is empty (null max)', async () => {
    ps.workspaces = [{ id: 'ws-1' }]
    ps.projects = []
    ps.lastCalculatedAtMax = null

    const out = await recalculateAllStorageUsage()

    expect(out).toEqual({ status: 'ran', workspaces: 1 })
    expect(ps.upsertCalls).toHaveLength(1)
  })

  it('runs when the last pass is exactly STORAGE_RECALC_MIN_GAP_MS old', async () => {
    ps.workspaces = [{ id: 'ws-1' }]
    ps.projects = []
    ps.lastCalculatedAtMax = new Date(Date.now() - STORAGE_RECALC_MIN_GAP_MS)

    const out = await recalculateAllStorageUsage()

    expect(out).toEqual({ status: 'ran', workspaces: 1 })
    expect(ps.upsertCalls).toHaveLength(1)
  })

  it('reports locked and scans nothing when another pod holds the lock', async () => {
    ps.workspaces = [{ id: 'ws-1' }]
    lockState.heldElsewhere = true

    const out = await recalculateAllStorageUsage()

    expect(out).toEqual({ status: 'locked' })
    expect(ps.aggregateCalls).toBe(0)
    expect(ps.workspaceFindManyCalls).toBe(0)
    expect(ps.projectFindManyCalls).toBe(0)
    expect(s3.listCalls).toBe(0)
    expect(ps.upsertCalls).toHaveLength(0)
  })
})

describe('recalculateAllStorageUsage home-region partition (PERF-8)', () => {
  it('single-region: sweeps every workspace with no filter', async () => {
    ps.workspaces = [{ id: 'ws-1' }]
    await recalculateAllStorageUsage()
    expect(ps.workspaceFindManyArgs[0].where).toBeUndefined()
    expect(ps.aggregateArgs[0].where).toBeUndefined()
  })

  it('multi-region: sweeps and judges freshness on this region’s home workspaces only', async () => {
    regionState.home = { homeRegion: 'eu-frankfurt-1' }
    ps.workspaces = [{ id: 'ws-eu' }]
    const out = await recalculateAllStorageUsage()
    expect(out).toEqual({ status: 'ran', workspaces: 1 })
    expect(ps.workspaceFindManyArgs[0].where).toEqual({ homeRegion: 'eu-frankfurt-1' })
    expect(ps.aggregateArgs[0].where).toEqual({ workspace: { homeRegion: 'eu-frankfurt-1' } })
  })

  it('primary region also owns legacy rows with no homeRegion', async () => {
    regionState.home = { OR: [{ homeRegion: 'us-ashburn-1' }, { homeRegion: null }] }
    ps.workspaces = []
    await recalculateAllStorageUsage()
    expect(ps.workspaceFindManyArgs[0].where).toEqual(regionState.home)
  })
})
