// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Read paths, region behaviour and billing math for the storage meter (SHO-423).
 *
 * `__tests__/storage.service.test.ts` covers the measurement pass (per-category
 * attribution, the daily peak row, failure isolation). This file covers what
 * reads those numbers back:
 *
 *  - `getStorageUsage` detail view (history window, month-to-date GB-months),
 *  - `getPlatformStorageSummary` (super-admin platform totals),
 *  - `listWorkspaceStorage` (the workspace directory's Storage column),
 *  - `recalculateWorkspaceStorageNow` (the on-demand pass and its lock),
 *  - the home-region partition the 6h pass and the bill job both rely on,
 *  - `storageDayGbMonths` / `storageDailyUsd` proration.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── mock state ────────────────────────────────────────────────────────────

interface PrismaState {
  /** Answer for `workspace.findUnique`. */
  workspace: any | null
  /** Answer for `workspace.findMany` (the directory list). */
  workspaces: any[]
  /** Answer for `workspace.count`. */
  workspaceCount: number
  projects: any[]
  usageRows: any[]
  dailyRows: any[]
  usageAggregateMax: Date | null

  upsertCalls: any[]
  createDailyCalls: any[]
  updateDailyCalls: any[]

  workspaceFindManyArgs: any[]
  usageFindManyArgs: any[]
  usageAggregateArgs: any[]
  dailyFindManyArgs: any[]

  /** Thrown by `storageUsage.upsert`, to exercise the per-workspace catch. */
  upsertThrow: Error | null
}

const ps: PrismaState = {
  workspace: null,
  workspaces: [],
  workspaceCount: 0,
  projects: [],
  usageRows: [],
  dailyRows: [],
  usageAggregateMax: null,
  upsertCalls: [],
  createDailyCalls: [],
  updateDailyCalls: [],
  workspaceFindManyArgs: [],
  usageFindManyArgs: [],
  usageAggregateArgs: [],
  dailyFindManyArgs: [],
  upsertThrow: null,
}

mock.module('@shogo/shared-runtime', () => ({
  isMobileTechStack: (_: unknown) => false,
  isDockerTechStack: (_: unknown) => false,
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async (_args: any) => ps.workspace,
      findMany: async (args: any) => {
        ps.workspaceFindManyArgs.push(args)
        return ps.workspaces
      },
      count: async (_args: any) => ps.workspaceCount,
    },
    project: { findMany: async (_args: any) => ps.projects },
    chatSession: { findMany: async (_args: any) => [] },
    publishedEnvironment: { findMany: async (_args: any) => [] },
    storageUsage: {
      findMany: async (args: any) => {
        ps.usageFindManyArgs.push(args)
        return ps.usageRows
      },
      aggregate: async (args: any) => {
        ps.usageAggregateArgs.push(args)
        return { _max: { lastCalculatedAt: ps.usageAggregateMax } }
      },
      upsert: async (args: any) => {
        if (ps.upsertThrow) throw ps.upsertThrow
        ps.upsertCalls.push(args)
        return args.create
      },
    },
    storageUsageDaily: {
      findUnique: async (_args: any) => null,
      findMany: async (args: any) => {
        ps.dailyFindManyArgs.push(args)
        return ps.dailyRows
      },
      create: async (args: any) => {
        ps.createDailyCalls.push(args)
        return args.data
      },
      update: async (args: any) => {
        ps.updateDailyCalls.push(args)
        return args.data
      },
    },
  },
}))

const s3State: {
  byPrefix: Map<string, Array<{ relativePath: string; size?: number }>>
  listCalls: number
} = { byPrefix: new Map(), listCalls: 0 }

mock.module('../../lib/s3', () => ({
  listAllObjectsInS3: async (prefix: string, _bucket: string) => {
    s3State.listCalls++
    return s3State.byPrefix.get(prefix) ?? []
  },
  listAllArtifactObjects: async (prefix: string) => {
    s3State.listCalls++
    return s3State.byPrefix.get(prefix) ?? []
  },
}))

/** The service takes an advisory lock; `heldElsewhere` simulates a peer pod. */
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

