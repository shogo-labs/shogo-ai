// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/services/storage.service.ts — per-workspace S3 usage tracking
 * (SHO-423: per-category and per-project metering, daily history, GB-month
 * billing over the tier allowance).
 *
 * Mocks prisma + the S3 listing helpers so every test is hermetic. Bucket env
 * vars are cleared, so the shared namespaces the service wants to list but
 * cannot configure (artifacts, publish, metal snapshots) are reported as
 * `unmeasured` rather than silently counted as zero.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// Mock @shogo/shared-runtime BEFORE any import that transitively reaches
// src/config/instance-sizes.ts (storage.service imports it).
mock.module('@shogo/shared-runtime', () => ({
  isMobileTechStack: (id: string | null | undefined) =>
    !!id && (id.startsWith('expo') || id === 'react-native'),
  isDockerTechStack: (_id: any) => false,
  getMinimumInstanceSize: (_id: any) => null,
}))

// ─── prisma + s3 mocks ─────────────────────────────────────────────────────

const findUniqueWs = mock(async (_: any): Promise<any> => null)
const findManyWs = mock(async (_: any): Promise<any[]> => [])
const findManyProject = mock(async (_: any): Promise<any[]> => [])
const findManyChatSession = mock(async (_: any): Promise<any[]> => [])
const findManyPublishedEnvironment = mock(async (_: any): Promise<any[]> => [])
const upsertStorageUsage = mock(async (_: any): Promise<any> => ({}))
// Freshness gate: `_max.lastCalculatedAt` is null by default so the fleet pass
// runs, which is what every pre-existing test below expects.
const aggregateStorageUsage = mock(async (_: any): Promise<any> => ({
  _max: { lastCalculatedAt: null },
}))
const findUniqueDaily = mock(async (_: any): Promise<any> => null)
const createDaily = mock(async (_: any): Promise<any> => ({}))
const updateDaily = mock(async (_: any): Promise<any> => ({}))
const findManyDaily = mock(async (_: any): Promise<any[]> => [])

mock.module('../lib/prisma', () => ({
  prisma: {
    workspace: { findUnique: findUniqueWs, findMany: findManyWs },
    project: { findMany: findManyProject },
    chatSession: { findMany: findManyChatSession },
    publishedEnvironment: { findMany: findManyPublishedEnvironment },
    storageUsage: { upsert: upsertStorageUsage, aggregate: aggregateStorageUsage },
    storageUsageDaily: {
      findUnique: findUniqueDaily,
      findMany: findManyDaily,
      create: createDaily,
      update: updateDaily,
    },
  },
}))

/**
 * The listing helpers return `ListedObject`s (`{ relativePath, size }`).
 * `byPrefix` keys are the prefix as passed, so a test can answer
 * `'p_1/'`, `'conflict/'`, … independently.
 */
const listAllObjectsInS3 = mock(
  async (_prefix: string, _bucket: string): Promise<Array<{ relativePath: string; size?: number }>> => [],
)
const listAllArtifactObjects = mock(
  async (_prefix: string): Promise<Array<{ relativePath: string; size?: number }>> => [],
)
mock.module('../lib/s3', () => ({
  listAllObjectsInS3,
  listAllArtifactObjects,
}))

/**
 * `recalculateAllStorageUsage` takes an advisory lock before it reads anything.
 * Mirror the local-mode branch of the real helper (run the body, report
 * `acquired: true`) and let a test flip `heldElsewhere` to simulate a peer pod.
 */
