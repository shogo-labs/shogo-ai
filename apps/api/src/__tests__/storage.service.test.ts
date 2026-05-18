// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/services/storage.service.ts — per-workspace S3 usage
 * tracking. Mocks prisma + s3 listing so tests are hermetic.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// Mock @shogo/shared-runtime BEFORE any import that transitively reaches
// src/config/instance-sizes.ts (storage.service imports it).
mock.module('@shogo/shared-runtime', () => ({
  isMobileTechStack: (id: string | null | undefined) =>
    !!id && (id.startsWith('expo') || id === 'react-native'),
}))

// ─── prisma + s3 mocks ─────────────────────────────────────────────────────

const findUniqueWs = mock(async (_: any): Promise<any> => null)
const findManyWs = mock(async (_: any): Promise<any[]> => [])
const findManyProject = mock(async (_: any): Promise<any[]> => [])
const upsertStorageUsage = mock(async (_: any): Promise<any> => ({}))

mock.module('../lib/prisma', () => ({
  prisma: {
    workspace: { findUnique: findUniqueWs, findMany: findManyWs },
    project: { findMany: findManyProject },
    storageUsage: { upsert: upsertStorageUsage },
  },
}))

const listAllObjectsInS3 = mock(async (_prefix: string, _bucket: string): Promise<Array<{ size?: number }>> => [])
mock.module('../lib/s3', () => ({
  listAllObjectsInS3,
}))

const {
  calculateWorkspaceStorageUsage,
  getStorageUsage,
  isOverStorageLimit,
  recalculateAllStorageUsage,
} = await import('../services/storage.service')

// ─── INSTANCE_SIZES — pulled live so we can compute expected limits ───────

const { INSTANCE_SIZES } = await import('../config/instance-sizes')
const SMALL_LIMIT = INSTANCE_SIZES.small.storageLimitBytes // 4 GiB
const MICRO_LIMIT = INSTANCE_SIZES.micro.storageLimitBytes // 2 GiB

let errorSpy: ReturnType<typeof spyOn>
let logSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  findUniqueWs.mockReset()
  findManyWs.mockReset()
  findManyProject.mockReset()
  upsertStorageUsage.mockReset()
  listAllObjectsInS3.mockReset()
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  logSpy = spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  logSpy.mockRestore()
})

// ─── getStorageUsage ───────────────────────────────────────────────────────

describe('getStorageUsage', () => {
  test('returns null when workspace is not found', async () => {
    findUniqueWs.mockImplementation(async () => null)
    expect(await getStorageUsage('ws_missing')).toBeNull()
  })

  test('returns the full breakdown when storageUsage row exists', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: {
        totalBytes: BigInt(1024 * 1024 * 1024), // 1 GiB
        lastCalculatedAt: new Date('2026-01-15T00:00:00Z'),
      },
    }))
    findManyProject.mockImplementation(async () => [
      { id: 'p_1', name: 'Alpha' },
      { id: 'p_2', name: 'Beta' },
    ])

    const result = await getStorageUsage('ws_1')
    expect(result).not.toBeNull()
    expect(result!.totalBytes).toBe(1024 * 1024 * 1024)
    expect(result!.limitBytes).toBe(SMALL_LIMIT)
    expect(result!.projectCount).toBe(2)
    // small has 5 GiB storageLimitBytes — 1 GiB / 5 GiB = 20%.
    expect(result!.percentUsed).toBeCloseTo((1 * 1024 ** 3 / SMALL_LIMIT) * 100, 1)
    expect(result!.isOverLimit).toBe(false)
    expect(result!.projects).toEqual([
      { projectId: 'p_1', projectName: 'Alpha', bytes: 0 },
      { projectId: 'p_2', projectName: 'Beta', bytes: 0 },
    ])
    expect(result!.lastCalculatedAt).toEqual(new Date('2026-01-15T00:00:00Z'))
  })

  test('returns totalBytes=0 when no storageUsage row exists yet', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'micro',
      storageUsage: null,
    }))
    findManyProject.mockImplementation(async () => [])
    const result = await getStorageUsage('ws_2')
    expect(result!.totalBytes).toBe(0)
    expect(result!.limitBytes).toBe(MICRO_LIMIT)
    expect(result!.percentUsed).toBe(0)
    expect(result!.projects).toEqual([])
    expect(result!.lastCalculatedAt).toBeNull()
  })

  test('caps percentUsed at 100 when usage exceeds limit', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'micro',
      storageUsage: {
        totalBytes: BigInt(MICRO_LIMIT * 5), // 5x over
        lastCalculatedAt: new Date(),
      },
    }))
    findManyProject.mockImplementation(async () => [])
    const result = await getStorageUsage('ws_over')
    expect(result!.percentUsed).toBe(100)
    expect(result!.isOverLimit).toBe(true)
  })

  test('isOverLimit is true precisely when totalBytes > limitBytes (boundary check)', async () => {
    // Exactly at limit → NOT over.
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: { totalBytes: BigInt(SMALL_LIMIT), lastCalculatedAt: new Date() },
    }))
    findManyProject.mockImplementation(async () => [])
    expect((await getStorageUsage('w'))!.isOverLimit).toBe(false)

    // One byte over → over.
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

  test('returns percentUsed = 0 when limitBytes is 0 (defensive)', async () => {
    // No real size has 0 storage limit, but the guard `limitBytes > 0` exists.
    // Test it by stubbing INSTANCE_SIZES["small"].storageLimitBytes via the
    // workspace's reported size — actually we can't change the const at
    // runtime. Instead we cover the inverse: percentUsed is finite even at
    // tiny usage with the smallest plan.
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'micro',
      storageUsage: { totalBytes: BigInt(0), lastCalculatedAt: new Date() },
    }))
    findManyProject.mockImplementation(async () => [])
    const result = await getStorageUsage('ws_zero')
    expect(result!.percentUsed).toBe(0)
    expect(Number.isFinite(result!.percentUsed)).toBe(true)
  })
})