/** Region filter the service asks for; `null` = single-region install. */
const regionState: { home: any } = { home: null }
const realRegion = await import('../../lib/region')
mock.module('../../lib/region', () => ({
  ...realRegion,
  homeRegionWorkspaceWhere: () => regionState.home,
}))

const {
  STORAGE_HISTORY_DAYS,
  calculateWorkspaceStorageUsage,
  getStorageUsage,
  getPlatformStorageSummary,
  isOverStorageLimit,
  listWorkspaceStorage,
  recalculateAllStorageUsage,
  recalculateWorkspaceStorageNow,
} = await import('../storage.service')

const { INSTANCE_SIZES } = await import('../../config/instance-sizes')
const { STORAGE_USD_PER_GB_MONTH, storageDailyUsd, storageDayGbMonths } = await import(
  '../../config/storage-pricing'
)
const SMALL_LIMIT = INSTANCE_SIZES.small.storageLimitBytes

const BUCKET_ENV_VARS = [
  'S3_WORKSPACES_BUCKET',
  'S3_LFS_BUCKET',
  'S3_ARTIFACT_BUCKET',
  'S3_SCHEMA_BUCKET',
  'PUBLISH_BUCKET',
  'PUBLISH_DATA_BUCKET',
  'S3_PUBLISHED_DATA_BUCKET',
  'METAL_SNAP_BUCKET',
  'METAL_FLEET_S3_PREFIX',
]
const savedEnv: Record<string, string | undefined> = {}

let logSpy: any
let errorSpy: any

beforeEach(() => {
  for (const name of BUCKET_ENV_VARS) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
  ps.workspace = null
  ps.workspaces = []
  ps.workspaceCount = 0
  ps.projects = []
  ps.usageRows = []
  ps.dailyRows = []
  ps.usageAggregateMax = null
  ps.upsertCalls = []
  ps.createDailyCalls = []
  ps.updateDailyCalls = []
  ps.workspaceFindManyArgs = []
  ps.usageFindManyArgs = []
  ps.usageAggregateArgs = []
  ps.dailyFindManyArgs = []
  ps.upsertThrow = null
  s3State.byPrefix = new Map()
  s3State.listCalls = 0
  regionState.home = null
  lockState.heldElsewhere = false
  logSpy = mock(() => {})
  errorSpy = mock(() => {})
  console.log = logSpy as any
  console.error = errorSpy as any
})

