// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-user claimed-pod cap test suite.
 *
 * Exercises WarmPoolController.enforcePerUserClaimedCap (the claim-path cap)
 * and enforcePerUserCapsSweep (the cross-replica GC backstop): LRU eviction
 * once a user is at/over the plan-derived cap, never evicting the incoming
 * project, tier-scaled limits, and the kill switch.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'

// Intercept unbuilt SDK subpath exports before @shogo/shared-runtime loads them.
mock.module('@shogo-ai/sdk/ai-proxy', () => ({ createAiProxy: () => ({}) }))
mock.module('@shogo-ai/sdk/ai-client', () => ({ sendMessage: async () => ({}) }))
mock.module('@shogo-ai/sdk/model-catalog', () => ({
  getModelTier: () => 'standard',
  resolveModelId: (id: string) => id,
  MODEL_CATALOG: {},
  getModelEntry: () => undefined,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelBillingModel: (id: string) => id,
  resolveAgentModeDefault: (mode: string) => mode,
}))
mock.module('@shogo/shared-runtime', () => ({
  RUNTIME_CONFIG: {
    apiPort: 4000,
    runtimePort: 5000,
    portRangeStart: 5100,
    portRangeEnd: 5200,
    image: () => 'shogo-runtime:test',
    workDir: '/app/workspace',
    extraEnv: {},
    componentLabel: 'runtime',
    containerName: 'runtime',
  },
}))
mock.module('@shogo/model-catalog', () => ({
  getModelTier: () => 'standard',
  resolveModelId: (id: string) => id,
  MODEL_CATALOG: {},
  getModelEntry: () => undefined,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelBillingModel: (id: string) => id,
  resolveAgentModeDefault: (mode: string) => mode,
  getAgentModeOverrides: () => ({}),
  getMaxOutputTokens: (_id?: string) => 4096,
  MODEL_ALIASES: {} as Record<string, any>,
}))

const mockK8sCustomApi = {
  listNamespacedCustomObject: mock(() => Promise.resolve({ items: [] })),
  createNamespacedCustomObject: mock(() => Promise.resolve({})),
  deleteNamespacedCustomObject: mock(() => Promise.resolve({})),
  getNamespacedCustomObject: mock(() => Promise.resolve({})),
  patchNamespacedCustomObject: mock(() => Promise.resolve({})),
}
mock.module('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault() {}
    loadFromOptions() {}
    makeApiClient() {
      return mockK8sCustomApi
    }
  },
  CustomObjectsApi: class {},
  CoreV1Api: class {},
}))

// Controllable prisma.project.findMany — tests set `findManyResult`.
let findManyResult: any[] = []
let lastFindManyArgs: any = null
const mockPrismaProjectFindMany = mock((args: any) => {
  lastFindManyArgs = args
  return Promise.resolve(findManyResult)
})
const mockPrismaProject = {
  findUnique: mock(() => Promise.resolve({ workspaceId: 'ws-1' })),
  findFirst: mock(() => Promise.resolve(null)),
  findMany: mockPrismaProjectFindMany,
  update: mock(() => Promise.resolve({})),
  updateMany: mock(() => Promise.resolve({ count: 0 })),
}
mock.module('../prisma', () => ({
  prisma: { project: mockPrismaProject },
}))

// billing.service.getEffectivePlanId — used only by the sweep.
let effectivePlanById: Record<string, string> = {}
const mockGetEffectivePlanId = mock((workspaceId: string) =>
  Promise.resolve(effectivePlanById[workspaceId] ?? 'free'),
)
mock.module('../../services/billing.service', () => ({
  getEffectivePlanId: mockGetEffectivePlanId,
}))

mock.module('../knative-project-manager', () => ({
  mergePatchKnativeService: mock(() => Promise.resolve()),
}))
mock.module('../../services/database.service', () => ({
  provisionDatabase: mock(() =>
    Promise.resolve({ connectionUrl: 'postgresql://test:test@localhost/test' }),
  ),
}))

import { WarmPoolController } from '../warm-pool-controller'

/** Build a claimed-project row as returned by the cap query. */
function claimedRow(id: string, lastMessageAtMs: number | null, updatedAtMs = lastMessageAtMs ?? 0) {
  return {
    id,
    lastMessageAt: lastMessageAtMs === null ? null : new Date(lastMessageAtMs),
    updatedAt: new Date(updatedAtMs),
  }
}

