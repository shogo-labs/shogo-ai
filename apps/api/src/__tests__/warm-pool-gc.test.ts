// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.WARM_POOL_ENABLED = 'false'
process.env.PROJECT_NAMESPACE = 'gc-ns'

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withK8sExports, type K8sCallLog } from './helpers/k8s-mock'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const capture: K8sCallLog = []
let serviceItems: any[] = []
let domainMappingItems: any[] = []
let getServiceProjectId: string | null = null
let listError: Error | null = null
let projectRows: Array<{ id: string; knativeServiceName: string | null }> = []
const updateManyCalls: any[] = []
const deletedPreviewMappings: string[] = []

mock.module('@kubernetes/client-node', () => withK8sExports({
  capture,
  CustomObjectsApi: {
    listNamespacedCustomObject: async (args: any) => {
      if (listError) throw listError
      if (args.plural === 'domainmappings') return { items: domainMappingItems }
      return { items: serviceItems }
    },
    getNamespacedCustomObject: async () => ({
      metadata: { labels: getServiceProjectId ? { 'shogo.io/project': getServiceProjectId } : {} },
    }),
    deleteNamespacedCustomObject: async (_args: any) => {
      return { body: {} }
    },
  },
}))

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findMany: async () => projectRows,
      updateMany: async (args: any) => {
        updateManyCalls.push(args)
        return { count: args.where?.knativeServiceName?.in?.length ?? 0 }
      },
    },
  },
}))

mock.module('../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({
    deletePreviewDomainMapping: async (projectId: string) => {
      deletedPreviewMappings.push(projectId)
    },
  }),
}))

mock.module('../services/database.service', () => ({}))

const { WarmPoolController } = await import('../lib/warm-pool-controller')

beforeEach(() => {
  capture.length = 0
  serviceItems = []
  domainMappingItems = []
  getServiceProjectId = null
  listError = null
  projectRows = []
  updateManyCalls.length = 0
  deletedPreviewMappings.length = 0
})

const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const recentTimestamp = new Date().toISOString()

function service(name: string, labels: Record<string, string>, status: Record<string, unknown> = {}) {
  return {
    metadata: { name, labels, creationTimestamp: oldTimestamp },
    status,
  }
}

