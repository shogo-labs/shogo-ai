// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

interface CreateCall {
  data: Record<string, any>
}

interface PrismaState {
  createCalls: CreateCall[]
  deleteManyCalls: Array<{ where: any }>
  deleteManyReturn: { count: number }
  deleteManyThrow: Error | null
  createThrow: Error | null
}

const prismaState: PrismaState = {
  createCalls: [],
  deleteManyCalls: [],
  deleteManyReturn: { count: 0 },
  deleteManyThrow: null,
  createThrow: null,
}

const fakePrisma = {
  infraSnapshot: {
    create: async (args: any) => {
      if (prismaState.createThrow) throw prismaState.createThrow
      prismaState.createCalls.push(args)
      return { id: 'snap-1' }
    },
    deleteMany: async (args: any) => {
      if (prismaState.deleteManyThrow) throw prismaState.deleteManyThrow
      prismaState.deleteManyCalls.push(args)
      return prismaState.deleteManyReturn
    },
  },
} as any

interface ControllerState {
  extended: any
  throwIt: Error | null
}

const controllerState: ControllerState = {
  extended: {
    cluster: {
      totalNodes: 3,
      asgDesired: 5,
      asgMax: 10,
      totalPodSlots: 50,
      usedPodSlots: 20,
      totalCpuMillis: 50_000,
      usedCpuMillis: 20_000,
      limitCpuMillis: 40_000,
    },
    available: 4,
    targetSize: 8,
    assigned: 2,
    gcStats: { orphansDeleted: 1, idleEvictions: 2 },
  },
  throwIt: null,
}

mock.module('../warm-pool-controller', () => ({
  getWarmPoolController: () => ({
    getExtendedStatus: async () => {
      if (controllerState.throwIt) throw controllerState.throwIt
      return controllerState.extended
    },
  }),
}))

interface KnativeState {
  services: any[]
  throwIt: Error | null
}

const knativeState: KnativeState = { services: [], throwIt: null }

mock.module('../knative-project-manager', () => ({
  getKnativeProjectManager: () => ({
    listAllServices: async () => {
      if (knativeState.throwIt) throw knativeState.throwIt
      return knativeState.services
    },
  }),
}))

const {
  startInfraMetricsCollector,
  stopInfraMetricsCollector,
  // @ts-ignore — exported only for tests
} = await import('../infra-metrics-collector')

let warnSpy: any
let errorSpy: any
let logSpy: any

beforeEach(() => {
  prismaState.createCalls = []
  prismaState.deleteManyCalls = []
  prismaState.deleteManyReturn = { count: 0 }
  prismaState.deleteManyThrow = null
  prismaState.createThrow = null
  controllerState.extended = {
    cluster: {
      totalNodes: 3,
      asgDesired: 5,
      asgMax: 10,
      totalPodSlots: 50,
      usedPodSlots: 20,
      totalCpuMillis: 50_000,
      usedCpuMillis: 20_000,
      limitCpuMillis: 40_000,
    },
    available: 4,
    targetSize: 8,
    assigned: 2,
    gcStats: { orphansDeleted: 1, idleEvictions: 2 },
  }
  controllerState.throwIt = null
  knativeState.services = []
  knativeState.throwIt = null
  warnSpy = mock(() => {})
  errorSpy = mock(() => {})
  logSpy = mock(() => {})
  console.warn = warnSpy as any
  console.error = errorSpy as any
  console.log = logSpy as any
})

afterEach(() => {
  stopInfraMetricsCollector()
})

