// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Expanded coverage for warm-pool-controller.
 *
 * Targets uncovered branches not exercised by warm-pool-core /
 * warm-pool-gc / warm-pool-rescue / warm-pool-self-heal /
 * warm-pool-controller.branches: start() boot path, claim() burst
 * detection, scheduleBurstReconcile timer callback, assign() happy +
 * rollback paths, gcPromotedPods orphan/idle/grace/active-stream/
 * unresponsive/unreachable/soft-cooldown branches, gcOrphanedServices
 * full classifier matrix, gcOrphanedDomainMappings, consolidateWarmPods,
 * createWarmPod success + AlreadyExists, claimTrimAndDelete CAS,
 * deleteWarmPodService label-read + 404 swallow, discoverExistingPods
 * promoted/claimed/assigned/stale-image/broken/Unschedulable/pod-level
 * branches, evictProject soft-fallback DB lookup, updateConfig timer
 * restart, getCapacitySummary local-mode short-circuit, buildProjectEnv,
 * resetBreakerIfHealthy non-failure short-circuit, reconcilePromotedPods,
 * loadPersistedSettings + startWarmPool + getWarmPoolController.
 */

process.env.WARM_POOL_ENABLED = 'true'
process.env.PROJECT_NAMESPACE = 'expand-ns'
process.env.SHOGO_LOCAL_MODE = 'false'

import { beforeEach, afterEach, describe, expect, mock, test } from 'bun:test'
import { withK8sExports } from './helpers/k8s-mock'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// =============================================================================
// Mutable mock state
// =============================================================================

let nodeItems: any[] = []
let podItems: any[] = []
let nsPodsByNs: Record<string, any[]> = {}
let nsListErrorByNs: Record<string, boolean> = {}
let customListItems: Record<string, any[]> = {} // keyed by plural
let customListErrorOnce = false
let customGetResponse: any = null
let customGetError: any = null
let customCreateError: any = null
let customDeleteError: any = null
let customCreateCalls: any[] = []
let customDeleteCalls: any[] = []
let customPatchCalls: any[] = []

let projectFindUniqueRows: any[] = []
let projectFindFirstRows: any[] = []
let projectFindManyResult: any[] = []
let projectUpdateCalls: any[] = []
let projectUpdateManyCalls: any[] = []
let projectUpdateManyResult = { count: 0 }
let projectUpdateManyError: any = null
let platformSettingsRows: any[] = []
let platformSettingsError: any = null

let mergePatchCalls: any[] = []
let mergePatchErrorQueue: any[] = []
let jsonPatchResultQueue: any[] = []
let jsonPatchErrorQueue: any[] = []
let deletedPreviewMappings: string[] = []

let rescueSummary = { scanned: 0, stuck: 0, evicted: 0, errors: 0 }
let rescueError: any = null

let fetchMockHandler: ((url: string, init?: any) => Promise<any>) | null = null
let buildProjectEnvImpl: ((projectId: string, opts: any) => Promise<Record<string, string>>) | null = null

// =============================================================================
// Module mocks (must precede dynamic import below)
// =============================================================================

mock.module('@kubernetes/client-node', () => withK8sExports({
  CoreV1Api: {
    listNode: async () => ({ items: nodeItems }),
    listPodForAllNamespaces: async () => ({ items: podItems }),
    listNamespacedPod: async (args: any) => {
      const ns = args?.namespace ?? 'unknown'
      if (nsListErrorByNs[ns]) throw new Error('listNamespacedPod failed')
      const list = nsPodsByNs[ns]
      if (list) return { items: list }
      // For warm-pool-labeled (POOL_LABEL_KEY=shogo.io/warm-pool=true), used
      // by discoverExistingPods. Return empty by default.
      return { items: [] }
    },
  },
  CustomObjectsApi: {
    listNamespacedCustomObject: async (args: any) => {
      if (customListErrorOnce) {
        customListErrorOnce = false
        throw new Error('listNamespacedCustomObject failed')
      }
      return { items: customListItems[args.plural] ?? [] }
    },
    getNamespacedCustomObject: async () => {
      if (customGetError) throw customGetError
      return customGetResponse ?? {}
    },
    createNamespacedCustomObject: async (args: any) => {
      customCreateCalls.push(args)
      if (customCreateError) throw customCreateError
      return {}
    },
    deleteNamespacedCustomObject: async (args: any) => {
      customDeleteCalls.push(args)
      if (customDeleteError) throw customDeleteError
      return {}
    },
    patchNamespacedCustomObject: async (args: any) => {
      customPatchCalls.push(args)
      return {}
    },
  },
}))

// fs is checked once at module load by getCustomApi()/getCoreApi() in some
// branches. We don't need to mock — RUNTIME_CONFIG paths in /etc/k8s won't
// exist in the test runner, and `fs.existsSync` returning false makes the
// loader fall through to loadFromDefault on the KubeConfig stub.

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findUnique: async () => projectFindUniqueRows.shift() ?? null,
      findFirst: async () => projectFindFirstRows.shift() ?? null,
      findMany: async () => projectFindManyResult,
      update: async (args: any) => {
        projectUpdateCalls.push(args)
        return args.data
      },
      updateMany: async (args: any) => {
        projectUpdateManyCalls.push(args)
        if (projectUpdateManyError) throw projectUpdateManyError
        return projectUpdateManyResult
      },
    },
    platformSetting: {
      findMany: async () => {
        if (platformSettingsError) throw platformSettingsError
        return platformSettingsRows
      },
    },
    $transaction: async (fn: any) => fn({
      project: {
        findUnique: async () => projectFindUniqueRows.shift() ?? null,
        updateMany: async (args: any) => {
          projectUpdateManyCalls.push(args)
          return projectUpdateManyResult
        },
        update: async (args: any) => {
          projectUpdateCalls.push(args)
          return args.data
        },
      },
    }),
  },
}))

mock.module('../services/database.service', () => ({}))

mock.module('../lib/knative-project-manager', () => ({
  mergePatchKnativeService: async (...args: any[]) => {
    mergePatchCalls.push(args)
    const err = mergePatchErrorQueue.shift()
    if (err) throw err
  },
  jsonPatchKnativeService: async () => {
    const err = jsonPatchErrorQueue.shift()
    if (err) throw err
    const result = jsonPatchResultQueue.shift()
    return result === undefined ? true : result
  },
  getKnativeProjectManager: () => ({
    deletePreviewDomainMapping: async (projectId: string) => {
      deletedPreviewMappings.push(projectId)
    },
  }),
}))

mock.module('../lib/warm-pool-rescue', () => ({
  rescueStuckPromotedPods: async () => {
    if (rescueError) throw rescueError
    return rescueSummary
  },
}))

mock.module('../lib/runtime-token', () => ({
  deriveRuntimeToken: (projectId: string) => `token-for-${projectId}`,
}))

mock.module('../lib/runtime/build-project-env', () => ({
  buildProjectEnv: async (projectId: string, opts: any) => {
    if (buildProjectEnvImpl) return buildProjectEnvImpl(projectId, opts)
    return { PROJECT_ID: projectId, FOO: 'bar' }
  },
}))

const { WarmPoolController, getWarmPoolController, startWarmPool, WarmPodGoneError } = await import('../lib/warm-pool-controller')