describe('WarmPoolController namespace garbage collection', () => {
  test('deletes orphaned, unschedulable, and inactive scaled-to-zero services and clears stale DB mappings', async () => {
    projectRows = [
      { id: 'mapped-project', knativeServiceName: 'mapped-zero' },
      { id: 'unschedulable-project', knativeServiceName: 'mapped-unschedulable' },
      { id: 'active-project', knativeServiceName: 'active-zero' },
    ]
    serviceItems = [
      service('orphan-service', { 'shogo.io/project': 'missing-project' }, { actualReplicas: 1 }),
      service('mapped-zero', { 'shogo.io/project': 'mapped-project' }, { actualReplicas: 0 }),
      service('mapped-unschedulable', { 'shogo.io/project': 'unschedulable-project' }, {
        actualReplicas: 1,
        conditions: [{ type: 'Ready', reason: 'Unschedulable' }],
      }),
      service('active-zero', { 'shogo.io/project': 'active-project', 'shogo.io/active': 'true' }, { actualReplicas: 0 }),
      service('recent-orphan', { 'shogo.io/project': 'recent-project' }, { actualReplicas: 0 }),
      service('warm-pool-available', { 'shogo.io/warm-pool-status': 'available' }, { actualReplicas: 0 }),
      service('mcp-workspace-1', {}, { actualReplicas: 0 }),
    ]
    serviceItems[4].metadata.creationTimestamp = recentTimestamp
    getServiceProjectId = 'resolved-project'
    const controller = new WarmPoolController({ namespace: 'gc-ns' })

    const deleted = await controller.gcOrphanedServices()
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(deleted).toBe(3)
    const deletedServiceNames = capture
      .filter((c) => c.method === 'deleteNamespacedCustomObject' && c.args[0].plural === 'services')
      .map((c) => c.args[0].name)
    expect(deletedServiceNames).toEqual(expect.arrayContaining([
      'orphan-service',
      'mapped-zero',
      'mapped-unschedulable',
    ]))
    expect(deletedServiceNames).not.toContain('active-zero')
    expect(deletedServiceNames).not.toContain('recent-orphan')
    expect(updateManyCalls[0].where.knativeServiceName.in).toEqual([
      'mapped-zero',
      'mapped-unschedulable',
    ])
    expect(deletedPreviewMappings).toContain('missing-project')
  })

  test('never deletes durable published-* services (scaled-to-zero, orphaned, or unschedulable)', async () => {
    // No matching project rows ⇒ every candidate looks "orphaned" to the GC,
    // and they are all scaled-to-zero past the grace window. A preview/project
    // service in this state WOULD be swept; published-* services must not be.
    projectRows = []
    serviceItems = [
      service('published-zero-project', { 'shogo.io/project': 'p-zero' }, { actualReplicas: 0 }),
      service('published-unschedulable', { 'shogo.io/project': 'p-unsched' }, {
        actualReplicas: 1,
        conditions: [{ type: 'Ready', reason: 'Unschedulable' }],
      }),
      service('published-running', { 'shogo.io/project': 'p-run' }, { actualReplicas: 1 }),
      // A genuine preview orphan alongside them is still collected.
      service('project-orphan', { 'shogo.io/project': 'gone' }, { actualReplicas: 0 }),
    ]
    const controller = new WarmPoolController({ namespace: 'gc-ns' })

    const deleted = await controller.gcOrphanedServices()
    await new Promise((resolve) => setTimeout(resolve, 5))

    const deletedServiceNames = capture
      .filter((c) => c.method === 'deleteNamespacedCustomObject' && c.args[0].plural === 'services')
      .map((c) => c.args[0].name)
    expect(deletedServiceNames).not.toContain('published-zero-project')
    expect(deletedServiceNames).not.toContain('published-unschedulable')
    expect(deletedServiceNames).not.toContain('published-running')
    expect(deletedServiceNames).toContain('project-orphan')
    expect(deleted).toBe(1)
  })

  test('returns zero when there are no candidates or Kubernetes list fails', async () => {
    const controller = new WarmPoolController({ namespace: 'gc-ns' })
    expect(await controller.gcOrphanedServices()).toBe(0)

    listError = new Error('k8s unavailable')
    expect(await controller.gcOrphanedServices()).toBe(0)
  })
})

describe('WarmPoolController DomainMapping garbage collection', () => {
  test('deletes DomainMappings whose referenced services no longer exist', async () => {
    domainMappingItems = [
      { metadata: { name: 'preview--missing.dev.example.com' }, spec: { ref: { name: 'deleted-service' } } },
      { metadata: { name: 'preview--live.dev.example.com' }, spec: { ref: { name: 'live-service' } } },
      { metadata: { name: '' }, spec: { ref: { name: 'ignored' } } },
    ]
    serviceItems = [
      { metadata: { name: 'live-service' } },
    ]
    const controller = new WarmPoolController({ namespace: 'gc-ns' })

    const deleted = await controller.gcOrphanedDomainMappings()

    expect(deleted).toBe(1)
    const deletedMappings = capture
      .filter((c) => c.method === 'deleteNamespacedCustomObject' && c.args[0].plural === 'domainmappings')
      .map((c) => c.args[0].name)
    expect(deletedMappings).toEqual(['preview--missing.dev.example.com'])
  })

  test('returns zero for empty mapping lists and swallowed list failures', async () => {
    const controller = new WarmPoolController({ namespace: 'gc-ns' })
    expect(await controller.gcOrphanedDomainMappings()).toBe(0)

    listError = new Error('domain list failed')
    expect(await controller.gcOrphanedDomainMappings()).toBe(0)
  })
})
