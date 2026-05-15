// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for src/services/node-metrics.service.ts — SigNoz query proxy.
 *
 * SIGNOZ_ENDPOINT and SIGNOZ_INGESTION_KEY are captured at module-load
 * time, so we set them BEFORE the dynamic import.
 */

process.env.SIGNOZ_QUERY_ENDPOINT = 'http://signoz.test'
process.env.SIGNOZ_INGESTION_KEY = 'test-signoz-key'

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

const findUniqueWorkspace = mock(async (_: any) => ({ id: 'ws_1' }) as any)
const findManyProjects = mock(async (_: any) => [] as any[])
mock.module('../lib/prisma', () => ({
  prisma: {
    workspace: { findUnique: findUniqueWorkspace },
    project: { findMany: findManyProjects },
  },
}))

const { getWorkspaceMetrics } = await import('../services/node-metrics.service')

const realFetch = globalThis.fetch
let fetchSpy: ReturnType<typeof mock>

beforeEach(() => {
  findUniqueWorkspace.mockReset()
  findManyProjects.mockReset()
  findUniqueWorkspace.mockImplementation(async () => ({ id: 'ws_1' }) as any)
  findManyProjects.mockImplementation(async () => [])

  fetchSpy = mock(async () => ({
    ok: true,
    json: async () => ({
      data: { result: [{ values: [[1000, '12.3'], [1060, '15.5']] }] },
    }),
  })) as unknown as ReturnType<typeof mock>
  globalThis.fetch = fetchSpy as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('getWorkspaceMetrics — workspace lookup', () => {
  test('returns null when the workspace does not exist', async () => {
    findUniqueWorkspace.mockImplementation(async () => null)
    const result = await getWorkspaceMetrics('ws_missing', '24h')
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('looks up the workspace by id with the narrow id-only select', async () => {
    findUniqueWorkspace.mockImplementation(async () => ({ id: 'ws_xyz' }) as any)
    await getWorkspaceMetrics('ws_xyz', '24h')
    expect(findUniqueWorkspace).toHaveBeenCalledTimes(1)
    expect(findUniqueWorkspace.mock.calls[0][0]).toEqual({
      where: { id: 'ws_xyz' },
      select: { id: true },
    })
  })
})

describe('getWorkspaceMetrics — no projects fallback', () => {
  test('returns the zero-fill fallback shape when the workspace has no projects', async () => {
    findManyProjects.mockImplementation(async () => [])
    const result = await getWorkspaceMetrics('ws_1', '24h')
    expect(result).toEqual({
      current: { cpuPercent: 0, memoryBytes: 0, memoryTotalBytes: 0 },
      history: { timestamps: [], cpuPercent: [], memoryBytes: [] },
      period: '24h',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('queries projects filtered to those with a knativeServiceName', async () => {
    findManyProjects.mockImplementation(async () => [])
    await getWorkspaceMetrics('ws_1', '24h')
    const args = findManyProjects.mock.calls[0][0]
    expect(args.where).toEqual({
      workspaceId: 'ws_1',
      knativeServiceName: { not: null },
    })
    expect(args.select).toEqual({ id: true })
  })
})

describe('getWorkspaceMetrics — SigNoz query success', () => {
  beforeEach(() => {
    findManyProjects.mockImplementation(async () => [{ id: 'proj_a' }, { id: 'proj_b' }])
  })

  test('issues two parallel SigNoz queries (cpu + memory)', async () => {
    await getWorkspaceMetrics('ws_1', '24h')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('builds the pod-name regex filter from project ids', async () => {
    await getWorkspaceMetrics('ws_1', '24h')
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('project-proj_a.*')
    expect(url).toContain('project-proj_b.*')
    expect(decodeURIComponent(url)).toContain('k8s_pod_name=~')
  })

  test('parses time-series values into timestamps + cpu + memory arrays', async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        data: { result: [{ values: [[1000, '12.3'], [1060, '15.5']] }] },
      }),
    }))
    const result = await getWorkspaceMetrics('ws_1', '24h')
    expect(result?.history.timestamps).toEqual([1000 * 1000, 1060 * 1000])
    expect(result?.history.cpuPercent).toEqual([12.3, 15.5])
    expect(result?.history.memoryBytes).toEqual([12.3, 15.5])
  })

  test('current.cpuPercent / memoryBytes track the LAST point in the series', async () => {
    const result = await getWorkspaceMetrics('ws_1', '24h')
    expect(result?.current.cpuPercent).toBe(15.5)
    expect(result?.current.memoryBytes).toBe(15.5)
    expect(result?.current.memoryTotalBytes).toBe(0) // hardcoded
  })

  test('handles non-numeric values (parseFloat fallback to 0)', async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        data: { result: [{ values: [[1000, 'NaN'], [1060, '42']] }] },
      }),
    }))
    const result = await getWorkspaceMetrics('ws_1', '24h')
    expect(result?.history.cpuPercent).toEqual([0, 42])
  })

  test('returns empty arrays when SigNoz response is missing result.values', async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ data: { result: [] } }),
    }))
    const result = await getWorkspaceMetrics('ws_1', '24h')
    expect(result?.history.timestamps).toEqual([])
    expect(result?.current.cpuPercent).toBe(0)
  })

  test('attaches signoz-access-token header when SIGNOZ_KEY is set', async () => {
    await getWorkspaceMetrics('ws_1', '24h')
    const headers = fetchSpy.mock.calls[0][1].headers
    expect(headers['signoz-access-token']).toBe('test-signoz-key')
  })

  test('uses correct start/end/step query params for each period', async () => {
    await getWorkspaceMetrics('ws_1', '1h')
    const url1h = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(url1h.searchParams.get('step')).toBe('60')
    const startS = Number(url1h.searchParams.get('start'))
    const endS = Number(url1h.searchParams.get('end'))
    expect(endS - startS).toBe(3600)
  })

  test('30d period uses the largest window + step', async () => {
    fetchSpy.mockClear()
    await getWorkspaceMetrics('ws_1', '30d')
    const u = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(u.searchParams.get('step')).toBe('14400')
    expect(Number(u.searchParams.get('end')) - Number(u.searchParams.get('start'))).toBe(
      2592000
    )
  })

  test('result period field echoes the requested period', async () => {
    const r = await getWorkspaceMetrics('ws_1', '7d')
    expect(r?.period).toBe('7d')
  })

  test('defaults to 24h period when not specified', async () => {
    fetchSpy.mockClear()
    const r = await getWorkspaceMetrics('ws_1')
    expect(r?.period).toBe('24h')
    const u = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(u.searchParams.get('step')).toBe('900')
  })
})

describe('getWorkspaceMetrics — SigNoz failure handling', () => {
  beforeEach(() => {
    findManyProjects.mockImplementation(async () => [{ id: 'proj_a' }])
  })

  test('returns zero-fill fallback when SigNoz returns non-2xx', async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    }))
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const result = await getWorkspaceMetrics('ws_1', '24h')
    expect(result).toEqual({
      current: { cpuPercent: 0, memoryBytes: 0, memoryTotalBytes: 0 },
      history: { timestamps: [], cpuPercent: [], memoryBytes: [] },
      period: '24h',
    })
    expect(errorSpy.mock.calls.some((c) => c.join(' ').includes('SigNoz query failed'))).toBe(true)
    expect(errorSpy.mock.calls.some((c) => c.join(' ').includes('ws_1'))).toBe(true)
    errorSpy.mockRestore()
  })

  test('returns zero-fill fallback when fetch throws (network error)', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const result = await getWorkspaceMetrics('ws_1', '24h')
    expect(result?.current.cpuPercent).toBe(0)
    expect(errorSpy.mock.calls.some((c) => c.join(' ').includes('ECONNREFUSED'))).toBe(true)
    errorSpy.mockRestore()
  })
})