// Helper to wait until the synchronous part of `collectSnapshot` has
// queued its prisma.create. Snapshot is fire-and-forget so we poll.
async function waitForCreates(n: number, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (prismaState.createCalls.length < n && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function waitForDeleteMany(n: number, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (prismaState.deleteManyCalls.length < n && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('startInfraMetricsCollector', () => {
  it('takes one snapshot immediately and writes all cluster fields', async () => {
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    expect(prismaState.createCalls).toHaveLength(1)
    const d = prismaState.createCalls[0].data
    expect(d.totalNodes).toBe(3)
    expect(d.asgDesired).toBe(5)
    expect(d.asgMax).toBe(10)
    expect(d.totalPodSlots).toBe(50)
    expect(d.usedPodSlots).toBe(20)
    expect(d.totalCpuMillis).toBe(50_000)
    expect(d.usedCpuMillis).toBe(20_000)
    expect(d.limitCpuMillis).toBe(40_000)
    expect(d.warmAvailable).toBe(4)
    expect(d.warmTarget).toBe(8)
    expect(d.warmAssigned).toBe(2)
    expect(d.coldStarts).toBe(0)
    expect(d.orphansDeleted).toBe(1)
    expect(d.idleEvictions).toBe(2)
  })

  it('also kicks off the prune cycle immediately', async () => {
    startInfraMetricsCollector(fakePrisma)
    await waitForDeleteMany(1)
    expect(prismaState.deleteManyCalls).toHaveLength(1)
    const cutoff = prismaState.deleteManyCalls[0].where.timestamp.lt
    expect(cutoff).toBeInstanceOf(Date)
    // Cutoff should be ~90 days in the past.
    const ageMs = Date.now() - (cutoff as Date).getTime()
    expect(ageMs).toBeGreaterThan(89 * 24 * 60 * 60 * 1000)
    expect(ageMs).toBeLessThan(91 * 24 * 60 * 60 * 1000)
  })

  it('zero-fills cluster fields when cluster data is null and warns', async () => {
    controllerState.extended = { cluster: null, available: 0, targetSize: 0, assigned: 0 }
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    const d = prismaState.createCalls[0].data
    expect(d.totalNodes).toBe(0)
    expect(d.asgDesired).toBe(0)
    expect(d.totalCpuMillis).toBe(0)
    expect(warnSpy).toHaveBeenCalled()
    const msg = (warnSpy.mock.calls.flat() ?? []).join(' ')
    expect(msg).toContain('cluster data is null')
  })

  it('aggregates project warm pool sizes when available is an object', async () => {
    controllerState.extended = {
      cluster: {
        totalNodes: 1,
        asgDesired: 1,
        asgMax: 1,
        totalPodSlots: 1,
        usedPodSlots: 0,
        totalCpuMillis: 1,
        usedCpuMillis: 0,
        limitCpuMillis: 1,
      },
      available: { project: 3, agent: 2 },
      targetSize: { project: 5, agent: 4 },
      assigned: 0,
    }
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    const d = prismaState.createCalls[0].data
    expect(d.warmAvailable).toBe(5)
    expect(d.warmTarget).toBe(9)
  })

  it('falls back to 0 for partial warm-pool objects (missing agent key)', async () => {
    controllerState.extended.available = { project: 7 } as any
    controllerState.extended.targetSize = { project: 10 } as any
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    const d = prismaState.createCalls[0].data
    expect(d.warmAvailable).toBe(7)
    expect(d.warmTarget).toBe(10)
  })

  it('zero-fills warm/assigned/gcStats when extended fields are absent', async () => {
    controllerState.extended = { cluster: null }
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    const d = prismaState.createCalls[0].data
    expect(d.warmAvailable).toBe(0)
    expect(d.warmTarget).toBe(0)
    expect(d.warmAssigned).toBe(0)
    expect(d.orphansDeleted).toBe(0)
    expect(d.idleEvictions).toBe(0)
  })

  it('counts Knative project statuses correctly', async () => {
    knativeState.services = [
      { status: { ready: true, replicas: 2 } },
      { status: { ready: true, replicas: 0 } },
      { status: { ready: false, replicas: 1 } },
      { status: { ready: false, replicas: 0 } },
    ]
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    const d = prismaState.createCalls[0].data
    expect(d.totalProjects).toBe(4)
    expect(d.readyProjects).toBe(2)
    expect(d.runningProjects).toBe(2) // replicas > 0
    expect(d.scaledToZero).toBe(2)
  })

  it('zero-fills Knative project stats when listAllServices throws and warns', async () => {
    knativeState.throwIt = new Error('knative down')
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    const d = prismaState.createCalls[0].data
    expect(d.totalProjects).toBe(0)
    expect(d.readyProjects).toBe(0)
    expect(d.runningProjects).toBe(0)
    expect(d.scaledToZero).toBe(0)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('logs and swallows errors when getExtendedStatus throws (no prisma write)', async () => {
    controllerState.throwIt = new Error('controller boom')
    startInfraMetricsCollector(fakePrisma)
    // Give the async snapshot a beat to run.
    await new Promise((r) => setTimeout(r, 50))
    expect(prismaState.createCalls).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('logs and swallows errors when prisma.create throws', async () => {
    prismaState.createThrow = new Error('db write failed')
    startInfraMetricsCollector(fakePrisma)
    await new Promise((r) => setTimeout(r, 50))
    expect(errorSpy).toHaveBeenCalled()
  })

  it('logs the pruned count when deleteMany returns a positive count', async () => {
    prismaState.deleteManyReturn = { count: 17 }
    startInfraMetricsCollector(fakePrisma)
    await waitForDeleteMany(1)
    // Give the log call time to fire.
    await new Promise((r) => setTimeout(r, 10))
    const msg = (logSpy.mock.calls.flat() ?? []).join(' ')
    expect(msg).toContain('Pruned 17 snapshots')
  })

  it('does NOT log when deleteMany count is 0', async () => {
    prismaState.deleteManyReturn = { count: 0 }
    startInfraMetricsCollector(fakePrisma)
    await waitForDeleteMany(1)
    await new Promise((r) => setTimeout(r, 10))
    const msg = (logSpy.mock.calls.flat() ?? []).join(' ')
    expect(msg).not.toContain('Pruned')
  })

  it('logs and swallows errors when prune deleteMany throws', async () => {
    prismaState.deleteManyThrow = new Error('prune boom')
    startInfraMetricsCollector(fakePrisma)
    await new Promise((r) => setTimeout(r, 50))
    const errMsg = (errorSpy.mock.calls.flat() ?? []).join(' ')
    expect(errMsg).toContain('Prune failed')
  })

  it('is idempotent — calling start twice does not double-schedule', async () => {
    startInfraMetricsCollector(fakePrisma)
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    // The first call fires one immediate snapshot; the second is a no-op.
    expect(prismaState.createCalls).toHaveLength(1)
  })
})

describe('stopInfraMetricsCollector', () => {
  it('clears both timers so start can re-arm afterwards', async () => {
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    stopInfraMetricsCollector()

    prismaState.createCalls = []
    startInfraMetricsCollector(fakePrisma)
    await waitForCreates(1)
    expect(prismaState.createCalls).toHaveLength(1)
  })

  it('is safe to call when no timers are running', () => {
    expect(() => stopInfraMetricsCollector()).not.toThrow()
    expect(() => stopInfraMetricsCollector()).not.toThrow()
  })
})
