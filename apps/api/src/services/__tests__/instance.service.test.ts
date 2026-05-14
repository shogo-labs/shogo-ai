// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

interface PrismaState {
  workspace: any | null
  workspaceUpdateCalls: Array<{ where: any; data: any }>
  instanceSub: any | null
  instanceSubUpsertCalls: Array<any>
  instanceSubDeleteCalls: Array<any>
  project: any | null
  projects: Array<{ id: string; knativeServiceName: string | null }>
}

const ps: PrismaState = {
  workspace: null,
  workspaceUpdateCalls: [],
  instanceSub: null,
  instanceSubUpsertCalls: [],
  instanceSubDeleteCalls: [],
  project: null,
  projects: [],
}

const fakeTx = {
  workspace: {
    update: async (args: any) => {
      ps.workspaceUpdateCalls.push(args)
      return { ...args.data, id: args.where.id }
    },
  },
  instanceSubscription: {
    upsert: async (args: any) => {
      ps.instanceSubUpsertCalls.push(args)
      return { ...args.create }
    },
    deleteMany: async (args: any) => {
      ps.instanceSubDeleteCalls.push(args)
      return { count: 1 }
    },
  },
}

mock.module('@shogo/shared-runtime', () => ({
  isMobileTechStack: (_id: any) => false,
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async (_args: any) => ps.workspace,
      update: async (args: any) => fakeTx.workspace.update(args),
    },
    instanceSubscription: {
      findUnique: async (_args: any) => ps.instanceSub,
    },
    project: {
      findUnique: async (_args: any) => ps.project,
      findMany: async (_args: any) => ps.projects,
    },
    $transaction: async (cb: (tx: any) => any) => cb(fakeTx),
  },
  InstanceSize: { micro: 'micro', small: 'small', medium: 'medium', large: 'large', xlarge: 'xlarge' },
  SubscriptionStatus: { active: 'active', canceled: 'canceled' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

let patchCalls: Array<{ projectId: string; overrides: any }> = []
let patchThrowFor: string | null = null

mock.module('../../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({
    patchProjectResources: async (projectId: string, overrides: any) => {
      if (patchThrowFor === projectId) throw new Error(`patch failed for ${projectId}`)
      patchCalls.push({ projectId, overrides })
    },
  }),
}))

const {
  applyInstanceToRuntime,
  buildProjectResourceOverrides,
  downgradeToMicro,
  getInstanceForWorkspace,
  getInstanceSubscription,
  getProjectResourceOverrides,
  syncInstanceFromStripe,
} = await import('../instance.service')

const origK8s = process.env.KUBERNETES_SERVICE_HOST
let errorSpy: any

beforeEach(() => {
  ps.workspace = null
  ps.workspaceUpdateCalls = []
  ps.instanceSub = null
  ps.instanceSubUpsertCalls = []
  ps.instanceSubDeleteCalls = []
  ps.project = null
  ps.projects = []
  patchCalls = []
  patchThrowFor = null
  errorSpy = mock(() => {})
  console.error = errorSpy as any
  delete process.env.KUBERNETES_SERVICE_HOST
})

afterEach(() => {
  if (origK8s === undefined) delete process.env.KUBERNETES_SERVICE_HOST
  else process.env.KUBERNETES_SERVICE_HOST = origK8s
})

describe('getInstanceForWorkspace', () => {
  it('returns null when workspace is missing', async () => {
    expect(await getInstanceForWorkspace('ws-1')).toBeNull()
  })

  it('returns size + spec + storage breakdown when usage exists', async () => {
    ps.workspace = {
      instanceSize: 'small',
      storageUsage: {
        totalBytes: BigInt(1_000_000),
        projectCount: 3,
        lastCalculatedAt: new Date('2026-01-01'),
      },
    }
    const out = await getInstanceForWorkspace('ws-1')
    expect(out!.size).toBe('small')
    expect(out!.spec.cpuCores).toBeGreaterThan(0)
    expect(out!.storage).toEqual({
      totalBytes: 1_000_000,
      projectCount: 3,
      limitBytes: out!.spec.storageLimitBytes,
      lastCalculatedAt: new Date('2026-01-01'),
    })
  })

  it('returns null storage when storageUsage is absent', async () => {
    ps.workspace = { instanceSize: 'micro', storageUsage: null }
    const out = await getInstanceForWorkspace('ws-1')
    expect(out!.storage).toBeNull()
  })
})

describe('getInstanceSubscription', () => {
  it('returns null when no subscription exists', async () => {
    expect(await getInstanceSubscription('ws-1')).toBeNull()
  })

  it('returns the subscription row', async () => {
    ps.instanceSub = { workspaceId: 'ws-1', status: 'active' }
    expect(await getInstanceSubscription('ws-1')).toEqual({
      workspaceId: 'ws-1',
      status: 'active',
    })
  })
})