const lockState = { heldElsewhere: false }
mock.module('../lib/global-job-lock', () => ({
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

const {
  STORAGE_RECALC_MIN_GAP_MS,
  classifyProjectObject,
  calculateWorkspaceStorageUsage,
  getStorageUsage,
  isOverStorageLimit,
  recalculateAllStorageUsage,
} = await import('../services/storage.service')

// ─── INSTANCE_SIZES — pulled live so we can compute expected limits ───────

const { INSTANCE_SIZES } = await import('../config/instance-sizes')
const SMALL_LIMIT = INSTANCE_SIZES.small.storageLimitBytes // 5 GiB
const MICRO_LIMIT = INSTANCE_SIZES.micro.storageLimitBytes // 2 GiB

let errorSpy: ReturnType<typeof spyOn>
let logSpy: ReturnType<typeof spyOn>

/** Every bucket env var the service reads; cleared so no namespace is configured. */
const BUCKET_ENV_VARS = [
  'S3_WORKSPACES_BUCKET',
  'S3_LFS_BUCKET',
  'S3_ARTIFACT_BUCKET',
  'S3_SCHEMA_BUCKET',
  'S3_LFS_BUCKET',
  'PUBLISH_BUCKET',
  'PUBLISH_DATA_BUCKET',
  'S3_PUBLISHED_DATA_BUCKET',
  'METAL_SNAP_BUCKET',
  'METAL_FLEET_S3_PREFIX',
]

const savedEnv: Record<string, string | undefined> = {}
/** Prefix → objects returned by whichever listing helper is asked for it. */
const objects = new Map<string, Array<{ relativePath: string; size?: number }>>()
/** Prefix → error the listing helper throws. */
const objectErrors = new Map<string, Error>()

beforeEach(() => {
  for (const name of BUCKET_ENV_VARS) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
  objects.clear()
  objectErrors.clear()
  lockState.heldElsewhere = false

  findUniqueWs.mockReset()
  findManyWs.mockReset()
  findManyProject.mockReset()
  findManyChatSession.mockReset()
  findManyPublishedEnvironment.mockReset()
  upsertStorageUsage.mockReset()
  aggregateStorageUsage.mockReset()
  findUniqueDaily.mockReset()
  createDaily.mockReset()
  updateDaily.mockReset()
  findManyDaily.mockReset()

  // `persistMeasurement` re-reads the workspace for its tier allowance, so a
  // default that resolves keeps the write path exercised; tests that want a
  // missing workspace override this.
  findUniqueWs.mockImplementation(async () => ({ instanceSize: 'micro', storageUsage: null }))
  findManyWs.mockImplementation(async () => [])
  findManyProject.mockImplementation(async () => [])
  findManyChatSession.mockImplementation(async () => [])
  findManyPublishedEnvironment.mockImplementation(async () => [])
  upsertStorageUsage.mockImplementation(async () => ({}))
  aggregateStorageUsage.mockImplementation(async () => ({ _max: { lastCalculatedAt: null } }))
  findUniqueDaily.mockImplementation(async () => null)
  createDaily.mockImplementation(async () => ({}))
  updateDaily.mockImplementation(async () => ({}))
  findManyDaily.mockImplementation(async () => [])

  listAllObjectsInS3.mockReset()
  listAllObjectsInS3.mockImplementation(async (prefix: string) => {
    const failure = objectErrors.get(prefix)
    if (failure) throw failure
    return objects.get(prefix) ?? []
  })
  listAllArtifactObjects.mockReset()
  listAllArtifactObjects.mockImplementation(async (prefix: string) => {
    const failure = objectErrors.get(prefix)
    if (failure) throw failure
    return objects.get(prefix) ?? []
  })

  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  logSpy = spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  for (const name of BUCKET_ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  errorSpy.mockRestore()
  logSpy.mockRestore()
})

// ─── classifyProjectObject ─────────────────────────────────────────────────

describe('classifyProjectObject', () => {
  test('git archives, bare repos and LFS objects are repo bytes', () => {
    expect(classifyProjectObject('repo.git.tar.gz')).toBe('repo')
    expect(classifyProjectObject('repo/manifest.json')).toBe('repo')
    expect(classifyProjectObject('lfs/objects/ab/cdef')).toBe('repo')
  })

  test('assets and project-data archives get their own categories', () => {
    expect(classifyProjectObject('assets/hero.png')).toBe('assets')
    expect(classifyProjectObject('project-data.tar.gz')).toBe('backups')
    expect(classifyProjectObject('project-data/daily/2026-01-01.tar.gz')).toBe('backups')
  })

  test('everything else under the project prefix is the working copy', () => {
    expect(classifyProjectObject('src/index.ts')).toBe('project_files')
    expect(classifyProjectObject('package.json')).toBe('project_files')
    // A nested directory whose name merely starts with "repo" is not the repo.
    expect(classifyProjectObject('reports/q1.pdf')).toBe('project_files')
  })
})

// ─── getStorageUsage ───────────────────────────────────────────────────────

describe('getStorageUsage', () => {
  test('returns null when workspace is not found', async () => {
    findUniqueWs.mockImplementation(async () => null)
    expect(await getStorageUsage('ws_missing')).toBeNull()
  })

  test('returns the totals and hides the detail fields by default', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: {
        totalBytes: BigInt(1024 * 1024 * 1024), // 1 GiB
        billableBytes: BigInt(900 * 1024 * 1024),
        lastCalculatedAt: new Date('2026-01-15T00:00:00Z'),
      },
    }))
    findManyProject.mockImplementation(async () => [
      { id: 'p_1', name: 'Alpha', hidden: false },
      { id: 'p_2', name: 'Beta', hidden: false },
    ])

    const result = await getStorageUsage('ws_1')
    expect(result).not.toBeNull()
    expect(result!.totalBytes).toBe(1024 * 1024 * 1024)
    expect(result!.billableBytes).toBe(900 * 1024 * 1024)
    expect(result!.limitBytes).toBe(SMALL_LIMIT)
    expect(result!.projectCount).toBe(2)
    expect(result!.percentUsed).toBeCloseTo((1024 ** 3 / SMALL_LIMIT) * 100, 1)
    expect(result!.isOverLimit).toBe(false)
    expect(result!.lastCalculatedAt).toEqual(new Date('2026-01-15T00:00:00Z'))

    // A plain member never pays for the per-project breakdown or history.
    expect(result!.categories).toBeUndefined()
    expect(result!.projects).toBeUndefined()
    expect(result!.history).toBeUndefined()
    expect(findManyDaily).not.toHaveBeenCalled()
  })

  test('returns totalBytes=0 when no storageUsage row exists yet', async () => {
    findUniqueWs.mockImplementation(async () => ({ instanceSize: 'micro', storageUsage: null }))
    findManyProject.mockImplementation(async () => [])
    const result = await getStorageUsage('ws_2')
    expect(result!.totalBytes).toBe(0)
    expect(result!.billableBytes).toBe(0)
    expect(result!.limitBytes).toBe(MICRO_LIMIT)
    expect(result!.percentUsed).toBe(0)
    expect(result!.lastCalculatedAt).toBeNull()
  })

  test('caps percentUsed at 100 when usage exceeds limit', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'micro',
      storageUsage: { totalBytes: BigInt(MICRO_LIMIT * 5), lastCalculatedAt: new Date() },
    }))
    findManyProject.mockImplementation(async () => [])
    const result = await getStorageUsage('ws_over')
    expect(result!.percentUsed).toBe(100)
    expect(result!.isOverLimit).toBe(true)
  })

  test('isOverLimit is true precisely when totalBytes > limitBytes (boundary check)', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: { totalBytes: BigInt(SMALL_LIMIT), lastCalculatedAt: new Date() },
    }))
    findManyProject.mockImplementation(async () => [])
    expect((await getStorageUsage('w'))!.isOverLimit).toBe(false)

    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: { totalBytes: BigInt(SMALL_LIMIT + 1), lastCalculatedAt: new Date() },
    }))
    expect((await getStorageUsage('w'))!.isOverLimit).toBe(true)
  })

  test('queries by workspaceId and selects only the needed fields', async () => {
    findUniqueWs.mockImplementation(async () => null)
    await getStorageUsage('ws_q')
    const args = findUniqueWs.mock.calls[0][0]
    expect(args.where).toEqual({ id: 'ws_q' })
    expect(args.select).toEqual({ instanceSize: true, storageUsage: true })
  })

  test('detail view carries real per-project bytes, overhead categories and history', async () => {
    const day = new Date('2026-01-15T00:00:00Z')
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: {
        totalBytes: BigInt(1000),
        billableBytes: BigInt(700),
        lastCalculatedAt: day,
        breakdown: {
          categories: { project_files: 700, quarantine: 300 },
          projects: [
            { projectId: 'p_1', bytes: 700, categories: { project_files: 700 } },
            { projectId: 'p_hidden', bytes: 0, categories: {} },
          ],
          unmeasured: ['artifacts'],
        },
      },
    }))
    findManyProject.mockImplementation(async () => [
      { id: 'p_hidden', name: 'Builder delegate', hidden: true },
      { id: 'p_1', name: 'Alpha', hidden: false },
    ])
    findManyDaily.mockImplementation(async () => [
      {
        day,
        totalBytes: BigInt(1000),
        billableBytes: BigInt(700),
        allowanceBytes: BigInt(SMALL_LIMIT),
        chargedUsd: null,
        billedAt: null,
      },
    ])

    const result = await getStorageUsage('ws_1', { detail: true, now: new Date('2026-01-15T12:00:00Z') })

    expect(result!.categories!.project_files).toBe(700)
    expect(result!.categories!.quarantine).toBe(300)
    expect(result!.categories!.assets).toBe(0) // zero-filled for every category
    expect(result!.unmeasured).toEqual(['artifacts'])
    // Sorted by bytes desc; a hidden project keeps its bytes but loses its name.
    expect(result!.projects).toEqual([
      { projectId: 'p_1', projectName: 'Alpha', hidden: false, bytes: 700 },
      { projectId: 'p_hidden', projectName: null, hidden: true, bytes: 0 },
    ])
    expect(result!.history).toHaveLength(1)
    expect(result!.history![0].day).toBe('2026-01-15')
    expect(result!.history![0].billableBytes).toBe(700)
    // 700 bytes of 5 GiB is ~0 GB-months, so the estimate is 0 — the point is
    // that the shape exists and mode is reported.
    expect(result!.month!.mode).toBeDefined()
    expect(result!.month!.billableGbMonths).toBe(0)
    expect(result!.month!.estimatedUsd).toBe(0)
  })
})

