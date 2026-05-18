// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// ---- Mock the dynamic-imported helpers BEFORE importing the collector ----

let extendedStatus: any = null
let listServicesImpl: any = async () => []
let listServicesThrows: Error | null = null

mock.module('../lib/warm-pool-controller', () => ({
  getWarmPoolController: () => ({
    getExtendedStatus: async () => extendedStatus,
  }),
}))

mock.module('../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({
    listAllServices: async () => {
      if (listServicesThrows) throw listServicesThrows
      return listServicesImpl()
    },
  }),
}))

const { startInfraMetricsCollector, stopInfraMetricsCollector } = await import(
  '../lib/infra-metrics-collector'
)

// ---- Fake prisma with assertable spies ----

function makePrisma() {
  const create = mock(async (_args: any) => ({}))
  const deleteMany = mock(async (_args: any) => ({ count: 0 }))
  return {
    create,
    deleteMany,
    prisma: {
      infraSnapshot: { create, deleteMany },
    } as any,
  }
}

// ---- Lifecycle: ensure timers are always cleared between tests ----

afterEach(() => {
  stopInfraMetricsCollector()
})

beforeEach(() => {
  extendedStatus = {
    cluster: {
      totalNodes: 5,
      asgDesired: 4,
      asgMax: 10,
      totalPodSlots: 100,
      usedPodSlots: 40,
      totalCpuMillis: 8000,
      usedCpuMillis: 3000,
      limitCpuMillis: 6000,
    },
    available: 3,
    targetSize: 5,
    assigned: 2,
    gcStats: { orphansDeleted: 1, idleEvictions: 4 },
  }
  listServicesImpl = async () => []
  listServicesThrows = null
})

// We yield to the microtask queue a few times since collectSnapshot
// uses dynamic imports + multiple awaits.
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  // Real timer delay: cold dynamic imports (warm-pool-controller +
  // knative-project-manager) don't drain via microtask yields alone.
  await new Promise((r) => setTimeout(r, 30))
}