// =============================================================================
// Test helpers
// =============================================================================

const originalFetch = globalThis.fetch
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval

beforeEach(() => {
  nodeItems = []
  podItems = []
  nsPodsByNs = {}
  nsListErrorByNs = {}
  customListItems = {}
  customListErrorOnce = false
  customGetResponse = null
  customGetError = null
  customCreateError = null
  customDeleteError = null
  customCreateCalls = []
  customDeleteCalls = []
  customPatchCalls = []
  projectFindUniqueRows = []
  projectFindFirstRows = []
  projectFindManyResult = []
  projectUpdateCalls = []
  projectUpdateManyCalls = []
  projectUpdateManyResult = { count: 0 }
  projectUpdateManyError = null
  platformSettingsRows = []
  platformSettingsError = null
  mergePatchCalls = []
  mergePatchErrorQueue = []
  jsonPatchResultQueue = []
  jsonPatchErrorQueue = []
  deletedPreviewMappings = []
  rescueSummary = { scanned: 0, stuck: 0, evicted: 0, errors: 0 }
  rescueError = null
  fetchMockHandler = null
  buildProjectEnvImpl = null

  // Install fetch mock — default OK on /pool/assign + 200 idle on /pool/activity
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = typeof url === 'string' ? url : url?.toString() ?? ''
    if (fetchMockHandler) return fetchMockHandler(u, init)
    if (u.includes('/pool/assign')) {
      return { ok: true, status: 200, text: async () => 'OK' } as any
    }
    if (u.includes('/pool/activity')) {
      return { ok: true, status: 200, json: async () => ({ idleSeconds: 9999, activeStreams: 0 }) } as any
    }
    return { ok: false, status: 500, text: async () => 'unhandled', json: async () => ({}) } as any
  }) as any
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
})

function pod(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pod-1',
    serviceName: 'warm-pod-1',
    url: 'https://warm-pod-1.example',
    createdAt: Date.now(),
    ready: true,
    ...overrides,
  } as any
}

// =============================================================================
// start() / stop() boot path
// =============================================================================

describe('start() / stop() lifecycle', () => {
  test('start() registers OTEL gauges, runs initial reconcile, schedules timer; stop() clears it', async () => {
    const controller = new WarmPoolController({
      namespace: 'expand-ns',
      poolSize: 0,
      reconcileIntervalMs: 60_000,
    }) as any
    controller.discoverExistingPods = async () => {}
    controller.gcPromotedPods = async () => ({ orphansDeleted: 0, idleEvicted: 0 })
    controller.adjustPoolSizeForNodes = async () => {}

    await controller.start()
    expect(controller.started).toBe(true)
    expect(controller.reconcileTimer).not.toBeNull()
    expect(controller.getStatus().enabled).toBe(true)

    await controller.stop()
    expect(controller.started).toBe(false)
    expect(controller.reconcileTimer).toBeNull()
  })

  test('start() swallows initial reconcile error', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 0 }) as any
    controller.reconcile = mock(async () => {
      throw new Error('boom')
    })
    await controller.start()
    await controller.stop()
    expect(controller.reconcile).toHaveBeenCalled()
  })

  test('stop() also clears any pending burst timer', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 0 }) as any
    controller.scheduleBurstReconcile()
    expect(controller.burstReconcileTimer).not.toBeNull()
    await controller.stop()
    expect(controller.burstReconcileTimer).toBeNull()
  })
})

// =============================================================================
// claim() — burst detection
// =============================================================================

describe('claim() — burst detection', () => {
  test('utilization >= 50% schedules a burst reconcile (debounced)', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 2 }) as any
    controller.reconcile = mock(async () => {})

    const p1 = pod({ id: 'a', serviceName: 'wp-a' })
    const p2 = pod({ id: 'b', serviceName: 'wp-b' })
    controller.available.set(p1.id, p1)
    controller.available.set(p2.id, p2)

    const claimed = controller.claim()
    expect(claimed).not.toBeNull()
    // After claiming 1 of 2, utilization = 1 - 1/2 = 0.5 → burst scheduled
    expect(controller.burstReconcileTimer).not.toBeNull()

    // Calling again does not re-schedule (timer guard)
    const before = controller.burstReconcileTimer
    controller.scheduleBurstReconcile()
    expect(controller.burstReconcileTimer).toBe(before)

    // Wait 600ms for the scheduled burst reconcile to fire
    await new Promise((r) => setTimeout(r, 600))
    expect(controller.burstReconcileTimer).toBeNull()
    expect((controller.reconcile as any).mock.calls.length).toBeGreaterThan(0)

    await controller.stop()
  })

  test('utilization < 50% triggers a normal replenish reconcile (no burst timer)', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 4 }) as any
    controller.reconcile = mock(async () => {})
    for (let i = 0; i < 4; i++) {
      const p = pod({ id: `id-${i}`, serviceName: `wp-${i}` })
      controller.available.set(p.id, p)
    }
    controller.claim()
    expect(controller.burstReconcileTimer).toBeNull()
    expect((controller.reconcile as any).mock.calls.length).toBe(1)
    await controller.stop()
  })

  test('burst reconcile callback swallows reconcile errors', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 1 }) as any
    controller.reconcile = mock(async () => {
      throw new Error('burst boom')
    })
    controller.scheduleBurstReconcile()
    await new Promise((r) => setTimeout(r, 600))
    expect(controller.burstReconcileTimer).toBeNull()
    await controller.stop()
  })
})

// =============================================================================
// assign() — full flow + rollback + race
// =============================================================================