afterEach(() => {
  for (const name of BUCKET_ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
})

// ─── billing math ──────────────────────────────────────────────────────────

describe('storageDayGbMonths', () => {
  it('is zero at or below the allowance', () => {
    expect(storageDayGbMonths(SMALL_LIMIT, SMALL_LIMIT)).toBe(0)
    expect(storageDayGbMonths(SMALL_LIMIT - 1, SMALL_LIMIT)).toBe(0)
  })

  it('prorates the over-allowance bytes by the days in the month', () => {
    const overBytes = 2 * 1024 ** 3 // 2 GB over
    // 2026-01 has 31 days.
    const expected = 2 / 31
    expect(storageDayGbMonths(SMALL_LIMIT + overBytes, SMALL_LIMIT, new Date('2026-01-15T00:00:00Z')))
      .toBeCloseTo(expected, 10)
    // A 30-day month accrues more per day for the same overage.
    expect(storageDayGbMonths(SMALL_LIMIT + overBytes, SMALL_LIMIT, new Date('2026-04-15T00:00:00Z')))
      .toBeCloseTo(2 / 30, 10)
  })

  it('a full month of the same overage sums to exactly the GB-months', () => {
    const overBytes = 3 * 1024 ** 3
    let sum = 0
    for (let day = 1; day <= 30; day++) {
      sum += storageDayGbMonths(SMALL_LIMIT + overBytes, SMALL_LIMIT, new Date(Date.UTC(2026, 3, day)))
    }
    expect(sum).toBeCloseTo(3, 10)
  })
})

describe('storageDailyUsd', () => {
  it('is zero when nothing is over the allowance', () => {
    expect(storageDailyUsd(SMALL_LIMIT, SMALL_LIMIT, new Date('2026-01-15T00:00:00Z'))).toBe(0)
  })

  it('applies the configured per-GB-month rate', () => {
    const overBytes = 31 * 1024 ** 3 // 31 GB over in a 31-day month
    const usd = storageDailyUsd(SMALL_LIMIT + overBytes, SMALL_LIMIT, new Date('2026-01-15T00:00:00Z'))
    expect(usd).toBeCloseTo(STORAGE_USD_PER_GB_MONTH, 6)
  })
})

// ─── getStorageUsage detail ────────────────────────────────────────────────

describe('getStorageUsage history + month estimate', () => {
  it('windows the history query to a rolling day count, crossing month boundaries', async () => {
    ps.workspace = { instanceSize: 'small', storageUsage: null }
    ps.projects = []
    await getStorageUsage('ws-1', { detail: true, now: new Date('2026-01-20T12:00:00Z') })

    const args = ps.dailyFindManyArgs[0]
    expect(args.where.workspaceId).toBe('ws-1')
    // 30 days ending 2026-01-20 starts 2025-12-22.
    expect(args.where.day.gte.toISOString().slice(0, 10)).toBe('2025-12-22')
    expect(args.orderBy).toEqual({ day: 'asc' })
  })

  it('reaches into the previous month early in a month', async () => {
    ps.workspace = { instanceSize: 'small', storageUsage: null }
    await getStorageUsage('ws-1', { detail: true, now: new Date('2026-01-03T12:00:00Z') })
    // 30 days ending 2026-01-03 starts 2025-12-05, not 2026-01-01.
    expect(ps.dailyFindManyArgs[0].where.day.gte.toISOString().slice(0, 10)).toBe('2025-12-05')
  })

  it('honours an explicit historyDays', async () => {
    ps.workspace = { instanceSize: 'small', storageUsage: null }
    await getStorageUsage('ws-1', {
      detail: true,
      historyDays: 7,
      now: new Date('2026-01-20T12:00:00Z'),
    })
    expect(ps.dailyFindManyArgs[0].where.day.gte.toISOString().slice(0, 10)).toBe('2026-01-14')
  })

  it('only counts this calendar month toward the month estimate', async () => {
    ps.workspace = { instanceSize: 'small', storageUsage: null }
    const over = BigInt(SMALL_LIMIT + 10 * 1024 ** 3)
    ps.dailyRows = [
      // Previous month — excluded from the month-to-date figure, but still history.
      {
        day: new Date('2025-12-28T00:00:00Z'),
        totalBytes: over,
        billableBytes: over,
        allowanceBytes: BigInt(SMALL_LIMIT),
        chargedUsd: 1,
        billedAt: new Date('2025-12-29T00:00:00Z'),
      },
      // Same month.
      {
        day: new Date('2026-01-05T00:00:00Z'),
        totalBytes: over,
        billableBytes: over,
        allowanceBytes: BigInt(SMALL_LIMIT),
        chargedUsd: null,
        billedAt: null,
      },
    ]

    const out = await getStorageUsage('ws-1', {
      detail: true,
      now: new Date('2026-01-20T12:00:00Z'),
    })

    expect(out!.history).toHaveLength(2)
    // 10 GB over for one of January's 31 days.
    expect(out!.month!.billableGbMonths).toBeCloseTo(10 / 31, 5)
    expect(out!.month!.estimatedUsd).toBeCloseTo((10 / 31) * STORAGE_USD_PER_GB_MONTH, 5)
  })

  it('defaults to shadow mode', async () => {
    ps.workspace = { instanceSize: 'small', storageUsage: null }
    const previous = process.env.STORAGE_BILLING_MODE
    delete process.env.STORAGE_BILLING_MODE
    try {
      const out = await getStorageUsage('ws-1', { detail: true })
      expect(out!.month!.mode).toBe('shadow')
    } finally {
      if (previous === undefined) delete process.env.STORAGE_BILLING_MODE
      else process.env.STORAGE_BILLING_MODE = previous
    }
  })

  it('reports enforce when STORAGE_BILLING_MODE=enforce', async () => {
    ps.workspace = { instanceSize: 'small', storageUsage: null }
    const previous = process.env.STORAGE_BILLING_MODE
    process.env.STORAGE_BILLING_MODE = 'enforce'
    try {
      const out = await getStorageUsage('ws-1', { detail: true })
      expect(out!.month!.mode).toBe('enforce')
    } finally {
      if (previous === undefined) delete process.env.STORAGE_BILLING_MODE
      else process.env.STORAGE_BILLING_MODE = previous
    }
  })
})

// ─── getPlatformStorageSummary ─────────────────────────────────────────────

describe('getPlatformStorageSummary', () => {
  it('sums categories, splits overhead from billable and ranks workspaces', async () => {
    const MICRO = INSTANCE_SIZES.micro.storageLimitBytes
    ps.usageRows = [
      {
        // Over the micro allowance, with 300 bytes of quarantine overhead.
        workspaceId: 'ws-big',
        totalBytes: BigInt(MICRO + 1000),
        billableBytes: BigInt(MICRO + 700),
        lastCalculatedAt: new Date('2026-01-20T00:00:00Z'),
        breakdown: {
          categories: { project_files: MICRO + 700, quarantine: 300 },
          projects: [],
          unmeasured: ['artifacts'],
        },
        workspace: { name: 'Big', instanceSize: 'micro' },
      },
      {
        workspaceId: 'ws-small',
        totalBytes: BigInt(100),
        billableBytes: BigInt(100),
        lastCalculatedAt: new Date('2026-01-20T00:00:00Z'),
        breakdown: { categories: { project_files: 100 }, projects: [], unmeasured: [] },
        workspace: { name: 'Small', instanceSize: 'small' },
      },
    ]
    ps.usageAggregateMax = new Date('2026-01-20T00:00:00Z')

    const out = await getPlatformStorageSummary(10, new Date('2026-01-20T12:00:00Z'))

    expect(out.buckets.workspaces).toBe(2)
    expect(out.buckets.measuredBytes).toBe(MICRO + 1100)
    expect(out.billableBytes).toBe(MICRO + 800)
    expect(out.overheadBytes).toBe(300)
    expect(out.categories.project_files).toBe(MICRO + 800)
    expect(out.categories.quarantine).toBe(300)
    expect(out.unmeasured).toEqual(['artifacts'])
    expect(out.lastPassAt).toEqual(new Date('2026-01-20T00:00:00Z'))
    // Ranked by total bytes, biggest first.
    expect(out.topByBytes.map((row) => row.workspaceId)).toEqual(['ws-big', 'ws-small'])
    // Only ws-big is over its tier allowance.
    expect(out.topByOverage.map((row) => row.workspaceId)).toEqual(['ws-big'])
    expect(out.topByOverage[0].overageBytes).toBe(700)
  })

  it('treats a pre-breakdown row as all project files and all billable', async () => {
    ps.usageRows = [
      {
        workspaceId: 'ws-legacy',
        totalBytes: BigInt(500),
        billableBytes: null,
        lastCalculatedAt: new Date('2026-01-01T00:00:00Z'),
        breakdown: null,
        workspace: { name: 'Legacy', instanceSize: 'small' },
      },
    ]

    const out = await getPlatformStorageSummary(10, new Date('2026-01-20T12:00:00Z'))

    expect(out.categories.project_files).toBe(500)
    expect(out.billableBytes).toBe(500)
    expect(out.overheadBytes).toBe(0)
  })

  it('reports an empty platform without throwing', async () => {
    const out = await getPlatformStorageSummary(10, new Date('2026-01-20T12:00:00Z'))
    expect(out.buckets).toEqual({ measuredBytes: 0, workspaces: 0 })
    expect(out.lastPassAt).toBeNull()
    expect(out.topByBytes).toEqual([])
    expect(out.topByOverage).toEqual([])
    expect(out.month.gbMonths).toBe(0)
  })

  it('filters to home-region workspaces when multi-region', async () => {
    regionState.home = { homeRegion: 'eu-frankfurt-1' }
    await getPlatformStorageSummary(10)
    expect(ps.usageFindManyArgs[0].where).toEqual({ workspace: { homeRegion: 'eu-frankfurt-1' } })
    expect(ps.usageAggregateArgs[0].where).toEqual({ workspace: { homeRegion: 'eu-frankfurt-1' } })
  })
})

// ─── listWorkspaceStorage ──────────────────────────────────────────────────

describe('listWorkspaceStorage', () => {
  it('maps allowances and percentages, sorting by bytes client-side', async () => {
    ps.workspaces = [
      {
        id: 'ws-a',
        name: 'A',
        slug: 'a',
        instanceSize: 'small',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        storageUsage: { totalBytes: BigInt(100), billableBytes: BigInt(100) },
        _count: { members: 1, projects: 2, subscriptions: 0 },
      },
      {
        id: 'ws-b',
        name: 'B',
        slug: 'b',
        instanceSize: 'micro',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        storageUsage: { totalBytes: BigInt(900), billableBytes: BigInt(800) },
        _count: { members: 3, projects: 1, subscriptions: 1 },
      },
    ]
    ps.workspaceCount = 2

    const out = await listWorkspaceStorage()

    expect(out.workspaces.map((row) => row.workspaceId)).toEqual(['ws-b', 'ws-a'])
    expect(out.workspaces[0].storage.allowanceBytes).toBe(INSTANCE_SIZES.micro.storageLimitBytes)
    expect(out.workspaces[0].counts).toEqual({ members: 3, projects: 1, subscriptions: 1 })
    // Bytes ordering must not be delegated to the DB: it is applied in JS.
    expect(ps.workspaceFindManyArgs[0].skip).toBe(0)
    expect(ps.workspaceFindManyArgs[0].take).toBeUndefined()
  })

  it('sorts by overage when asked', async () => {
    ps.workspaces = [
      {
        id: 'ws-under',
        name: 'Under',
        slug: 'under',
        instanceSize: 'small',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        storageUsage: { totalBytes: BigInt(10), billableBytes: BigInt(10) },
        _count: { members: 0, projects: 0, subscriptions: 0 },
      },
      {
        id: 'ws-over',
        name: 'Over',
        slug: 'over',
        instanceSize: 'micro',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        storageUsage: {
          totalBytes: BigInt(INSTANCE_SIZES.micro.storageLimitBytes + 5000),
          billableBytes: BigInt(INSTANCE_SIZES.micro.storageLimitBytes + 5000),
        },
        _count: { members: 0, projects: 0, subscriptions: 0 },
      },
    ]

    const out = await listWorkspaceStorage({ sort: 'overage' })
    expect(out.workspaces.map((row) => row.workspaceId)).toEqual(['ws-over', 'ws-under'])
  })

  it('passes search and instance-size filters through', async () => {
    await listWorkspaceStorage({ search: 'acme', instanceSize: 'small' })
    const where = ps.workspaceFindManyArgs[0].where
    expect(where.instanceSize).toBe('small')
    expect(where.OR).toHaveLength(2)
  })

  it('clamps the page size', async () => {
    const out = await listWorkspaceStorage({ limit: 5000 })
    expect(out.limit).toBe(100)
  })
})

// ─── on-demand recalculation ───────────────────────────────────────────────

describe('recalculateWorkspaceStorageNow', () => {
  it('measures and persists the workspace', async () => {
    ps.workspace = { instanceSize: 'micro', storageUsage: null }
    ps.workspaces = [{ id: 'ws-now', instanceSize: 'micro', personalOwnerId: null }]
    ps.projects = [{ id: 'p-1', workspaceId: 'ws-now' }]
    s3State.byPrefix.set('p-1/', [{ relativePath: 'src/a.ts', size: 42 }])

    const out = await recalculateWorkspaceStorageNow('ws-now')

    expect(out.status).toBe('measured')
    if (out.status !== 'measured') throw new Error('unreachable')
    expect(out.measurement.totalBytes).toBe(42)
    expect(ps.upsertCalls).toHaveLength(1)
    expect(ps.upsertCalls[0].where).toEqual({ workspaceId: 'ws-now' })
  })

  it('skips the freshness gate — an explicit request always measures', async () => {
    ps.usageAggregateMax = new Date() // a pass finished moments ago
    ps.workspace = { instanceSize: 'micro', storageUsage: null }
    ps.workspaces = [{ id: 'ws-now', instanceSize: 'micro', personalOwnerId: null }]

    const out = await recalculateWorkspaceStorageNow('ws-now')

    expect(out.status).toBe('measured')
    expect(ps.upsertCalls).toHaveLength(1)
  })

  it('reports locked instead of measuring when a pass holds the lock', async () => {
    lockState.heldElsewhere = true
    const out = await recalculateWorkspaceStorageNow('ws-now')
    expect(out).toEqual({ status: 'locked' })
    expect(ps.upsertCalls).toHaveLength(0)
  })
})

// ─── home-region partition (PERF-8) ────────────────────────────────────────

describe('recalculateAllStorageUsage home-region partition', () => {
  it('single-region: sweeps every workspace with no filter', async () => {
    ps.workspaces = [{ id: 'ws-1', instanceSize: 'micro', personalOwnerId: null }]
    ps.workspace = { instanceSize: 'micro', storageUsage: null }

    await recalculateAllStorageUsage()

    expect(ps.workspaceFindManyArgs[0].where).toEqual({})
    expect(ps.usageAggregateArgs[0].where).toBeUndefined()
  })

  it('multi-region: sweeps and judges freshness on this region’s home workspaces only', async () => {
    regionState.home = { homeRegion: 'eu-frankfurt-1' }
    ps.workspaces = [{ id: 'ws-eu', instanceSize: 'micro', personalOwnerId: null }]
    ps.workspace = { instanceSize: 'micro', storageUsage: null }

    const out = await recalculateAllStorageUsage()

    expect(out).toEqual({ status: 'ran', workspaces: 1 })
    expect(ps.workspaceFindManyArgs[0].where).toEqual({ homeRegion: 'eu-frankfurt-1' })
    expect(ps.usageAggregateArgs[0].where).toEqual({ workspace: { homeRegion: 'eu-frankfurt-1' } })
  })

  it('primary region also owns legacy rows with no homeRegion', async () => {
    regionState.home = { OR: [{ homeRegion: 'us-ashburn-1' }, { homeRegion: null }] }
    ps.workspaces = []
    await recalculateAllStorageUsage()
    expect(ps.workspaceFindManyArgs[0].where).toEqual(regionState.home)
  })
})

// ─── write-path isolation ──────────────────────────────────────────────────

describe('calculateWorkspaceStorageUsage write failures', () => {
  it('surfaces a failing upsert so the fleet pass can isolate that workspace', async () => {
    ps.workspace = { instanceSize: 'micro', storageUsage: null }
    ps.workspaces = [{ id: 'ws-bad', instanceSize: 'micro', personalOwnerId: null }]
    ps.upsertThrow = new Error('write failed')

    await expect(calculateWorkspaceStorageUsage('ws-bad')).rejects.toThrow('write failed')
  })
})

// ─── isOverStorageLimit (tier boundaries) ──────────────────────────────────

describe('isOverStorageLimit tier boundaries', () => {
  it('uses the workspace tier allowance, not a global constant', async () => {
    ps.workspace = {
      instanceSize: 'small',
      storageUsage: { totalBytes: BigInt(INSTANCE_SIZES.micro.storageLimitBytes + 1) },
    }
    // Over the micro allowance but under small's.
    expect(await isOverStorageLimit('ws-1')).toBe(false)
  })

  it('defaults a null tier to the smallest allowance', async () => {
    ps.workspace = {
      instanceSize: null,
      storageUsage: { totalBytes: BigInt(INSTANCE_SIZES.micro.storageLimitBytes + 1) },
    }
    expect(await isOverStorageLimit('ws-1')).toBe(true)
  })
})

// Guard the value the UI and the bill job both read.
describe('STORAGE_HISTORY_DAYS', () => {
  it('is the 30-day window the settings panel renders', () => {
    expect(STORAGE_HISTORY_DAYS).toBe(30)
  })
})
