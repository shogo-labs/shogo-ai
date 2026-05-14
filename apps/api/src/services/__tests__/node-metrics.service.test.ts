// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Set env BEFORE importing the SUT — SIGNOZ_ENDPOINT is captured at module
// load time as a constant. The "no-endpoint fallback" branch is tested in
// a sibling test file (or could be tested by re-importing under a fresh
// module specifier — we keep this file focused on the endpoint-present
// flow for stability).
process.env.SIGNOZ_QUERY_ENDPOINT = 'http://signoz.example.com'
process.env.SIGNOZ_INGESTION_KEY = 'test-key'

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

let workspaceImpl: (id: string) => Promise<any | null> = async () => ({ id: 'ws-1' })
let projectsImpl: (args: any) => Promise<Array<{ id: string }>> = async () => []

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async (args: any) => workspaceImpl(args.where.id),
    },
    project: {
      findMany: async (args: any) => projectsImpl(args),
    },
  },
}))

const { getWorkspaceMetrics } = await import('../node-metrics.service')

let fetchSpy: ReturnType<typeof spyOn>
let fetchImpl: (url: string, init: any) => Promise<Response> = async () =>
  new Response(JSON.stringify({ data: { result: [] } }), { status: 200 })
let errorSpy: any

beforeEach(() => {
  workspaceImpl = async () => ({ id: 'ws-1' })
  projectsImpl = async () => []
  fetchImpl = async () =>
    new Response(JSON.stringify({ data: { result: [] } }), { status: 200 })
  fetchSpy = spyOn(global, 'fetch').mockImplementation(((url: any, init: any) =>
    fetchImpl(String(url), init)) as any)
  errorSpy = mock(() => {})
  console.error = errorSpy as any
})

afterEach(() => {
  fetchSpy.mockRestore()
})

function emptyFallback(period: string) {
  return {
    current: { cpuPercent: 0, memoryBytes: 0, memoryTotalBytes: 0 },
    history: { timestamps: [], cpuPercent: [], memoryBytes: [] },
    period,
  }
}