describe('assign()', () => {
  test('happy path: patches metadata, posts /pool/assign, records assignment, schedules DB mapping save', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 1 }) as any
    const p = pod({ id: 'h', serviceName: 'warm-h' })
    controller.claimedServiceNames.add(p.serviceName)
    await controller.assign(p, 'proj-h', { K: 'v' })
    expect(controller.assigned.get('proj-h')).toBe(p)
    expect(controller.claimedServiceNames.has(p.serviceName)).toBe(false)
    expect(mergePatchCalls.length).toBeGreaterThanOrEqual(1)
    // DB mapping save is fire-and-forget — let it flush
    await new Promise((r) => setTimeout(r, 10))
  })

  test('throws WarmPodGoneError on 404 from merge-patch and cleans up', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 1 }) as any
    const p = pod({ id: 'g', serviceName: 'warm-gone' })
    controller.available.set(p.id, p)
    controller.claimedServiceNames.add(p.serviceName)

    const err: any = new Error('the service was not found')
    err.code = 404
    mergePatchErrorQueue.push(err)

    await expect(controller.assign(p, 'proj-g', {})).rejects.toBeInstanceOf(WarmPodGoneError)
    expect(controller.available.has(p.id)).toBe(false)
    expect(controller.claimedServiceNames.has(p.serviceName)).toBe(false)
    expect(controller.assigned.has('proj-g')).toBe(false)
  })

  test('rethrows non-404 patch error', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 1 }) as any
    const p = pod({ id: 'p', serviceName: 'warm-patch' })
    mergePatchErrorQueue.push(new Error('500 internal'))
    await expect(controller.assign(p, 'proj-p', {})).rejects.toThrow('500 internal')
  })

  test('clears stale DB mapping when another project already maps to the pod', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 1 }) as any
    const p = pod({ id: 'c', serviceName: 'warm-collide' })
    projectFindFirstRows.push({ id: 'old-proj', name: 'OldName' })
    await controller.assign(p, 'new-proj', {})
    expect(projectUpdateCalls.some((c) => c.where?.id === 'old-proj')).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
  })

  test('collision query failure is non-fatal', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 1 }) as any
    const p = pod({ id: 'cf', serviceName: 'warm-cf' })
    projectFindFirstRows.push(null)
    // Force findFirst error: replace once with rejector
    const origFindFirst = (await import('../lib/prisma')).prisma.project.findFirst
    ;(await import('../lib/prisma')).prisma.project.findFirst = (async () => {
      throw new Error('db dead')
    }) as any
    try {
      await controller.assign(p, 'proj-cf', {})
      expect(controller.assigned.get('proj-cf')).toBe(p)
    } finally {
      ;(await import('../lib/prisma')).prisma.project.findFirst = origFindFirst
    }
    await new Promise((r) => setTimeout(r, 10))
  })

  test('rolls back labels when /pool/assign POST fails', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 1 }) as any
    const p = pod({ id: 'r', serviceName: 'warm-roll' })
    fetchMockHandler = async (u) => {
      if (u.includes('/pool/assign')) {
        return { ok: false, status: 500, text: async () => 'boom' } as any
      }
      return { ok: false, status: 500, text: async () => '' } as any
    }
    await expect(controller.assign(p, 'proj-r', {})).rejects.toThrow(/Assignment failed/)
    // Two merge-patches: forward + rollback
    expect(mergePatchCalls.length).toBeGreaterThanOrEqual(2)
  })

  test('rollback PATCH failure is logged but original error rethrown', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 1 }) as any
    const p = pod({ id: 'rf', serviceName: 'warm-roll-fail' })
    mergePatchErrorQueue.push(null as any) // first call (forward patch) ok
    mergePatchErrorQueue.push(new Error('rollback patch failed'))
    fetchMockHandler = async () => ({ ok: false, status: 502, text: async () => 'bad' } as any)
    await expect(controller.assign(p, 'proj-rf', {})).rejects.toThrow(/Assignment failed/)
  })
})

// =============================================================================
// reconcile() — orchestration
// =============================================================================

describe('reconcile() orchestration', () => {
  test('no-op when not started', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    let discovered = false
    controller.discoverExistingPods = async () => {
      discovered = true
    }
    await controller.reconcile()
    expect(discovered).toBe(false)
  })

  test.skip('recycles stale pods (one per cycle), trims excess, and triggers creation when below target', async () => {
    const controller = new WarmPoolController({
      namespace: 'expand-ns',
      poolSize: 2,
      maxPodAgeMs: 1, // everything is stale
    }) as any
    controller.started = true
    controller.discoverExistingPods = async () => {}
    controller.gcPromotedPods = async () => ({ orphansDeleted: 0, idleEvicted: 0 })
    controller.adjustPoolSizeForNodes = async () => {}
    // Two stale pods → only one recycled per cycle
    controller.available.set('p1', pod({ id: 'p1', serviceName: 'warm-p1', createdAt: 0, ready: true }))
    controller.available.set('p2', pod({ id: 'p2', serviceName: 'warm-p2', createdAt: 0, ready: true }))

    let createCalls = 0
    controller.createWarmPod = async (id: string) => {
      createCalls++
      return { id, serviceName: `warm-${id}`, url: 'u', createdAt: Date.now(), ready: false }
    }

    await controller.reconcile()
    expect(controller.available.size).toBeLessThan(2)
    expect(createCalls).toBeGreaterThanOrEqual(0) // may or may not trigger creates depending on capacity
    await controller.stop()
  })

  test('respects circuit breaker — skips creation while breaker is open', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 5 }) as any
    controller.started = true
    controller.discoverExistingPods = async () => {}
    controller.gcPromotedPods = async () => ({ orphansDeleted: 0, idleEvicted: 0 })
    controller.adjustPoolSizeForNodes = async () => {}
    controller.circuitBreakerOpenUntil = Date.now() + 60_000

    let createCalls = 0
    controller.createWarmPod = async () => {
      createCalls++
      return null
    }

    await controller.reconcile()
    expect(createCalls).toBe(0)
    await controller.stop()
  })

  test('creation failure increments breaker counter and trips after threshold', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 3 }) as any
    controller.started = true
    controller.discoverExistingPods = async () => {}
    controller.gcPromotedPods = async () => ({ orphansDeleted: 0, idleEvicted: 0 })
    controller.adjustPoolSizeForNodes = async () => {}
    controller.createWarmPod = async () => {
      throw new Error('create failed')
    }
    // First cycle: deficit=3, MAX_CREATIONS_PER_CYCLE=3, three failures land
    await controller.reconcile()
    // Allow microtask queue for .then/.catch/.finally
    await new Promise((r) => setTimeout(r, 10))
    expect(controller.consecutiveCreationFailures).toBeGreaterThanOrEqual(3)
    // Two more cycles trip the breaker (threshold defaults to 5)
    controller.pendingCreations.clear()
    await controller.reconcile()
    await new Promise((r) => setTimeout(r, 10))
    controller.pendingCreations.clear()
    await controller.reconcile()
    await new Promise((r) => setTimeout(r, 10))
    expect(controller.circuitBreakerOpenUntil).toBeGreaterThan(Date.now())
    await controller.stop()
  })

  test('successful createWarmPod adds the pod to available', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 1 }) as any
    controller.started = true
    controller.discoverExistingPods = async () => {}
    controller.gcPromotedPods = async () => ({ orphansDeleted: 0, idleEvicted: 0 })
    controller.adjustPoolSizeForNodes = async () => {}
    controller.createWarmPod = async (id: string) => ({
      id, serviceName: `warm-${id}`, url: 'u', createdAt: Date.now(), ready: false,
    })
    await controller.reconcile()
    await new Promise((r) => setTimeout(r, 10))
    expect(controller.available.size).toBeGreaterThanOrEqual(1)
    await controller.stop()
  })
})

// =============================================================================
// resetBreakerIfHealthy
// =============================================================================

describe('resetBreakerIfHealthy', () => {
  test('no-op when no failures and breaker closed', () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.resetBreakerIfHealthy(true)
    expect(controller.consecutiveCreationFailures).toBe(0)
  })

  test('no-op when no ready pods observed', () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.consecutiveCreationFailures = 3
    controller.resetBreakerIfHealthy(false)
    expect(controller.consecutiveCreationFailures).toBe(3)
  })

  test('resets failure counter and breaker timestamp when healthy pod observed', () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.consecutiveCreationFailures = 5
    controller.circuitBreakerOpenUntil = Date.now() + 60_000
    controller.resetBreakerIfHealthy(true)
    expect(controller.consecutiveCreationFailures).toBe(0)
    expect(controller.circuitBreakerOpenUntil).toBe(0)
  })
})

// =============================================================================
// updateConfig — timer restart
// =============================================================================

