// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.WARM_POOL_ENABLED = 'false'
process.env.PROJECT_NAMESPACE = 'core-ns'
process.env.SHOGO_LOCAL_MODE = 'false'

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withK8sExports } from './helpers/k8s-mock'
import { withPrismaExports } from './helpers/prisma-mock-exports'

let nodeItems: any[] = []
let podItems: any[] = []
const projectUpdateManyCalls: any[] = []
const projectUpdateCalls: any[] = []
const projectFindUniqueRows: any[] = []
const mergePatchCalls: any[] = []
const deletedPreviewMappings: string[] = []

mock.module('@kubernetes/client-node', () => withK8sExports({
  CoreV1Api: {
    listNode: async () => ({ items: nodeItems }),
    listPodForAllNamespaces: async () => ({ items: podItems }),
  },
}))

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findUnique: async () => projectFindUniqueRows.shift() ?? null,
      update: async (args: any) => {
        projectUpdateCalls.push(args)
        return args.data
      },
    },
    $transaction: async (fn: any) => fn({
      project: {
        findUnique: async () => projectFindUniqueRows.shift() ?? null,
        updateMany: async (args: any) => {
          projectUpdateManyCalls.push(args)
          return { count: 2 }
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
  },
  getKnativeProjectManager: () => ({
    deletePreviewDomainMapping: async (projectId: string) => {
      deletedPreviewMappings.push(projectId)
    },
  }),
}))

const { WarmPoolController } = await import('../lib/warm-pool-controller')

beforeEach(() => {
  nodeItems = []
  podItems = []
  projectUpdateManyCalls.length = 0
  projectUpdateCalls.length = 0
  projectFindUniqueRows.length = 0
  mergePatchCalls.length = 0
  deletedPreviewMappings.length = 0
})

function pod(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pod-1',
    serviceName: 'warm-pod-1',
    url: 'https://warm-pod-1.example',
    createdAt: Date.now(),
    ready: true,
    ...overrides,
  }
}