describe('WarmPoolController per-user claimed-pod cap', () => {
  let controller: WarmPoolController
  let evictSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    findManyResult = []
    lastFindManyArgs = null
    effectivePlanById = {}
    mockPrismaProjectFindMany.mockClear()
    mockGetEffectivePlanId.mockClear()
    delete process.env.WARM_POOL_PER_USER_CAP_ENABLED
    delete process.env.WARM_POOL_CLAIMED_CAP_BY_TIER
    process.env.WARM_POOL_ENABLED = 'true'
    process.env.PROJECT_NAMESPACE = 'test-namespace'

    controller = new WarmPoolController({ poolSize: 3, reconcileIntervalMs: 1000 })
    // Stub the real eviction (which calls k8s + prisma) so we only assert intent.
    evictSpy = spyOn(controller, 'evictProject').mockResolvedValue({
      evicted: true,
      oldService: 'svc',
    })
  })

  afterEach(() => {
    controller.stop()
    delete process.env.WARM_POOL_PER_USER_CAP_ENABLED
    delete process.env.WARM_POOL_CLAIMED_CAP_BY_TIER
  })

  describe('enforcePerUserClaimedCap', () => {
    test('no-op when the owner is under their cap', async () => {
      // free cap = 2; owner has 1 other claimed pod
      findManyResult = [claimedRow('p-old', 1000)]
      const res = await controller.enforcePerUserClaimedCap('p-new', 'user-1', 'free')

      expect(res.cap).toBe(2)
      expect(res.count).toBe(1)
      expect(res.evicted).toEqual([])
      expect(evictSpy).not.toHaveBeenCalled()
    })

    test('evicts down to cap-1 (oldest first) when over the cap', async () => {
      // free cap = 2; owner has 3 claimed -> evict down to cap-1 (=1), oldest first
      findManyResult = [
        claimedRow('p-newer', 3000),
        claimedRow('p-oldest', 1000),
        claimedRow('p-mid', 2000),
      ]
      const res = await controller.enforcePerUserClaimedCap('p-new', 'user-1', 'free')

      expect(res.cap).toBe(2)
      expect(res.count).toBe(3)
      // target = cap-1 = 1, so evict count-target = 2 oldest: p-oldest, p-mid
      expect(res.evicted).toEqual(['p-oldest', 'p-mid'])
      expect(evictSpy).toHaveBeenCalledTimes(2)
      expect(evictSpy).toHaveBeenCalledWith('p-oldest', { deleteService: true })
      expect(evictSpy).toHaveBeenCalledWith('p-mid', { deleteService: true })
    })

    test('evicts a single oldest pod when exactly at cap (count == cap)', async () => {
      findManyResult = [claimedRow('p-recent', 5000), claimedRow('p-stale', 1000)]
      const res = await controller.enforcePerUserClaimedCap('p-new', 'user-1', 'free')

      expect(res.cap).toBe(2)
      expect(res.count).toBe(2)
      expect(res.evicted).toEqual(['p-stale'])
      expect(evictSpy).toHaveBeenCalledTimes(1)
    })

    test('excludes the incoming project from the cap count query', async () => {
      findManyResult = [claimedRow('p-a', 1000)]
      await controller.enforcePerUserClaimedCap('p-incoming', 'user-1', 'free')

      expect(lastFindManyArgs.where.id).toEqual({ not: 'p-incoming' })
      expect(lastFindManyArgs.where.knativeServiceName).toEqual({ not: null })
      expect(lastFindManyArgs.where.workspace).toEqual({
        members: { some: { role: 'owner', userId: 'user-1' } },
      })
    })

    test('higher tier permits more claimed pods before evicting', async () => {
      // pro cap = 4; owner has 3 -> still under cap, no eviction
      findManyResult = [claimedRow('p1', 1000), claimedRow('p2', 2000), claimedRow('p3', 3000)]
      const res = await controller.enforcePerUserClaimedCap('p-new', 'user-1', 'pro')

      expect(res.cap).toBe(4)
      expect(res.evicted).toEqual([])
      expect(evictSpy).not.toHaveBeenCalled()
    })

    test('honors per-tier env overrides', async () => {
      process.env.WARM_POOL_CLAIMED_CAP_BY_TIER = JSON.stringify({ free: 1 })
      findManyResult = [claimedRow('p-only', 1000)]
      const res = await controller.enforcePerUserClaimedCap('p-new', 'user-1', 'free')

      expect(res.cap).toBe(1)
      // target = cap-1 = 0, count=1 -> evict all 1
      expect(res.evicted).toEqual(['p-only'])
    })

    test('uses in-memory touch timestamp over DB time for LRU selection', async () => {
      // DB order would make p-a oldest, but a recent touch on p-a makes p-b the LRU.
      findManyResult = [claimedRow('p-a', 1000), claimedRow('p-b', 2000)]
      controller.touchProject('p-a') // now (recent) > p-b's 2000
      const res = await controller.enforcePerUserClaimedCap('p-new', 'user-1', 'free')

      expect(res.evicted).toEqual(['p-b'])
    })

    test('short-circuits when the kill switch is off', async () => {
      process.env.WARM_POOL_PER_USER_CAP_ENABLED = 'false'
      findManyResult = [claimedRow('p1', 1), claimedRow('p2', 2), claimedRow('p3', 3)]
      const res = await controller.enforcePerUserClaimedCap('p-new', 'user-1', 'free')

      expect(res.evicted).toEqual([])
      expect(evictSpy).not.toHaveBeenCalled()
      expect(mockPrismaProjectFindMany).not.toHaveBeenCalled()
    })
  })

  describe('enforcePerUserCapsSweep', () => {
    function sweepRow(id: string, userId: string, workspaceId: string, ts: number) {
      return {
        id,
        workspaceId,
        lastMessageAt: new Date(ts),
        updatedAt: new Date(ts),
        workspace: { members: [{ userId }] },
      }
    }

    test('evicts LRU extras for an owner over their cap', async () => {
      // free owner with 3 claimed pods (cap 2) -> evict 1 oldest
      findManyResult = [
        sweepRow('a', 'u1', 'ws1', 3000),
        sweepRow('b', 'u1', 'ws1', 1000), // oldest
        sweepRow('c', 'u1', 'ws1', 2000),
      ]
      const res = await controller.enforcePerUserCapsSweep()

      expect(res.scanned).toBe(3)
      expect(res.evicted).toBe(1)
      expect(evictSpy).toHaveBeenCalledTimes(1)
      expect(evictSpy).toHaveBeenCalledWith('b', { deleteService: true })
    })

    test('leaves owners at/under their cap untouched (fast path)', async () => {
      findManyResult = [
        sweepRow('a', 'u1', 'ws1', 1000),
        sweepRow('b', 'u2', 'ws2', 2000),
      ]
      const res = await controller.enforcePerUserCapsSweep()

      expect(res.evicted).toBe(0)
      expect(evictSpy).not.toHaveBeenCalled()
      // fast path: never resolves plan for sub-cap owners
      expect(mockGetEffectivePlanId).not.toHaveBeenCalled()
    })

    test('uses the most generous cap across an owner workspaces', async () => {
      // u1 owns 5 claimed pods across a free ws and a business ws (cap 5).
      effectivePlanById = { wsFree: 'free', wsBiz: 'business' }
      findManyResult = [
        sweepRow('a', 'u1', 'wsFree', 1000),
        sweepRow('b', 'u1', 'wsBiz', 2000),
        sweepRow('c', 'u1', 'wsBiz', 3000),
        sweepRow('d', 'u1', 'wsBiz', 4000),
        sweepRow('e', 'u1', 'wsBiz', 5000),
      ]
      const res = await controller.enforcePerUserCapsSweep()

      // business cap = 5, owner has 5 -> not over cap
      expect(res.evicted).toBe(0)
      expect(evictSpy).not.toHaveBeenCalled()
    })

    test('respects the kill switch', async () => {
      process.env.WARM_POOL_PER_USER_CAP_ENABLED = 'false'
      findManyResult = [
        sweepRow('a', 'u1', 'ws1', 1),
        sweepRow('b', 'u1', 'ws1', 2),
        sweepRow('c', 'u1', 'ws1', 3),
      ]
      const res = await controller.enforcePerUserCapsSweep()

      expect(res).toEqual({ scanned: 0, evicted: 0 })
      expect(evictSpy).not.toHaveBeenCalled()
    })
  })
})