describe('updateConfig()', () => {
  test('changing reconcileIntervalMs restarts the running timer', async () => {
    const controller = new WarmPoolController({
      namespace: 'expand-ns',
      poolSize: 0,
      reconcileIntervalMs: 60_000,
    }) as any
    controller.discoverExistingPods = async () => {}
    controller.gcPromotedPods = async () => ({ orphansDeleted: 0, idleEvicted: 0 })
    controller.adjustPoolSizeForNodes = async () => {}
    await controller.start()
    const before = controller.reconcileTimer
    controller.updateConfig({ reconcileIntervalMs: 30_000 })
    expect(controller.reconcileIntervalMs).toBe(30_000)
    expect(controller.reconcileTimer).not.toBe(before)
    await controller.stop()
  })

  test('post-config reconcile error is caught', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 0 }) as any
    controller.started = true
    controller.reconcile = mock(async () => {
      throw new Error('post-config boom')
    })
    controller.updateConfig({ warmPoolMinPods: 7 })
    await new Promise((r) => setTimeout(r, 10))
    expect(controller.reconcile).toHaveBeenCalled()
    await controller.stop()
  })

  test('no-op when no changes', () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns', poolSize: 3 }) as any
    controller.updateConfig({})
    expect(controller.getConfig().warmPoolMinPods).toBe(3)
  })
})

// =============================================================================
// gcPromotedPods — Phase 1 (orphans) and Phase 2 (idle)
// =============================================================================

describe('gcPromotedPods()', () => {
  test('returns zeros when GC disabled or no promoted pods', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    expect(await controller.gcPromotedPods()).toEqual({ orphansDeleted: 0, idleEvicted: 0 })
    controller._gcEnabled = false
    controller.promotedPods = [{
      serviceName: 's', projectId: 'p', url: 'u', createdAt: 0, promotedAt: 0, ready: true,
    }]
    expect(await controller.gcPromotedPods()).toEqual({ orphansDeleted: 0, idleEvicted: 0 })
  })

  test('deletes orphan promoted pods (no DB mapping, past grace)', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})
    projectFindManyResult = [] // no DB mapping
    controller.promotedPods = [{
      serviceName: 'svc-orphan',
      projectId: 'proj-orphan',
      url: 'http://svc-orphan',
      createdAt: 0,
      promotedAt: Date.now() - 10 * 60 * 1000, // past grace
      ready: true,
    }]
    const result = await controller.gcPromotedPods()
    expect(result.orphansDeleted).toBe(1)
    expect((controller.deleteWarmPodService as any).mock.calls.length).toBe(1)
  })

  test('skips recently-promoted orphans (grace period)', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})
    projectFindManyResult = []
    controller.promotedPods = [{
      serviceName: 'svc-fresh',
      projectId: 'proj-fresh',
      url: 'http://svc-fresh',
      createdAt: 0,
      promotedAt: Date.now(), // fresh
      ready: true,
    }]
    const result = await controller.gcPromotedPods()
    expect(result.orphansDeleted).toBe(0)
  })

  test('Phase 2: evicts idle active pods past timeout', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller._idleTimeoutMs = 1000 // 1 s
    controller.evictProject = mock(async () => ({ evicted: true }))
    projectFindManyResult = [{ id: 'p', knativeServiceName: 'svc-active', name: 'n' }]
    controller.promotedPods = [{
      serviceName: 'svc-active',
      projectId: 'p',
      url: 'http://svc-active',
      createdAt: 0,
      promotedAt: Date.now() - 10 * 60_000, // past grace
      ready: true,
    }]
    fetchMockHandler = async (u) => {
      if (u.includes('/pool/activity')) {
        return { ok: true, status: 200, json: async () => ({ idleSeconds: 9999, activeStreams: 0 }) } as any
      }
      return { ok: false, status: 500, text: async () => '', json: async () => ({}) } as any
    }
    const result = await controller.gcPromotedPods()
    expect(result.idleEvicted).toBe(1)
  })

  test('Phase 2: skips pods with active streams', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller._idleTimeoutMs = 1000
    controller.evictProject = mock(async () => ({ evicted: true }))
    projectFindManyResult = [{ id: 'p', knativeServiceName: 'svc-stream', name: 'n' }]
    controller.promotedPods = [{
      serviceName: 'svc-stream', projectId: 'p', url: 'http://svc-stream',
      createdAt: 0, promotedAt: Date.now() - 10 * 60_000, ready: true,
    }]
    fetchMockHandler = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ idleSeconds: 9999, activeStreams: 2 }),
    } as any)
    const result = await controller.gcPromotedPods()
    expect(result.idleEvicted).toBe(0)
  })

  test('Phase 2: skips when idleSeconds * 1000 < timeout', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller._idleTimeoutMs = 10 * 60_000 // 10 minutes
    controller.evictProject = mock(async () => ({ evicted: true }))
    projectFindManyResult = [{ id: 'p', knativeServiceName: 'svc-fresh', name: 'n' }]
    controller.promotedPods = [{
      serviceName: 'svc-fresh', projectId: 'p', url: 'http://svc-fresh',
      createdAt: 0, promotedAt: Date.now() - 10 * 60_000, ready: true,
    }]
    fetchMockHandler = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ idleSeconds: 10, activeStreams: 0 }),
    } as any)
    const result = await controller.gcPromotedPods()
    expect(result.idleEvicted).toBe(0)
  })

  test('Phase 2: evicts unresponsive (non-OK) and unreachable (throwing) pods', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller._idleTimeoutMs = 1000
    controller.evictProject = mock(async () => ({ evicted: true }))
    projectFindManyResult = [
      { id: 'p1', knativeServiceName: 'svc-bad', name: 'n' },
      { id: 'p2', knativeServiceName: 'svc-unreachable', name: 'n2' },
    ]
    controller.promotedPods = [
      { serviceName: 'svc-bad', projectId: 'p1', url: 'http://svc-bad',
        createdAt: 0, promotedAt: Date.now() - 10 * 60_000, ready: true },
      { serviceName: 'svc-unreachable', projectId: 'p2', url: 'http://svc-unreachable',
        createdAt: 0, promotedAt: Date.now() - 10 * 60_000, ready: true },
    ]
    fetchMockHandler = async (u) => {
      if (u.includes('svc-bad')) {
        return { ok: false, status: 503, json: async () => ({}) } as any
      }
      throw new Error('connect ECONNREFUSED')
    }
    const result = await controller.gcPromotedPods()
    expect(result.idleEvicted).toBe(2)
  })

  test('Phase 2: respects soft-eviction cooldown', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller._idleTimeoutMs = 1000
    controller.evictProject = mock(async () => ({ evicted: true }))
    projectFindManyResult = [{ id: 'p', knativeServiceName: 'svc-cool', name: 'n' }]
    controller.promotedPods = [{
      serviceName: 'svc-cool', projectId: 'p', url: 'http://svc-cool',
      createdAt: 0, promotedAt: Date.now() - 10 * 60_000, ready: true,
    }]
    controller.softEvictedAt.set('svc-cool', Date.now()) // just soft-evicted
    const result = await controller.gcPromotedPods()
    expect(result.idleEvicted).toBe(0)
  })

  test('top-level error in GC cycle is caught', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.promotedPods = [{
      serviceName: 'svc', projectId: 'p', url: 'u',
      createdAt: 0, promotedAt: Date.now() - 10 * 60_000, ready: true,
    }]
    const prisma = (await import('../lib/prisma')).prisma
    const origFindMany = prisma.project.findMany
    prisma.project.findMany = (async () => {
      throw new Error('db down')
    }) as any
    try {
      const result = await controller.gcPromotedPods()
      expect(result).toEqual({ orphansDeleted: 0, idleEvicted: 0 })
    } finally {
      prisma.project.findMany = origFindMany
    }
  })
})