describe('syncInstanceFromStripe', () => {
  it('upserts the subscription and updates the workspace in one $transaction', async () => {
    await syncInstanceFromStripe(
      'ws-1',
      'sub_123',
      'cus_123',
      'medium' as any,
      'active' as any,
      'monthly' as any,
      new Date('2026-01-01'),
      new Date('2026-02-01'),
    )
    expect(ps.instanceSubUpsertCalls).toHaveLength(1)
    const u = ps.instanceSubUpsertCalls[0]
    expect(u.where).toEqual({ workspaceId: 'ws-1' })
    expect(u.create.stripeSubscriptionId).toBe('sub_123')
    expect(u.create.instanceSize).toBe('medium')
    expect(u.create.status).toBe('active')
    expect(u.create.billingInterval).toBe('monthly')
    expect(u.update.stripeSubscriptionId).toBe('sub_123')

    expect(ps.workspaceUpdateCalls).toEqual([
      { where: { id: 'ws-1' }, data: { instanceSize: 'medium' } },
    ])
  })
})

describe('downgradeToMicro', () => {
  it('updates workspace to micro and deletes the subscription', async () => {
    await downgradeToMicro('ws-1')
    expect(ps.workspaceUpdateCalls).toEqual([
      { where: { id: 'ws-1' }, data: { instanceSize: 'micro' } },
    ])
    expect(ps.instanceSubDeleteCalls).toEqual([{ where: { workspaceId: 'ws-1' } }])
  })
})

describe('buildProjectResourceOverrides', () => {
  it('returns Kubernetes overrides for paid tier (minScale=1)', () => {
    const out = buildProjectResourceOverrides('ws-1', 'medium' as any)
    expect(out.requests).toBeTruthy()
    expect(out.limits).toBeTruthy()
    expect(out.minScale).toBe(1)
  })

  it('returns minScale=0 for micro (scale-to-zero)', () => {
    expect(buildProjectResourceOverrides('ws-1', 'micro' as any).minScale).toBe(0)
  })
})

describe('getProjectResourceOverrides', () => {
  it('returns null when project is not found', async () => {
    expect(await getProjectResourceOverrides('p-1')).toBeNull()
  })

  it('returns null when project has no workspace join', async () => {
    ps.project = { workspace: null }
    expect(await getProjectResourceOverrides('p-1')).toBeNull()
  })

  it('returns overrides for the workspace size', async () => {
    ps.project = { workspace: { id: 'ws-1', instanceSize: 'large' } }
    const out = await getProjectResourceOverrides('p-1')
    expect(out!.minScale).toBe(1)
    expect(out!.limits.cpu).toBeTruthy()
  })
})

describe('applyInstanceToRuntime', () => {
  it('no-op when workspace is not found', async () => {
    await applyInstanceToRuntime('ws-1')
    expect(patchCalls).toHaveLength(0)
  })

  it('no-op when there are no Knative-backed projects', async () => {
    ps.workspace = { instanceSize: 'small' }
    await applyInstanceToRuntime('ws-1')
    expect(patchCalls).toHaveLength(0)
  })

  it('no-op when KUBERNETES_SERVICE_HOST is unset (local dev safety)', async () => {
    ps.workspace = { instanceSize: 'small' }
    ps.projects = [{ id: 'p-1', knativeServiceName: 'svc-1' }]
    delete process.env.KUBERNETES_SERVICE_HOST
    await applyInstanceToRuntime('ws-1')
    expect(patchCalls).toHaveLength(0)
  })

  it('patches every project when K8s env is set', async () => {
    ps.workspace = { instanceSize: 'small' }
    ps.projects = [
      { id: 'p-1', knativeServiceName: 'svc-1' },
      { id: 'p-2', knativeServiceName: 'svc-2' },
    ]
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    await applyInstanceToRuntime('ws-1')
    expect(patchCalls.map((c) => c.projectId).sort()).toEqual(['p-1', 'p-2'])
    expect(patchCalls[0].overrides.minScale).toBe(1)
  })

  it('continues past per-project patch failures and logs each one', async () => {
    ps.workspace = { instanceSize: 'small' }
    ps.projects = [
      { id: 'p-1', knativeServiceName: 'svc-1' },
      { id: 'p-2', knativeServiceName: 'svc-2' },
    ]
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    patchThrowFor = 'p-1'
    await applyInstanceToRuntime('ws-1')
    expect(patchCalls.map((c) => c.projectId)).toEqual(['p-2'])
    const msg = (errorSpy.mock.calls.flat() ?? []).join(' ')
    expect(msg).toContain('Failed to patch')
    expect(msg).toContain('p-1')
  })
})