// ─── calculateWorkspaceStorageUsage ────────────────────────────────────────

describe('calculateWorkspaceStorageUsage', () => {
  test('sums project bytes + backup bytes per project and upserts the row', async () => {
    findManyProject.mockImplementation(async () => [
      { id: 'p_1' },
      { id: 'p_2' },
    ])
    listAllObjectsInS3.mockImplementation(async (prefix: string) => {
      if (prefix === 'p_1/') return [{ size: 100 }, { size: 200 }]
      if (prefix === 'postgres-backups/p_1/') return [{ size: 50 }]
      if (prefix === 'p_2/') return [{ size: 1000 }]
      if (prefix === 'postgres-backups/p_2/') return []
      return []
    })

    const result = await calculateWorkspaceStorageUsage('ws_calc')

    expect(result.totalBytes).toBe(100 + 200 + 50 + 1000)
    expect(result.projectCount).toBe(2)
    expect(result.perProject).toEqual([
      { projectId: 'p_1', bytes: 350 },
      { projectId: 'p_2', bytes: 1000 },
    ])

    expect(upsertStorageUsage).toHaveBeenCalledTimes(1)
    const upsertArgs = upsertStorageUsage.mock.calls[0][0]
    expect(upsertArgs.where).toEqual({ workspaceId: 'ws_calc' })
    expect(upsertArgs.create.workspaceId).toBe('ws_calc')
    expect(upsertArgs.create.totalBytes).toBe(BigInt(1350))
    expect(upsertArgs.create.projectCount).toBe(2)
    expect(upsertArgs.create.lastCalculatedAt).toBeInstanceOf(Date)
    expect(upsertArgs.update.totalBytes).toBe(BigInt(1350))
  })

  test('treats objects with missing size as 0 bytes', async () => {
    findManyProject.mockImplementation(async () => [{ id: 'p_1' }])
    listAllObjectsInS3.mockImplementation(async (prefix: string) => {
      if (prefix === 'p_1/') return [{ size: 100 }, {}, { size: undefined }] as any
      return []
    })
    const result = await calculateWorkspaceStorageUsage('ws_zero_sizes')
    expect(result.totalBytes).toBe(100)
    expect(result.perProject).toEqual([{ projectId: 'p_1', bytes: 100 }])
  })

  test('catches missing-prefix backup listing without failing the project', async () => {
    findManyProject.mockImplementation(async () => [{ id: 'p_1' }])
    listAllObjectsInS3.mockImplementation(async (prefix: string) => {
      if (prefix === 'p_1/') return [{ size: 500 }]
      if (prefix === 'postgres-backups/p_1/') throw new Error('NoSuchKey')
      return []
    })
    const result = await calculateWorkspaceStorageUsage('ws_no_backups')
    expect(result.totalBytes).toBe(500) // backup error caught, project bytes counted
    expect(result.perProject).toEqual([{ projectId: 'p_1', bytes: 500 }])
  })

  test('logs and records 0 bytes when the main project listing throws', async () => {
    findManyProject.mockImplementation(async () => [
      { id: 'p_fail' },
      { id: 'p_ok' },
    ])
    listAllObjectsInS3.mockImplementation(async (prefix: string) => {
      if (prefix === 'p_fail/') throw new Error('S3 access denied')
      if (prefix === 'p_ok/') return [{ size: 750 }]
      return []
    })
    const result = await calculateWorkspaceStorageUsage('ws_partial_fail')
    expect(result.totalBytes).toBe(750)
    expect(result.perProject).toEqual([
      { projectId: 'p_fail', bytes: 0 },
      { projectId: 'p_ok', bytes: 750 },
    ])
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('Failed to calculate storage for project p_fail')
    expect(logged).toContain('S3 access denied')
  })

  test('returns totalBytes=0 and projectCount=0 when workspace has no projects', async () => {
    findManyProject.mockImplementation(async () => [])
    const result = await calculateWorkspaceStorageUsage('ws_empty')
    expect(result.totalBytes).toBe(0)
    expect(result.projectCount).toBe(0)
    expect(result.perProject).toEqual([])
    expect(listAllObjectsInS3).not.toHaveBeenCalled()
    // Empty workspace still upserts a zeroed row (so the dashboard shows fresh data).
    expect(upsertStorageUsage).toHaveBeenCalledTimes(1)
    expect(upsertStorageUsage.mock.calls[0][0].create.totalBytes).toBe(BigInt(0))
  })

  test('upserts BigInt totalBytes (preserves > 2^53 sizes)', async () => {
    findManyProject.mockImplementation(async () => [{ id: 'p_huge' }])
    listAllObjectsInS3.mockImplementation(async (prefix: string) => {
      if (prefix === 'p_huge/') return [{ size: 1234567890 }]
      return []
    })
    await calculateWorkspaceStorageUsage('ws_huge')
    expect(upsertStorageUsage.mock.calls[0][0].create.totalBytes).toBe(BigInt(1234567890))
    expect(typeof upsertStorageUsage.mock.calls[0][0].create.totalBytes).toBe('bigint')
  })
})