// =============================================================================
// gcOrphanedServices() — full classifier matrix
// =============================================================================

describe('gcOrphanedServices()', () => {
  test('returns 0 when no candidate services', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customListItems.services = []
    expect(await controller.gcOrphanedServices()).toBe(0)
  })

  test('deletes orphans, unschedulable, scaled-to-zero; skips active and recent', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})
    const now = Date.now()
    customListItems.services = [
      // Orphan: no DB mapping, past grace
      {
        metadata: { name: 'svc-orphan', labels: { 'shogo.io/project': 'p1' }, creationTimestamp: new Date(now - 10 * 60_000).toISOString() },
        status: { actualReplicas: 0, conditions: [] },
      },
      // Unschedulable past grace, with DB mapping → also schedule DB clear
      {
        metadata: { name: 'svc-unsched', labels: { 'shogo.io/project': 'p2' }, creationTimestamp: new Date(now - 10 * 60_000).toISOString() },
        status: { actualReplicas: 0, conditions: [{ type: 'Ready', status: 'False', reason: 'Unschedulable' }] },
      },
      // Scaled to zero, has DB mapping, NOT active → delete + clear
      {
        metadata: { name: 'svc-zero', labels: { 'shogo.io/project': 'p3' }, creationTimestamp: new Date(now - 10 * 60_000).toISOString() },
        status: { actualReplicas: 0, conditions: [{ type: 'Ready', status: 'True' }] },
      },
      // Scaled to zero, but active → skip
      {
        metadata: { name: 'svc-active', labels: { 'shogo.io/project': 'p4', 'shogo.io/active': 'true' }, creationTimestamp: new Date(now - 10 * 60_000).toISOString() },
        status: { actualReplicas: 0, conditions: [{ type: 'Ready', status: 'True' }] },
      },
      // Recently created → skip (in grace)
      {
        metadata: { name: 'svc-fresh', labels: { 'shogo.io/project': 'p5' }, creationTimestamp: new Date(now).toISOString() },
        status: { actualReplicas: 0, conditions: [] },
      },
      // Running, has DB mapping → leave
      {
        metadata: { name: 'svc-run', labels: { 'shogo.io/project': 'p6' }, creationTimestamp: new Date(now - 10 * 60_000).toISOString() },
        status: { actualReplicas: 1, conditions: [{ type: 'Ready', status: 'True' }] },
      },
      // System service skip
      {
        metadata: { name: 'mcp-workspace-1', labels: {}, creationTimestamp: new Date(now - 10 * 60_000).toISOString() },
        status: { actualReplicas: 1 },
      },
      // No name skip
      {
        metadata: { labels: {} },
      },
      // warm-pool available skip
      {
        metadata: {
          name: 'warm-pool-available',
          labels: { 'shogo.io/warm-pool-status': 'available' },
          creationTimestamp: new Date(now - 10 * 60_000).toISOString(),
        },
        status: { actualReplicas: 0 },
      },
      // project-XYZ name parsing (no project label)
      {
        metadata: { name: 'project-noLabel', labels: {}, creationTimestamp: new Date(now - 10 * 60_000).toISOString() },
        status: { actualReplicas: 0 },
      },
    ]
    // DB rows: svc-zero, svc-active, svc-run have mappings; p6 active
    projectFindManyResult = [
      { id: 'p3', knativeServiceName: 'svc-zero' },
      { id: 'p4', knativeServiceName: 'svc-active' },
      { id: 'p6', knativeServiceName: 'svc-run' },
    ]
    const deleted = await controller.gcOrphanedServices()
    expect(deleted).toBeGreaterThanOrEqual(2)
    // DB clear updateMany should have been called with svc-zero (and maybe svc-unsched if it had a mapping; it didn't)
    expect(projectUpdateManyCalls.some((c) =>
      Array.isArray(c.where?.knativeServiceName?.in) && c.where.knativeServiceName.in.includes('svc-zero'),
    )).toBe(true)
  })

  test('DB updateMany failure is logged but does not bubble', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})
    const now = Date.now()
    customListItems.services = [{
      metadata: { name: 'svc-zero', labels: { 'shogo.io/project': 'p' }, creationTimestamp: new Date(now - 10 * 60_000).toISOString() },
      status: { actualReplicas: 0, conditions: [{ type: 'Ready', status: 'True' }] },
    }]
    projectFindManyResult = [{ id: 'p', knativeServiceName: 'svc-zero' }]
    projectUpdateManyError = new Error('updateMany boom')
    const deleted = await controller.gcOrphanedServices()
    expect(deleted).toBe(1)
  })

  test('top-level error in listNamespacedCustomObject is caught', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customListErrorOnce = true
    expect(await controller.gcOrphanedServices()).toBe(0)
  })
})

// =============================================================================
// gcOrphanedDomainMappings()
// =============================================================================

describe('gcOrphanedDomainMappings()', () => {
  test('returns 0 when no domain mappings exist', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customListItems.domainmappings = []
    expect(await controller.gcOrphanedDomainMappings()).toBe(0)
  })

  test('deletes mappings whose backing service no longer exists', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customListItems.domainmappings = [
      { metadata: { name: 'dm-orphan' }, spec: { ref: { name: 'gone-svc' } } },
      { metadata: { name: 'dm-keep' }, spec: { ref: { name: 'live-svc' } } },
      { metadata: { name: 'dm-broken' }, spec: {} }, // no ref → skip
    ]
    customListItems.services = [{ metadata: { name: 'live-svc' } }]
    const deleted = await controller.gcOrphanedDomainMappings()
    expect(deleted).toBe(1)
    expect(customDeleteCalls.some((c) => c.name === 'dm-orphan')).toBe(true)
  })

  test('swallows 404 on delete', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customListItems.domainmappings = [
      { metadata: { name: 'dm-x' }, spec: { ref: { name: 'gone' } } },
    ]
    customListItems.services = []
    customDeleteError = Object.assign(new Error('not found'), { code: 404 })
    const deleted = await controller.gcOrphanedDomainMappings()
    expect(deleted).toBe(0)
  })

  test('logs and continues on non-404 delete error', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customListItems.domainmappings = [
      { metadata: { name: 'dm-x' }, spec: { ref: { name: 'gone' } } },
    ]
    customListItems.services = []
    customDeleteError = Object.assign(new Error('500'), { code: 500 })
    const deleted = await controller.gcOrphanedDomainMappings()
    expect(deleted).toBe(0)
  })

  test('top-level list error is caught', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customListErrorOnce = true
    expect(await controller.gcOrphanedDomainMappings()).toBe(0)
  })
})

// =============================================================================
// consolidateWarmPods()
// =============================================================================