// ─── calculateWorkspaceStorageUsage ────────────────────────────────────────

describe('calculateWorkspaceStorageUsage', () => {
  test('aggregates project objects into categories and upserts the row + a daily row', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_calc', instanceSize: 'small', personalOwnerId: null },
    ])
    findUniqueWs.mockImplementation(async () => ({ instanceSize: 'small', storageUsage: null }))
    findManyProject.mockImplementation(async () => [{ id: 'p_1', workspaceId: 'ws_calc' }])
    objects.set('p_1/', [
      { relativePath: 'src/index.ts', size: 100 },
      { relativePath: 'repo.git.tar.gz', size: 200 },
      { relativePath: 'assets/hero.png', size: 30 },
      { relativePath: 'project-data.tar.gz', size: 70 },
    ])

    const result = await calculateWorkspaceStorageUsage('ws_calc')

    expect(result.totalBytes).toBe(400)
    expect(result.billableBytes).toBe(400) // nothing here is overhead
    expect(result.projectCount).toBe(1)
    expect(result.categories.project_files).toBe(100)
    expect(result.categories.repo).toBe(200)
    expect(result.categories.assets).toBe(30)
    expect(result.categories.backups).toBe(70)
    expect(result.projects).toEqual([
      {
        projectId: 'p_1',
        bytes: 400,
        categories: expect.objectContaining({ project_files: 100, repo: 200, assets: 30, backups: 70 }),
      },
    ])

    expect(upsertStorageUsage).toHaveBeenCalledTimes(1)
    const upsertArgs = upsertStorageUsage.mock.calls[0][0]
    expect(upsertArgs.where).toEqual({ workspaceId: 'ws_calc' })
    expect(upsertArgs.create.totalBytes).toBe(BigInt(400))
    expect(upsertArgs.create.billableBytes).toBe(BigInt(400))
    expect(upsertArgs.create.projectCount).toBe(1)
    expect(upsertArgs.create.lastCalculatedAt).toBeInstanceOf(Date)
    expect(upsertArgs.update.totalBytes).toBe(BigInt(400))

    // Today's history row carries the tier allowance, so the bill can compute
    // the overage without re-reading the workspace.
    expect(createDaily).toHaveBeenCalledTimes(1)
    const dailyArgs = createDaily.mock.calls[0][0]
    expect(dailyArgs.data.workspaceId).toBe('ws_calc')
    expect(dailyArgs.data.totalBytes).toBe(BigInt(400))
    expect(dailyArgs.data.allowanceBytes).toBe(BigInt(SMALL_LIMIT))
  })

  test('quarantine and VM snapshots are measured but never billable', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_over', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [{ id: 'p_1', workspaceId: 'ws_over' }])
    objects.set('p_1/', [{ relativePath: 'src/a.ts', size: 1000 }])
    // Losing a concurrent write quarantines the displaced object.
    objects.set('conflict/', [{ relativePath: 'p_1/2026-01-01-abc', size: 400 }])

    const result = await calculateWorkspaceStorageUsage('ws_over')

    expect(result.totalBytes).toBe(1400)
    expect(result.billableBytes).toBe(1000)
    expect(result.categories.quarantine).toBe(400)
    // Quarantine archives are attributed to the owning project as well.
    expect(result.projects[0].bytes).toBe(1400)
    expect(upsertStorageUsage.mock.calls[0][0].create.billableBytes).toBe(BigInt(1000))
  })

  test('postgres backups belong to their project; workspace-root is workspace-wide', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_shared', instanceSize: 'small', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [{ id: 'p_1', workspaceId: 'ws_shared' }])
    objects.set('p_1/', [{ relativePath: 'src/a.ts', size: 100 }])
    objects.set('postgres-backups/', [{ relativePath: 'p_1/daily.sql.gz', size: 50 }])
    objects.set('workspace-root/', [{ relativePath: 'ws_shared/drive.bin', size: 20 }])

    const result = await calculateWorkspaceStorageUsage('ws_shared')

    expect(result.categories.backups).toBe(50)
    expect(result.categories.workspace_root).toBe(20)
    // No project owns the workspace drive, so only the project prefix + backup
    // land on p_1.
    expect(result.projects).toEqual([
      { projectId: 'p_1', bytes: 150, categories: expect.objectContaining({ project_files: 100, backups: 50 }) },
    ])
    expect(result.totalBytes).toBe(170)
  })

  test('treats objects with a missing size as 0 bytes', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_zero', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [{ id: 'p_1', workspaceId: 'ws_zero' }])
    objects.set('p_1/', [
      { relativePath: 'src/a.ts', size: 100 },
      { relativePath: 'src/b.ts' },
      { relativePath: 'src/c.ts', size: undefined },
    ])

    const result = await calculateWorkspaceStorageUsage('ws_zero')
    expect(result.totalBytes).toBe(100)
  })

  test('a failing namespace is recorded as unmeasured, and the rest still counts', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_partial', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [
      { id: 'p_fail', workspaceId: 'ws_partial' },
      { id: 'p_ok', workspaceId: 'ws_partial' },
    ])
    objectErrors.set('p_fail/', new Error('S3 access denied'))
    objects.set('p_ok/', [{ relativePath: 'src/a.ts', size: 750 }])

    const result = await calculateWorkspaceStorageUsage('ws_partial')

    expect(result.totalBytes).toBe(750)
    expect(result.projects).toEqual([
      { projectId: 'p_ok', bytes: 750, categories: expect.objectContaining({ project_files: 750 }) },
    ])
    // A namespace we could not read is reported, never silently treated as empty.
    expect(result.unmeasured).toContain('projects/p_fail')
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('Failed to calculate storage for project p_fail')
    expect(logged).toContain('S3 access denied')
  })

  test('namespaces with no configured bucket are reported as unmeasured', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_env', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [])

    const result = await calculateWorkspaceStorageUsage('ws_env')

    expect(result.totalBytes).toBe(0)
    expect(result.unmeasured).toEqual([
      'METAL_SNAP_BUCKET',
      'PUBLISH_BUCKET',
      'PUBLISH_DATA_BUCKET',
      'artifacts',
    ])
  })

  test('the daily row keeps the day peak when a later pass is smaller', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_peak', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [{ id: 'p_1', workspaceId: 'ws_peak' }])
    objects.set('p_1/', [{ relativePath: 'src/a.ts', size: 500 }])
    // A bigger measurement already landed today.
    findUniqueDaily.mockImplementation(async () => ({ id: 'daily_1', totalBytes: BigInt(900) }))

    const result = await calculateWorkspaceStorageUsage('ws_peak')

    expect(result.totalBytes).toBe(500)
    expect(createDaily).not.toHaveBeenCalled()
    expect(updateDaily).not.toHaveBeenCalled() // 500 < 900 → keep the peak
  })

  test('the daily row is overwritten when the peak grows', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_grow', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [{ id: 'p_1', workspaceId: 'ws_grow' }])
    objects.set('p_1/', [{ relativePath: 'src/a.ts', size: 900 }])
    findUniqueDaily.mockImplementation(async () => ({ id: 'daily_1', totalBytes: BigInt(500) }))

    await calculateWorkspaceStorageUsage('ws_grow')

    expect(createDaily).not.toHaveBeenCalled()
    expect(updateDaily).toHaveBeenCalledTimes(1)
    const updateArgs = updateDaily.mock.calls[0][0]
    expect(updateArgs.where).toEqual({ id: 'daily_1' })
    expect(updateArgs.data.totalBytes).toBe(BigInt(900))
  })

  test('published bundles count per subdomain and land on their project too', async () => {
    process.env.PUBLISH_BUCKET = 'shogo-publish'
    findManyWs.mockImplementation(async () => [
      { id: 'ws_pub', instanceSize: 'small', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [{ id: 'p_live', workspaceId: 'ws_pub' }])
    findManyPublishedEnvironment.mockImplementation(async () => [
      { subdomain: 'demo-abc123', projectId: 'p_live' },
    ])
    objects.set('p_live/', [{ relativePath: 'src/a.ts', size: 100 }])
    // The publish bucket keys every object by subdomain.
    objects.set('', [{ relativePath: 'demo-abc123/index.html', size: 400 }])

    const result = await calculateWorkspaceStorageUsage('ws_pub')

    expect(result.categories.published).toBe(400)
    expect(result.totalBytes).toBe(500)
    // The project list has to reconcile with the "Published sites" row, so the
    // bundle is attributed to the project that owns the subdomain.
    expect(result.projects).toEqual([
      {
        projectId: 'p_live',
        bytes: 500,
        categories: expect.objectContaining({ project_files: 100, published: 400 }),
      },
    ])
  })

  test('a published subdomain with no owning project is not counted', async () => {
    process.env.PUBLISH_BUCKET = 'shogo-publish'
    findManyWs.mockImplementation(async () => [
      { id: 'ws_orphan', instanceSize: 'small', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [])
    findManyPublishedEnvironment.mockImplementation(async () => [])
    objects.set('', [{ relativePath: 'someone-else/index.html', size: 900 }])

    const result = await calculateWorkspaceStorageUsage('ws_orphan')

    expect(result.totalBytes).toBe(0)
    expect(result.categories.published).toBe(0)
  })

  test('a workspace deleted mid-pass reports zeros and writes nothing', async () => {
    findManyWs.mockImplementation(async () => [])
    const result = await calculateWorkspaceStorageUsage('ws_gone')
    expect(result.totalBytes).toBe(0)
    expect(result.projectCount).toBe(0)
    expect(result.projects).toEqual([])
    expect(upsertStorageUsage).not.toHaveBeenCalled()
    expect(createDaily).not.toHaveBeenCalled()
  })

  test('upserts BigInt totalBytes (preserves > 2^53 sizes)', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_huge', instanceSize: 'small', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [{ id: 'p_huge', workspaceId: 'ws_huge' }])
    objects.set('p_huge/', [{ relativePath: 'src/a.ts', size: 1234567890 }])

    await calculateWorkspaceStorageUsage('ws_huge')

    const created = upsertStorageUsage.mock.calls[0][0].create
    expect(created.totalBytes).toBe(BigInt(1234567890))
    expect(typeof created.totalBytes).toBe('bigint')
  })
})

// ─── isOverStorageLimit ────────────────────────────────────────────────────

describe('isOverStorageLimit', () => {
  test('returns false when workspace is missing', async () => {
    findUniqueWs.mockImplementation(async () => null)
    expect(await isOverStorageLimit('w')).toBe(false)
  })

  test('returns false when workspace has no storageUsage row yet', async () => {
    findUniqueWs.mockImplementation(async () => ({ instanceSize: 'small', storageUsage: null }))
    expect(await isOverStorageLimit('w')).toBe(false)
  })

  test('returns false when usage is at or below the limit', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: { totalBytes: BigInt(SMALL_LIMIT) },
    }))
    expect(await isOverStorageLimit('w')).toBe(false)
  })

  test('returns true when usage exceeds the limit', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: { totalBytes: BigInt(SMALL_LIMIT + 1) },
    }))
    expect(await isOverStorageLimit('w')).toBe(true)
  })

  test('queries only the fields it needs (instanceSize + storageUsage.totalBytes)', async () => {
    findUniqueWs.mockImplementation(async () => null)
    await isOverStorageLimit('w')
    expect(findUniqueWs.mock.calls[0][0].select).toEqual({
      instanceSize: true,
      storageUsage: { select: { totalBytes: true } },
    })
  })
})