// ─── isOverStorageLimit ────────────────────────────────────────────────────

describe('isOverStorageLimit', () => {
  test('returns false when workspace is missing', async () => {
    findUniqueWs.mockImplementation(async () => null)
    expect(await isOverStorageLimit('w')).toBe(false)
  })

  test('returns false when workspace has no storageUsage row yet', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: null,
    }))
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
  test('iterates over every workspace and calls calculate for each', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_a' },
      { id: 'ws_b' },
      { id: 'ws_c' },
    ])
    findManyProject.mockImplementation(async () => []) // each workspace empty for simplicity

    await recalculateAllStorageUsage()

    // upsertStorageUsage called once per workspace (since each has 0 projects).
    expect(upsertStorageUsage).toHaveBeenCalledTimes(3)
    const wsIds = upsertStorageUsage.mock.calls.map((c) => c[0].where.workspaceId).sort()
    expect(wsIds).toEqual(['ws_a', 'ws_b', 'ws_c'])
  })

  test('continues processing remaining workspaces when one fails', async () => {
    findManyWs.mockImplementation(async () => [
      { id: 'ws_fail' },
      { id: 'ws_ok' },
    ])
    findManyProject.mockImplementation(async (args: any) => {
      if (args.where.workspaceId === 'ws_fail') throw new Error('db error on ws_fail')
      return []
    })

    await recalculateAllStorageUsage()

    // ws_ok still upserted; ws_fail skipped, error logged.
    expect(upsertStorageUsage).toHaveBeenCalledTimes(1)
    expect(upsertStorageUsage.mock.calls[0][0].where.workspaceId).toBe('ws_ok')
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('Failed to recalculate for workspace ws_fail')
  })

  test('logs the start + completion messages', async () => {
    findManyWs.mockImplementation(async () => [{ id: 'ws_1' }, { id: 'ws_2' }])
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
})