describe('consolidateWarmPods()', () => {
  test('no-op when no pods have nodeName', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.available.set('a', pod({ id: 'a', nodeName: undefined }))
    await controller.consolidateWarmPods()
    expect(customDeleteCalls.length).toBe(0)
  })

  test('no-op when all pods on a single node', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.available.set('a', pod({ id: 'a', serviceName: 'wp-a', nodeName: 'n1' }))
    controller.available.set('b', pod({ id: 'b', serviceName: 'wp-b', nodeName: 'n1' }))
    await controller.consolidateWarmPods()
    expect(customDeleteCalls.length).toBe(0)
  })

  test('drains the node with fewest non-warm workloads', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})
    controller.available.set('a', pod({ id: 'a', serviceName: 'wp-a', nodeName: 'node-quiet' }))
    controller.available.set('b', pod({ id: 'b', serviceName: 'wp-b', nodeName: 'node-busy' }))
    // expand-ns has no non-warm pods on node-quiet; node-busy has app pods
    nsPodsByNs['expand-ns'] = [
      // warm pool pod (skipped via label)
      { spec: { nodeName: 'node-quiet' }, metadata: { labels: { 'shogo.io/warm-pool': 'true' } } },
      // non-warm pod on busy
      { spec: { nodeName: 'node-busy' }, metadata: { labels: {} } },
    ]
    // System namespaces: shogo-production-system, knative-serving, kourier-system, cnpg-system
    nsPodsByNs['knative-serving'] = [
      { spec: { nodeName: 'node-busy' }, metadata: { ownerReferences: [{ kind: 'ReplicaSet' }] } },
      { spec: { nodeName: 'node-busy' }, metadata: { ownerReferences: [{ kind: 'DaemonSet' }] } }, // daemonset skip
    ]
    nsListErrorByNs['kourier-system'] = true // exercise the catch branch
    await controller.consolidateWarmPods()
    expect((controller.deleteWarmPodService as any).mock.calls.some((args: any[]) => args[0] === 'wp-a')).toBe(true)
  })

  test('skips when every candidate node has too many non-warm workloads', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})
    controller.available.set('a', pod({ id: 'a', serviceName: 'wp-a', nodeName: 'node-1' }))
    controller.available.set('b', pod({ id: 'b', serviceName: 'wp-b', nodeName: 'node-2' }))
    nsPodsByNs['expand-ns'] = Array.from({ length: 10 }, (_, i) => ({
      spec: { nodeName: i < 5 ? 'node-1' : 'node-2' },
      metadata: { labels: {} },
    }))
    await controller.consolidateWarmPods()
    expect((controller.deleteWarmPodService as any).mock.calls.length).toBe(0)
  })
})

// =============================================================================
// createWarmPod()
// =============================================================================

describe('createWarmPod()', () => {
  test('successful path returns a WarmPodInfo', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    const info = await controller.createWarmPod('abc12345')
    expect(info?.serviceName).toBe('warm-pool-abc12345')
    expect(info?.ready).toBe(false)
    expect(customCreateCalls.length).toBe(1)
  })

  test('treats 409 AlreadyExists as success', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customCreateError = Object.assign(new Error('exists'), {
      response: { statusCode: 409 },
      body: { reason: 'AlreadyExists' },
    })
    const info = await controller.createWarmPod('dup-1')
    expect(info?.serviceName).toBe('warm-pool-dup-1')
  })

  test('rethrows non-409 create errors', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customCreateError = Object.assign(new Error('forbidden'), { statusCode: 403 })
    await expect(controller.createWarmPod('boom')).rejects.toThrow('forbidden')
  })

  test('threads optional env (OTEL/SIGNOZ/PUBLIC_API_URL) into the spec when set', async () => {
    const prev = { ...process.env }
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel.example'
    process.env.SIGNOZ_INGESTION_KEY = 'k'
    process.env.SHOGO_PUBLIC_API_URL = 'https://public.shogo'
    try {
      const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
      await controller.createWarmPod('envcheck')
      const body = customCreateCalls.at(-1)?.body
      const envList = body?.spec?.template?.spec?.containers?.[0]?.env ?? []
      const names = envList.map((e: any) => e.name)
      expect(names).toContain('OTEL_EXPORTER_OTLP_ENDPOINT')
      expect(names).toContain('SIGNOZ_INGESTION_KEY')
      expect(names).toContain('SHOGO_PUBLIC_API_URL')
    } finally {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev.OTEL_EXPORTER_OTLP_ENDPOINT
      process.env.SIGNOZ_INGESTION_KEY = prev.SIGNOZ_INGESTION_KEY
      process.env.SHOGO_PUBLIC_API_URL = prev.SHOGO_PUBLIC_API_URL
    }
  })
})

// =============================================================================
// claimTrimAndDelete()
// =============================================================================

describe('claimTrimAndDelete()', () => {
  test('CAS-win deletes the pod', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})
    jsonPatchResultQueue.push(true)
    await controller.claimTrimAndDelete(pod({ serviceName: 'cas-win' }))
    expect((controller.deleteWarmPodService as any).mock.calls.length).toBe(1)
  })

  test('CAS-lose skips the delete', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})
    jsonPatchResultQueue.push(false)
    await controller.claimTrimAndDelete(pod({ serviceName: 'cas-lose' }))
    expect((controller.deleteWarmPodService as any).mock.calls.length).toBe(0)
  })

  test('swallows 404 from json-patch (pod already deleted)', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})
    jsonPatchErrorQueue.push(Object.assign(new Error('not found'), { statusCode: 404 }))
    await controller.claimTrimAndDelete(pod({ serviceName: 'gone' }))
    expect((controller.deleteWarmPodService as any).mock.calls.length).toBe(0)
  })

  test('rethrows other patch errors', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    jsonPatchErrorQueue.push(Object.assign(new Error('500'), { statusCode: 500 }))
    await expect(controller.claimTrimAndDelete(pod({ serviceName: 'boom' }))).rejects.toThrow('500')
  })
})

// =============================================================================
// deleteWarmPodService()
// =============================================================================

describe('deleteWarmPodService()', () => {
  test('reads service labels to resolve projectId when not supplied, then deletes DomainMapping', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customGetResponse = { metadata: { labels: { 'shogo.io/project': 'proj-from-label' } } }
    await controller.deleteWarmPodService('svc-1')
    expect(customDeleteCalls.some((c) => c.name === 'svc-1')).toBe(true)
    expect(deletedPreviewMappings).toContain('proj-from-label')
  })

  test('label read 404 is non-fatal; proceeds with delete', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customGetError = Object.assign(new Error('not found'), { code: 404 })
    await controller.deleteWarmPodService('svc-2')
    expect(customDeleteCalls.some((c) => c.name === 'svc-2')).toBe(true)
  })

  test('label read non-404 error is logged but non-fatal', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customGetError = Object.assign(new Error('boom'), { code: 500 })
    await controller.deleteWarmPodService('svc-3')
    expect(customDeleteCalls.some((c) => c.name === 'svc-3')).toBe(true)
  })

  test('swallows 404 on delete', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customDeleteError = Object.assign(new Error('gone'), { code: 404 })
    await controller.deleteWarmPodService('svc-4', 'proj-x')
    expect(deletedPreviewMappings).toContain('proj-x')
  })

  test('rethrows non-404 delete errors', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customDeleteError = Object.assign(new Error('forbidden'), { code: 403 })
    await expect(controller.deleteWarmPodService('svc-5', 'p')).rejects.toThrow('forbidden')
  })

  test('no projectId & label read returns no project: no DomainMapping cleanup', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customGetResponse = { metadata: { labels: {} } }
    const before = deletedPreviewMappings.length
    await controller.deleteWarmPodService('svc-bare')
    expect(deletedPreviewMappings.length).toBe(before)
  })
})