// ─── recalculateAllStorageUsage ────────────────────────────────────────────

describe('recalculateAllStorageUsage', () => {
  test('sweeps every home workspace, one measurement for the fleet', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_a', instanceSize: 'micro', personalOwnerId: null },
      { id: 'ws_b', instanceSize: 'micro', personalOwnerId: null },
      { id: 'ws_c', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [])

    const outcome = await recalculateAllStorageUsage()

    expect(outcome).toEqual({ status: 'ran', workspaces: 3 })
    expect(upsertStorageUsage).toHaveBeenCalledTimes(3)
    const wsIds = upsertStorageUsage.mock.calls.map((c) => c[0].where.workspaceId).sort()
    expect(wsIds).toEqual(['ws_a', 'ws_b', 'ws_c'])
  })

  test('continues processing remaining workspaces when one write fails', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_fail', instanceSize: 'micro', personalOwnerId: null },
      { id: 'ws_ok', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [])
    upsertStorageUsage.mockImplementation(async (args: any) => {
      if (args.where.workspaceId === 'ws_fail') throw new Error('db error on ws_fail')
      return {}
    })

    await recalculateAllStorageUsage()

    expect(upsertStorageUsage).toHaveBeenCalledTimes(2)
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('Failed to recalculate for workspace ws_fail')
  })

  test('logs the start + completion messages', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_1', instanceSize: 'micro', personalOwnerId: null },
      { id: 'ws_2', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [])

    await recalculateAllStorageUsage()

    const logs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logs).toContain('Recalculating storage for 2 workspaces')
    expect(logs).toContain('Recalculation complete')
  })

  test('handles zero workspaces gracefully', async () => {
    findManyWs.mockImplementation(async () => [])
    await recalculateAllStorageUsage()
    expect(upsertStorageUsage).not.toHaveBeenCalled()
    const logs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logs).toContain('Recalculating storage for 0 workspaces')
    expect(logs).toContain('Recalculation complete')
  })

  test('skips the whole sweep when a pass finished inside the freshness window', async () => {
    aggregateStorageUsage.mockImplementation(async () => ({
      _max: { lastCalculatedAt: new Date(Date.now() - 60 * 60 * 1000) },
    }))
    const outcome = await recalculateAllStorageUsage()
    expect(outcome).toEqual({ status: 'fresh' })
    expect(findManyWs).not.toHaveBeenCalled()
    expect(listAllObjectsInS3).not.toHaveBeenCalled()
    expect(upsertStorageUsage).not.toHaveBeenCalled()
  })

  test('runs when the last pass is exactly STORAGE_RECALC_MIN_GAP_MS old', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_1', instanceSize: 'micro', personalOwnerId: null },
    ])
    findManyProject.mockImplementation(async () => [])
    aggregateStorageUsage.mockImplementation(async () => ({
      _max: { lastCalculatedAt: new Date(Date.now() - STORAGE_RECALC_MIN_GAP_MS) },
    }))

    const outcome = await recalculateAllStorageUsage()
    expect(outcome).toEqual({ status: 'ran', workspaces: 1 })
    expect(upsertStorageUsage).toHaveBeenCalledTimes(1)
  })

  test('reports locked and scans nothing when another pod holds the lock', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_1', instanceSize: 'micro', personalOwnerId: null },
    ])
    lockState.heldElsewhere = true

    const outcome = await recalculateAllStorageUsage()

    expect(outcome).toEqual({ status: 'locked' })
    expect(aggregateStorageUsage).not.toHaveBeenCalled()
    expect(findManyWs).not.toHaveBeenCalled()
    expect(listAllObjectsInS3).not.toHaveBeenCalled()
    expect(upsertStorageUsage).not.toHaveBeenCalled()
  })
})