describe('getWorkspaceMetrics', () => {
  it('returns null when the workspace is not found', async () => {
    workspaceImpl = async () => null
    expect(await getWorkspaceMetrics('missing')).toBeNull()
  })

  it('returns fallback (zeros) when workspace exists but has no Knative-backed projects', async () => {
    projectsImpl = async () => []
    const res = await getWorkspaceMetrics('ws-1', '24h')
    expect(res).toEqual(emptyFallback('24h'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('defaults the period to 24h when omitted', async () => {
    projectsImpl = async () => []
    const res = await getWorkspaceMetrics('ws-1')
    expect(res!.period).toBe('24h')
  })

  it('queries CPU and memory in parallel and maps the result series', async () => {
    projectsImpl = async () => [{ id: 'p1' }, { id: 'p2' }]
    const calls: string[] = []
    fetchImpl = async (url) => {
      calls.push(url)
      const isCpu = url.includes('cpu_time')
      const series = isCpu
        ? [
            [100, '5.5'],
            [200, '6.5'],
          ]
        : [
            [100, '1000'],
            [200, '2000'],
          ]
      return new Response(JSON.stringify({ data: { result: [{ values: series }] } }), {
        status: 200,
      })
    }
    const res = await getWorkspaceMetrics('ws-1', '1h')
    expect(res!.history.timestamps).toEqual([100_000, 200_000])
    expect(res!.history.cpuPercent).toEqual([5.5, 6.5])
    expect(res!.history.memoryBytes).toEqual([1000, 2000])
    expect(res!.current.cpuPercent).toBe(6.5)
    expect(res!.current.memoryBytes).toBe(2000)
    expect(res!.current.memoryTotalBytes).toBe(0)
    expect(calls).toHaveLength(2)
  })

  it('includes only Knative-backed projects in the pod filter', async () => {
    let capturedQuery = ''
    projectsImpl = async (args) => {
      expect(args.where.knativeServiceName).toEqual({ not: null })
      return [{ id: 'p-abc' }, { id: 'p-xyz' }]
    }
    fetchImpl = async (url) => {
      const u = new URL(url)
      capturedQuery = u.searchParams.get('query') ?? ''
      return new Response(JSON.stringify({ data: { result: [] } }), { status: 200 })
    }
    await getWorkspaceMetrics('ws-1', '6h')
    expect(capturedQuery).toContain('project-p-abc')
    expect(capturedQuery).toContain('project-p-xyz')
    expect(capturedQuery).toContain('|')
  })

  it('sends the signoz-access-token header when SIGNOZ_INGESTION_KEY is set', async () => {
    projectsImpl = async () => [{ id: 'p1' }]
    let capturedHeaders: Record<string, string> = {}
    fetchImpl = async (_url, init) => {
      capturedHeaders = init.headers
      return new Response(JSON.stringify({ data: { result: [] } }), { status: 200 })
    }
    await getWorkspaceMetrics('ws-1', '1h')
    expect(capturedHeaders['signoz-access-token']).toBe('test-key')
    expect(capturedHeaders['Content-Type']).toBe('application/json')
  })

  it('passes the right start/end/step query params for each period', async () => {
    projectsImpl = async () => [{ id: 'p1' }]
    const fixedNow = 1_700_000_000_000
    const dateSpy = spyOn(Date, 'now').mockReturnValue(fixedNow)
    try {
      let capturedStart = 0
      let capturedEnd = 0
      let capturedStep = 0
      fetchImpl = async (url) => {
        const u = new URL(url)
        capturedStart = Number(u.searchParams.get('start'))
        capturedEnd = Number(u.searchParams.get('end'))
        capturedStep = Number(u.searchParams.get('step'))
        return new Response(JSON.stringify({ data: { result: [] } }), { status: 200 })
      }
      await getWorkspaceMetrics('ws-1', '7d')
      const expectedEnd = Math.floor(fixedNow / 1000)
      expect(capturedEnd).toBe(expectedEnd)
      expect(capturedStart).toBe(expectedEnd - 604800)
      expect(capturedStep).toBe(3600)
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('returns fallback and logs error when SigNoz responds non-2xx', async () => {
    projectsImpl = async () => [{ id: 'p1' }]
    fetchImpl = async () =>
      new Response('boom', { status: 503, statusText: 'Service Unavailable' })
    const res = await getWorkspaceMetrics('ws-1', '24h')
    expect(res).toEqual(emptyFallback('24h'))
    expect(errorSpy).toHaveBeenCalled()
    const msg = (errorSpy.mock.calls.flat() ?? []).join(' ')
    expect(msg).toContain('SigNoz')
  })

  it('returns fallback when fetch throws', async () => {
    projectsImpl = async () => [{ id: 'p1' }]
    fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    const res = await getWorkspaceMetrics('ws-1', '24h')
    expect(res).toEqual(emptyFallback('24h'))
    expect(errorSpy).toHaveBeenCalled()
  })

  it('coerces non-numeric SigNoz values to 0', async () => {
    projectsImpl = async () => [{ id: 'p1' }]
    fetchImpl = async (url) => {
      const isCpu = url.includes('cpu_time')
      const series = isCpu
        ? [
            [100, 'NaN'],
            [200, ''],
          ]
        : [
            [100, 'abc'],
            [200, '500'],
          ]
      return new Response(JSON.stringify({ data: { result: [{ values: series }] } }), {
        status: 200,
      })
    }
    const res = await getWorkspaceMetrics('ws-1', '1h')
    expect(res!.history.cpuPercent).toEqual([0, 0])
    expect(res!.history.memoryBytes).toEqual([0, 500])
    expect(res!.current.memoryBytes).toBe(500)
  })

  it('returns empty arrays when SigNoz result has no values entry', async () => {
    projectsImpl = async () => [{ id: 'p1' }]
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: { result: [] } }), { status: 200 })
    const res = await getWorkspaceMetrics('ws-1', '1h')
    expect(res!.history.timestamps).toEqual([])
    expect(res!.history.cpuPercent).toEqual([])
    expect(res!.history.memoryBytes).toEqual([])
    expect(res!.current.cpuPercent).toBe(0)
    expect(res!.current.memoryBytes).toBe(0)
  })

  it('handles malformed JSON shape gracefully (no result key)', async () => {
    projectsImpl = async () => [{ id: 'p1' }]
    fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 })
    const res = await getWorkspaceMetrics('ws-1', '1h')
    expect(res!.history.timestamps).toEqual([])
  })

  it('rolls each supported period through without crashing', async () => {
    projectsImpl = async () => [{ id: 'p1' }]
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: { result: [{ values: [] }] } }), { status: 200 })
    for (const p of ['1h', '6h', '24h', '7d', '30d'] as const) {
      const res = await getWorkspaceMetrics('ws-1', p)
      expect(res!.period).toBe(p)
    }
  })
})