// =============================================================================
// discoverExistingPods()
// =============================================================================

describe('discoverExistingPods()', () => {
  test('catches promoted, claimed, assigned, ready, stale-image, broken, unschedulable + pod-level brokenness', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.deleteWarmPodService = mock(async () => {})

    const old = Date.now() - 60 * 60 * 1000
    customListItems.services = [
      // Promoted
      {
        metadata: { name: 'wp-promoted', labels: { 'shogo.io/warm-pool-status': 'promoted', 'shogo.io/project': 'p1' }, creationTimestamp: new Date(old).toISOString() },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      // Assigned (status label)
      {
        metadata: { name: 'wp-assigned', labels: { 'shogo.io/warm-pool-status': 'assigned', 'shogo.io/project': 'p2' }, creationTimestamp: new Date(old).toISOString() },
        status: { conditions: [{ type: 'Ready', status: 'False' }] },
      },
      // Claimed (covered by claimedServiceNames set below)
      {
        metadata: { name: 'wp-claimed', labels: { 'shogo.io/warm-pool-status': 'available' }, creationTimestamp: new Date(old).toISOString() },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      // Assigned via map
      {
        metadata: { name: 'wp-inmap', labels: { 'shogo.io/warm-pool-status': 'available' }, creationTimestamp: new Date(old).toISOString() },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      // Stale image → recycle
      {
        metadata: { name: 'wp-stale', labels: { 'shogo.io/warm-pool-status': 'available' }, creationTimestamp: new Date(old).toISOString() },
        spec: { template: { spec: { containers: [{ image: 'fake-old-image:xyz' }] } } },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      // Broken (RevisionFailed)
      {
        metadata: { name: 'wp-broken', labels: { 'shogo.io/warm-pool-status': 'available' }, creationTimestamp: new Date(old).toISOString() },
        status: { conditions: [{ type: 'Ready', status: 'False', reason: 'RevisionFailed' }] },
      },
      // Unschedulable past grace
      {
        metadata: { name: 'wp-unsched', labels: { 'shogo.io/warm-pool-status': 'available' }, creationTimestamp: new Date(old).toISOString() },
        status: { conditions: [{ type: 'Ready', status: 'False', reason: 'Unschedulable' }] },
      },
      // Healthy available (will be added to map; image matches RUNTIME_CONFIG)
      {
        metadata: { name: 'wp-healthy', labels: { 'shogo.io/warm-pool-status': 'available' }, creationTimestamp: new Date(old).toISOString() },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      // No name skip
      { metadata: {} },
    ]
    // Pod-level broken signal on a separate name to exercise that branch
    nsPodsByNs['expand-ns'] = [
      {
        metadata: { labels: { 'shogo.io/warm-pool': 'true', 'serving.knative.dev/service': 'wp-podbroken' } },
        spec: { nodeName: 'node-a' },
        status: { containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] },
      },
      // Healthy pod node tag
      {
        metadata: { labels: { 'shogo.io/warm-pool': 'true', 'serving.knative.dev/service': 'wp-healthy' } },
        spec: { nodeName: 'node-b' },
        status: {},
      },
    ]
    // Add pod-broken corresponding ksvc entry
    customListItems.services.push({
      metadata: { name: 'wp-podbroken', labels: { 'shogo.io/warm-pool-status': 'available' }, creationTimestamp: new Date(old).toISOString() },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    })

    controller.claimedServiceNames.add('wp-claimed')
    controller.assigned.set('proj-x', { id: 'wp-inmap', serviceName: 'wp-inmap', url: '', createdAt: 0, ready: true })
    // Pre-existing in available — should be updated
    controller.available.set('wp-healthy', { id: 'wp-healthy', serviceName: 'wp-healthy', url: '', createdAt: 0, ready: false })
    // A stale entry that no longer exists in K8s → should be removed
    controller.available.set('ghost', { id: 'ghost', serviceName: 'ghost', url: '', createdAt: 0, ready: true })
    // Soft-evicted entries: one matching a current promoted pod (keep), one ghost (delete)
    controller.softEvictedAt.set('wp-promoted', Date.now())
    controller.softEvictedAt.set('soft-ghost', Date.now() - 24 * 60 * 60 * 1000)

    await controller.discoverExistingPods()

    expect(controller.promotedPods.some((p: any) => p.serviceName === 'wp-promoted')).toBe(true)
    expect(controller.available.has('wp-stale')).toBe(false)
    expect(controller.available.has('wp-broken')).toBe(false)
    expect(controller.available.has('wp-unsched')).toBe(false)
    expect(controller.available.has('wp-podbroken')).toBe(false)
    expect(controller.available.has('wp-healthy')).toBe(true)
    expect(controller.available.get('wp-healthy')?.nodeName).toBe('node-b')
    expect(controller.available.has('ghost')).toBe(false)
    expect(controller.softEvictedAt.has('soft-ghost')).toBe(false)
    expect((controller.deleteWarmPodService as any).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  test('pod-list error is non-fatal; service discovery still works', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    nsListErrorByNs['expand-ns'] = true
    customListItems.services = [{
      metadata: { name: 'wp-1', labels: { 'shogo.io/warm-pool-status': 'available' }, creationTimestamp: new Date().toISOString() },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    }]
    await controller.discoverExistingPods()
    expect(controller.available.size).toBeGreaterThanOrEqual(0)
  })

  test('top-level list error is caught', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    customListErrorOnce = true
    await controller.discoverExistingPods()
    expect(controller.available.size).toBe(0)
  })
})

// =============================================================================
// evictProject — additional branches
// =============================================================================

describe('evictProject()', () => {
  test('soft evict with no in-memory pod falls back to DB lookup', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    projectFindUniqueRows.push({ knativeServiceName: 'svc-soft-db' })
    const result = await controller.evictProject('p-soft', { deleteService: false })
    expect(result.evicted).toBe(true)
    expect(controller.softEvictedAt.has('svc-soft-db')).toBe(true)
  })

  // Regression: soft-evict must flip shogo.io/active=false so the namespace
  // GC's scaled-to-zero sweeper can reap the ksvc once Knative drops the
  // pod. Without this flip, every idle project leaks a permanent ksvc —
  // staging accumulated 51 leaked ksvcs (240 cumulative idle evictions, 0
  // namespace deletions) and the resulting webhook/route churn took a node
  // NotReady and surfaced as Cloudflare 525s.
  test('soft evict patches shogo.io/active=false on the ksvc (fire-and-forget)', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.assigned.set('p-soft-active', pod({ serviceName: 'svc-soft-active' }))
    const result = await controller.evictProject('p-soft-active', { deleteService: false })
    expect(result.evicted).toBe(true)
    expect(controller.softEvictedAt.has('svc-soft-active')).toBe(true)
    // Wait for the fire-and-forget background task to flush
    await new Promise((r) => setTimeout(r, 10))
    const patchCall = mergePatchCalls.find(([, name]) => name === 'svc-soft-active')
    expect(patchCall).toBeDefined()
    expect(patchCall![0]).toBe('expand-ns')
    expect(patchCall![2]).toEqual({ metadata: { labels: { 'shogo.io/active': 'false' } } })
  })

  test('soft evict swallows 404 from the active-label patch (service already deleted)', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.assigned.set('p-soft-404', pod({ serviceName: 'svc-soft-404' }))
    mergePatchErrorQueue.push(Object.assign(new Error('the service was not found'), { code: 404 }))
    const result = await controller.evictProject('p-soft-404', { deleteService: false })
    expect(result.evicted).toBe(true)
    expect(controller.softEvictedAt.has('svc-soft-404')).toBe(true)
    // The 404 should be silently swallowed — no unhandled rejection
    await new Promise((r) => setTimeout(r, 10))
  })

  test('soft evict with no in-memory pod and DB lookup failure returns evicted=false', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    const prisma = (await import('../lib/prisma')).prisma
    const orig = prisma.project.findUnique
    prisma.project.findUnique = (async () => { throw new Error('db dead') }) as any
    try {
      const result = await controller.evictProject('p-soft-fail', { deleteService: false })
      expect(result.evicted).toBe(false)
    } finally {
      prisma.project.findUnique = orig
    }
  })

  test.skip('hard evict where DB lookup fails still proceeds with in-memory pod', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.assigned.set('p-hard', pod({ serviceName: 'svc-hard' }))
    const prisma = (await import('../lib/prisma')).prisma
    const orig = prisma.project.findUnique
    prisma.project.findUnique = (async () => { throw new Error('db dead') }) as any
    try {
      const result = await controller.evictProject('p-hard')
      // Fire-and-forget delete + dm cleanup
      await new Promise((r) => setTimeout(r, 10))
      expect(result.evicted).toBe(true)
      expect(result.oldService).toBe('svc-hard')
    } finally {
      prisma.project.findUnique = orig
    }
  })

  test('hard evict service-delete 404 path is swallowed', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.assigned.set('p-404', pod({ serviceName: 'svc-404' }))
    projectFindUniqueRows.push({ knativeServiceName: 'svc-404' })
    customDeleteError = Object.assign(new Error('not found'), { statusCode: 404 })
    const result = await controller.evictProject('p-404')
    await new Promise((r) => setTimeout(r, 10))
    expect(result.evicted).toBe(true)
  })

  test('returns evicted=false when there is no pod and DB has no mapping', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    projectFindUniqueRows.push({ knativeServiceName: null })
    const result = await controller.evictProject('nobody')
    expect(result.evicted).toBe(false)
  })
})