describe('WarmPoolController core helpers', () => {
  test('recordBrokenForBreaker counts each young broken service once and trips the circuit breaker', () => {
    const controller = new WarmPoolController({ namespace: 'core-ns' }) as any

    controller.recordBrokenForBreaker('svc-1', 'Unschedulable', 1_000)
    controller.recordBrokenForBreaker('svc-1', 'Unschedulable', 1_000)
    expect(controller.consecutiveCreationFailures).toBe(1)

    controller.recordBrokenForBreaker('old-svc', 'ImagePullBackOff', 60 * 60 * 1000)
    expect(controller.consecutiveCreationFailures).toBe(1)

    for (let i = 2; i <= 5; i++) {
      controller.recordBrokenForBreaker(`svc-${i}`, 'Unschedulable', 1_000)
    }
    expect(controller.consecutiveCreationFailures).toBe(5)
    expect(controller.circuitBreakerOpenUntil).toBeGreaterThan(Date.now())

    controller.pruneBrokenSet(new Set(['svc-5']))
    expect(controller.brokenAlreadyCounted.has('svc-1')).toBe(false)
    expect(controller.brokenAlreadyCounted.has('svc-5')).toBe(true)
  })

  test('countReadyNodes ignores Karpenter nodes, NotReady nodes, and cordoned nodes', async () => {
    nodeItems = [
      {
        metadata: { labels: {} },
        spec: {},
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      {
        metadata: { labels: { 'karpenter.sh/nodepool': 'default' } },
        spec: {},
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      {
        metadata: { labels: {} },
        spec: { unschedulable: true },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      {
        metadata: { labels: {} },
        spec: {},
        status: { conditions: [{ type: 'Ready', status: 'False' }] },
      },
    ]
    const controller = new WarmPoolController({ namespace: 'core-ns' }) as any

    await expect(controller.countReadyNodes()).resolves.toBe(1)
  })

  test('claim handles cold starts, claims a ready pod, and exposes assigned pod lookup helpers', () => {
    const controller = new WarmPoolController({ namespace: 'core-ns', poolSize: 2 }) as any
    controller.reconcile = mock(async () => {})

    expect(controller.claim()).toBeNull()

    const ready = pod()
    controller.available.set(ready.id, ready)
    const claimed = controller.claim()
    expect(claimed).toBe(ready)
    expect(controller.available.has(ready.id)).toBe(false)
    expect(controller.claimedServiceNames.has(ready.serviceName)).toBe(true)

    controller.assigned.set('proj-1', ready)
    expect(controller.getAssignedUrl('proj-1')).toBe('https://warm-pod-1.example')
    expect(controller.getAssignedPod('proj-1')).toBe(ready)
    expect(controller.isAssigned('proj-1')).toBe(true)
    expect(controller.getAssignedUrl('missing')).toBeNull()

    controller.stop()
  })

  test('saveProjectMapping clears stale mappings before saving the current project mapping', async () => {
    const controller = new WarmPoolController({ namespace: 'core-ns' }) as any

    await controller.saveProjectMapping(pod({ serviceName: 'warm-pod-save' }), 'proj-1')

    expect(projectUpdateManyCalls[0]).toEqual({
      where: {
        knativeServiceName: 'warm-pod-save',
        id: { not: 'proj-1' },
      },
      data: { knativeServiceName: null },
    })
    expect(projectUpdateCalls[0]).toEqual({
      where: { id: 'proj-1' },
      data: { knativeServiceName: 'warm-pod-save' },
    })
  })

  test('getConfig/updateConfig/getStatus expose mutable pool settings and snapshots', async () => {
    const controller = new WarmPoolController({ namespace: 'core-ns', poolSize: 2, reconcileIntervalMs: 1_000, maxPodAgeMs: 5_000 }) as any
    controller.reconcile = mock(async () => {})
    controller.started = true
    controller.reconcileTimer = setInterval(() => {}, 10_000)
    controller.available.set('a', pod({ id: 'a', ready: true }))
    controller.assigned.set('proj-1', pod({ id: 'assigned' }))
    controller.promotedPods = [{ serviceName: 'svc', projectId: 'proj', url: 'url', createdAt: 1, promotedAt: 2, ready: true }]
    controller.gcStats.namespaceServicesDeleted = 3

    expect(controller.getStatus()).toMatchObject({ enabled: false, available: 1, assigned: 1, targetSize: 2 })
    expect(controller.getConfig()).toMatchObject({
      warmPoolMinPods: 2,
      reconcileIntervalMs: 1_000,
      maxPodAgeMs: 5_000,
    })

    controller.updateConfig({
      warmPoolMinPods: 4,
      reconcileIntervalMs: 2_000,
      maxPodAgeMs: 6_000,
      promotedPodIdleTimeoutMs: 7_000,
      promotedPodGcEnabled: false,
    })

    expect(controller.getConfig()).toMatchObject({
      warmPoolMinPods: 4,
      reconcileIntervalMs: 2_000,
      maxPodAgeMs: 6_000,
      promotedPodIdleTimeoutMs: 7_000,
      promotedPodGcEnabled: false,
    })
    expect(controller.getPromotedPods()).toEqual(controller.promotedPods)
    expect(controller.getGcStats().namespaceServicesDeleted).toBe(3)

    clearInterval(controller.reconcileTimer)
    controller.reconcileTimer = null
  })

  test('getExtendedStatus includes live capacity summary from nodes and running pods', async () => {
    nodeItems = [
      {
        spec: {},
        status: {
          allocatable: { cpu: '2', pods: '20' },
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
      {
        spec: { unschedulable: true },
        status: {
          allocatable: { cpu: '1000m', pods: '10' },
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
    ]
    podItems = [
      { spec: { containers: [{ resources: { requests: { cpu: '250m' }, limits: { cpu: '1' } } }] } },
      { spec: { containers: [{ resources: { requests: { cpu: '0.5' }, limits: { cpu: '750m' } } }] } },
    ]
    const controller = new WarmPoolController({ namespace: 'core-ns' }) as any

    const status = await controller.getExtendedStatus()

    expect(status.cluster).toMatchObject({
      totalNodes: 1,
      totalPodSlots: 20,
      usedPodSlots: 2,
      totalCpuMillis: 2000,
      usedCpuMillis: 750,
      limitCpuMillis: 1750,
    })
  })

  test('evictProject supports soft and hard eviction modes', async () => {
    const controller = new WarmPoolController({ namespace: 'core-ns' }) as any
    const assignedPod = pod({ serviceName: 'warm-hard' })
    controller.assigned.set('hard-proj', assignedPod)

    const hard = await controller.evictProject('hard-proj')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(hard).toEqual({ evicted: true, oldService: 'warm-hard' })
    expect(controller.assigned.has('hard-proj')).toBe(false)
    expect(mergePatchCalls[0][1]).toBe('warm-hard')
    expect(deletedPreviewMappings).toContain('hard-proj')

    projectFindUniqueRows.push({ knativeServiceName: 'warm-soft-db' })
    const soft = await controller.evictProject('soft-proj', { deleteService: false })

    expect(soft).toEqual({ evicted: true, oldService: 'warm-soft-db' })
    expect(controller.softEvictedAt.has('warm-soft-db')).toBe(true)
  })
})