describe('startInfraMetricsCollector — initial snapshot', () => {
  test('writes one infraSnapshot row immediately on start (no wait for interval)', async () => {
    const p = makePrisma()
    startInfraMetricsCollector(p.prisma)
    await flush()

    expect(p.create).toHaveBeenCalledTimes(1)
    const data = p.create.mock.calls[0][0].data
    expect(data.totalNodes).toBe(5)
    expect(data.asgDesired).toBe(4)
    expect(data.asgMax).toBe(10)
    expect(data.totalPodSlots).toBe(100)
    expect(data.usedPodSlots).toBe(40)
    expect(data.totalCpuMillis).toBe(8000)
    expect(data.usedCpuMillis).toBe(3000)
    expect(data.limitCpuMillis).toBe(6000)
    expect(data.warmAvailable).toBe(3)
    expect(data.warmTarget).toBe(5)
    expect(data.warmAssigned).toBe(2)
    expect(data.coldStarts).toBe(0) // hardcoded
    expect(data.orphansDeleted).toBe(1)
    expect(data.idleEvictions).toBe(4)
  })

  test('aggregates listAllServices into the project stats columns', async () => {
    listServicesImpl = async () => [
      { status: { ready: true, replicas: 2 } },
      { status: { ready: true, replicas: 1 } },
      { status: { ready: true, replicas: 0 } },
      { status: { ready: false, replicas: 0 } },
    ]
    const p = makePrisma()
    startInfraMetricsCollector(p.prisma)
    await flush()
    const data = p.create.mock.calls[0][0].data
    expect(data.totalProjects).toBe(4)
    expect(data.readyProjects).toBe(3)
    expect(data.runningProjects).toBe(2)
    expect(data.scaledToZero).toBe(2)
  })

  test('logs a warning and zero-fills cluster columns when extended.cluster is null', async () => {
    extendedStatus = { ...extendedStatus, cluster: null }
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const p = makePrisma()
    startInfraMetricsCollector(p.prisma)
    await flush()

    expect(warnSpy.mock.calls.some((c) => c.join(' ').includes('cluster data is null'))).toBe(true)
    const data = p.create.mock.calls[0][0].data
    expect(data.totalNodes).toBe(0)
    expect(data.asgDesired).toBe(0)
    expect(data.totalCpuMillis).toBe(0)
    warnSpy.mockRestore()
  })

  test('logs a warning but still writes the row when listAllServices throws', async () => {
    listServicesThrows = new Error('knative api down')
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const p = makePrisma()
    startInfraMetricsCollector(p.prisma)
    await flush()

    expect(p.create).toHaveBeenCalledTimes(1)
    const data = p.create.mock.calls[0][0].data
    // Project stats default to zero when Knative fails.
    expect(data.totalProjects).toBe(0)
    expect(data.readyProjects).toBe(0)
    expect(data.runningProjects).toBe(0)
    expect(data.scaledToZero).toBe(0)
    expect(warnSpy.mock.calls.some((c) => c.join(' ').includes('knative api down'))).toBe(true)
    warnSpy.mockRestore()
  })

  test('handles the structured-pool variant where available/targetSize are objects', async () => {
    extendedStatus = {
      ...extendedStatus,
      available: { project: 3, agent: 2 },
      targetSize: { project: 5, agent: 4 },
    }
    const p = makePrisma()
    startInfraMetricsCollector(p.prisma)
    await flush()
    const data = p.create.mock.calls[0][0].data
    expect(data.warmAvailable).toBe(5) // 3 + 2
    expect(data.warmTarget).toBe(9) // 5 + 4
  })

  test('treats missing assigned / gcStats fields as zero', async () => {
    extendedStatus = {
      cluster: extendedStatus.cluster,
      available: 1,
      targetSize: 2,
      // assigned and gcStats omitted
    }
    const p = makePrisma()
    startInfraMetricsCollector(p.prisma)
    await flush()
    const data = p.create.mock.calls[0][0].data
    expect(data.warmAssigned).toBe(0)
    expect(data.orphansDeleted).toBe(0)
    expect(data.idleEvictions).toBe(0)
  })

  test('catches snapshot errors and logs them (does not crash the timer)', async () => {
    const p = makePrisma()
    p.create.mockImplementation(async () => {
      throw new Error('db write failed')
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    startInfraMetricsCollector(p.prisma)
    await flush()

    expect(errorSpy.mock.calls.some((c) => c.join(' ').includes('db write failed'))).toBe(true)
    errorSpy.mockRestore()
  })

  test('runs the initial prune call once on start (deleteMany invoked)', async () => {
    const p = makePrisma()
    startInfraMetricsCollector(p.prisma)
    await flush()

    expect(p.deleteMany).toHaveBeenCalledTimes(1)
    const args = p.deleteMany.mock.calls[0][0]
    expect(args.where.timestamp.lt).toBeInstanceOf(Date)
    // Cutoff should be ~90 days ago.
    const cutoff = (args.where.timestamp.lt as Date).getTime()
    const expected = Date.now() - 90 * 24 * 60 * 60 * 1000
    expect(Math.abs(cutoff - expected)).toBeLessThan(5_000)
  })

  test('logs how many rows were pruned when count > 0', async () => {
    const p = makePrisma()
    p.deleteMany.mockImplementation(async () => ({ count: 7 }))
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    startInfraMetricsCollector(p.prisma)
    await flush()

    expect(logSpy.mock.calls.some((c) => c.join(' ').includes('Pruned 7 snapshots'))).toBe(true)
    logSpy.mockRestore()
  })

  test('does NOT log a "Pruned" message when count is 0', async () => {
    const p = makePrisma()
    p.deleteMany.mockImplementation(async () => ({ count: 0 }))
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    startInfraMetricsCollector(p.prisma)
    await flush()

    expect(logSpy.mock.calls.some((c) => c.join(' ').includes('Pruned'))).toBe(false)
    logSpy.mockRestore()
  })

  test('catches prune errors and logs them (does not crash)', async () => {
    const p = makePrisma()
    p.deleteMany.mockImplementation(async () => {
      throw new Error('prune broke')
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    startInfraMetricsCollector(p.prisma)
    await flush()

    expect(errorSpy.mock.calls.some((c) => c.join(' ').includes('prune broke'))).toBe(true)
    errorSpy.mockRestore()
  })
})

describe('startInfraMetricsCollector — idempotency', () => {
  test('a second start() call is a no-op when a timer is already running', async () => {
    const p = makePrisma()
    startInfraMetricsCollector(p.prisma)
    await flush()
    const initialCreates = p.create.mock.calls.length

    startInfraMetricsCollector(p.prisma) // second call — should bail
    await flush()

    // No additional snapshot from the second start.
    expect(p.create.mock.calls.length).toBe(initialCreates)
  })
})

describe('stopInfraMetricsCollector', () => {
  test('clears both interval timers so the collector can be restarted', async () => {
    const clearSpy = spyOn(globalThis, 'clearInterval')
    const p = makePrisma()
    startInfraMetricsCollector(p.prisma)
    await flush()
    expect(clearSpy).not.toHaveBeenCalled()

    stopInfraMetricsCollector()
    expect(clearSpy).toHaveBeenCalledTimes(2) // snapshot + prune

    // After stop, restart should work and emit a fresh initial snapshot.
    const before = p.create.mock.calls.length
    startInfraMetricsCollector(p.prisma)
    await flush()
    expect(p.create.mock.calls.length).toBeGreaterThan(before)
    clearSpy.mockRestore()
  })

  test('is a safe no-op when no timer is running', () => {
    // First stop() with no prior start() — must not throw.
    expect(() => stopInfraMetricsCollector()).not.toThrow()
    // Second stop() — also safe.
    expect(() => stopInfraMetricsCollector()).not.toThrow()
  })
})