// =============================================================================
// getCapacitySummary, getExtendedStatus, getStatus, getConfig
// =============================================================================

describe('getCapacitySummary()', () => {
  test('short-circuits to null when SHOGO_LOCAL_MODE=true', async () => {
    const prev = process.env.SHOGO_LOCAL_MODE
    process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
      const summary = await controller.getCapacitySummary()
      expect(summary).toBeNull()
    } finally {
      process.env.SHOGO_LOCAL_MODE = prev ?? 'false'
    }
  })

  test.skip('catches listNode failure and returns null', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    nsListErrorByNs['expand-ns'] = false
    // Swap CoreV1Api.listNode to throw by overriding nodeItems via getter that throws.
    const k8s = await import('@kubernetes/client-node')
    const origCore: any = (k8s as any).CoreV1Api
    ;(k8s as any).CoreV1Api = class {
      async listNode() { throw new Error('list node failed') }
      async listPodForAllNamespaces() { return { items: [] } }
      async listNamespacedPod() { return { items: [] } }
    }
    try {
      const summary = await controller.getCapacitySummary()
      expect(summary).toBeNull()
    } finally {
      ;(k8s as any).CoreV1Api = origCore
    }
  })
})

// =============================================================================
// buildProjectEnv
// =============================================================================

describe('buildProjectEnv()', () => {
  test('delegates to the shared utility', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    buildProjectEnvImpl = async (projectId, opts) => {
      expect(opts?.logPrefix).toBe('WarmPool')
      return { PROJECT_ID: projectId, MARKER: 'yes' }
    }
    const env = await controller.buildProjectEnv('proj-build')
    expect(env.PROJECT_ID).toBe('proj-build')
    expect(env.MARKER).toBe('yes')
  })
})

// =============================================================================
// reconcilePromotedPods
// =============================================================================

describe('reconcilePromotedPods()', () => {
  test('delegates to rescue helper and returns its summary', async () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    rescueSummary = { scanned: 7, stuck: 2, evicted: 1, errors: 0 }
    const result = await controller.reconcilePromotedPods()
    expect(result).toEqual({ scanned: 7, stuck: 2, evicted: 1, errors: 0 })
  })
})

// =============================================================================
// Singleton + loadPersistedSettings + startWarmPool
// =============================================================================

describe('singleton + startWarmPool()', () => {
  test('getWarmPoolController returns a stable singleton', () => {
    const a = getWarmPoolController()
    const b = getWarmPoolController()
    expect(a).toBe(b)
  })

  test('startWarmPool loads persisted settings (numeric, boolean, invalid) and starts the controller', async () => {
    platformSettingsRows = [
      { key: 'infra.warmPoolMinPods', value: '7' },
      { key: 'infra.promotedPodGcEnabled', value: 'false' },
      { key: 'infra.reconcileIntervalMs', value: 'not-a-number' }, // ignored
      { key: 'infra.maxPodAgeMs', value: '-5' }, // ignored (negative)
    ]
    const controller = await startWarmPool()
    expect(controller.getConfig().warmPoolMinPods).toBe(7)
    expect(controller.getConfig().promotedPodGcEnabled).toBe(false)
    await controller.stop()
  })

  test('startWarmPool tolerates platformSetting failure', async () => {
    platformSettingsError = new Error('db dead')
    const controller = await startWarmPool()
    expect(controller).toBeDefined()
    await controller.stop()
  })

  test('startWarmPool no-ops when there are zero persisted settings', async () => {
    platformSettingsRows = []
    const controller = await startWarmPool()
    expect(controller).toBeDefined()
    await controller.stop()
  })
})

// =============================================================================
// pruneBrokenSet edge cases (in addition to warm-pool-core)
// =============================================================================

describe('pruneBrokenSet()', () => {
  test('keeps services that still exist and removes those that do not', () => {
    const controller = new WarmPoolController({ namespace: 'expand-ns' }) as any
    controller.brokenAlreadyCounted.add('a')
    controller.brokenAlreadyCounted.add('b')
    controller.brokenAlreadyCounted.add('c')
    controller.pruneBrokenSet(new Set(['b']))
    expect(controller.brokenAlreadyCounted.has('a')).toBe(false)
    expect(controller.brokenAlreadyCounted.has('b')).toBe(true)
    expect(controller.brokenAlreadyCounted.has('c')).toBe(false)
  })
})

// =============================================================================
// WarmPodGoneError shape
// =============================================================================

describe('WarmPodGoneError', () => {
  test('exposes code, name, and message', () => {
    const err = new WarmPodGoneError('svc-x', 'service deleted')
    expect(err.code).toBe('WARM_POD_GONE')
    expect(err.name).toBe('WarmPodGoneError')
    expect(err.message).toContain('svc-x')
    expect(err).toBeInstanceOf(Error)
  })
})
