// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/services/instance.service.ts — workspace instance size
 * management. Mocks prisma + the knative-project-manager so no real
 * DB or cluster is hit.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// ─── prisma mock ───────────────────────────────────────────────────────────
// Mock @shogo/shared-runtime BEFORE any import that transitively reaches
// src/config/instance-sizes.ts (instance.service imports it).
mock.module('@shogo/shared-runtime', () => ({
  isMobileTechStack: (id: string | null | undefined) =>
    !!id && (id.startsWith('expo') || id === 'react-native'),
}))


const findUniqueWs = mock(async (_: any): Promise<any> => null)
const updateWs = mock(async (_: any): Promise<any> => ({}))
const findUniqueSub = mock(async (_: any): Promise<any> => null)
const upsertSub = mock(async (_: any): Promise<any> => ({}))
const deleteManySub = mock(async (_: any): Promise<any> => ({ count: 0 }))
const findUniqueProject = mock(async (_: any): Promise<any> => null)
const findManyProject = mock(async (_: any): Promise<any[]> => [])

// $transaction passes a tx client to the callback with the same surface.
const transactionMock = mock(async (cb: any) =>
  cb({
    workspace: { update: updateWs },
    instanceSubscription: { upsert: upsertSub, deleteMany: deleteManySub },
  })
)

mock.module('../lib/prisma', () => ({
  prisma: {
    workspace: { findUnique: findUniqueWs, update: updateWs },
    instanceSubscription: {
      findUnique: findUniqueSub,
      upsert: upsertSub,
      deleteMany: deleteManySub,
    },
    project: { findUnique: findUniqueProject, findMany: findManyProject },
    $transaction: transactionMock,
  },
  // Re-exported enums (the source imports these as values).
  InstanceSize: {} as any,
  SubscriptionStatus: {} as any,
  BillingInterval: {} as any,
}))

// ─── knative-project-manager mock (dynamic import in source) ──────────────

const patchProjectResources = mock(async (_id: string, _o: any) => {})
const getKnativeProjectManager = mock(() => ({ patchProjectResources }))
mock.module('../lib/knative-project-manager', () => ({
  getKnativeProjectManager,
}))

const {
  applyInstanceToRuntime,
  buildProjectResourceOverrides,
  downgradeToMicro,
  getInstanceForWorkspace,
  getInstanceSubscription,
  getProjectResourceOverrides,
  syncInstanceFromStripe,
} = await import('../services/instance.service')

const { INSTANCE_SIZES, getKubernetesResourceOverrides } = await import(
  '../config/instance-sizes'
)

// ─── lifecycle ─────────────────────────────────────────────────────────────

const ORIG_K8S_HOST = process.env.KUBERNETES_SERVICE_HOST

let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  findUniqueWs.mockReset()
  updateWs.mockReset()
  findUniqueSub.mockReset()
  upsertSub.mockReset()
  deleteManySub.mockReset()
  findUniqueProject.mockReset()
  findManyProject.mockReset()
  transactionMock.mockReset()
  transactionMock.mockImplementation(async (cb: any) =>
    cb({
      workspace: { update: updateWs },
      instanceSubscription: { upsert: upsertSub, deleteMany: deleteManySub },
    })
  )
  patchProjectResources.mockReset()
  getKnativeProjectManager.mockClear()
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  delete process.env.KUBERNETES_SERVICE_HOST
})

afterEach(() => {
  errorSpy.mockRestore()
  if (ORIG_K8S_HOST === undefined) delete process.env.KUBERNETES_SERVICE_HOST
  else process.env.KUBERNETES_SERVICE_HOST = ORIG_K8S_HOST
})

// ─── getInstanceForWorkspace ───────────────────────────────────────────────

describe('getInstanceForWorkspace', () => {
  test('returns null when workspace is not found', async () => {
    findUniqueWs.mockImplementation(async () => null)
    expect(await getInstanceForWorkspace('ws_missing')).toBeNull()
  })

  test('returns {size, spec, storage} when workspace + storageUsage exist', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'small',
      storageUsage: {
        totalBytes: BigInt(2 * 1024 * 1024 * 1024),
        projectCount: 5,
        lastCalculatedAt: new Date('2026-02-01T00:00:00Z'),
      },
    }))
    const result = await getInstanceForWorkspace('ws_1')
    expect(result).not.toBeNull()
    expect(result!.size).toBe('small')
    expect(result!.spec).toBe(INSTANCE_SIZES.small)
    expect(result!.storage).toEqual({
      totalBytes: 2 * 1024 * 1024 * 1024,
      projectCount: 5,
      limitBytes: INSTANCE_SIZES.small.storageLimitBytes,
      lastCalculatedAt: new Date('2026-02-01T00:00:00Z'),
    })
  })

  test('returns storage:null when storageUsage row is missing', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'micro',
      storageUsage: null,
    }))
    const result = await getInstanceForWorkspace('ws_2')
    expect(result!.size).toBe('micro')
    expect(result!.storage).toBeNull()
  })

  test('coerces BigInt totalBytes to Number for the storage payload', async () => {
    findUniqueWs.mockImplementation(async () => ({
      instanceSize: 'medium',
      storageUsage: {
        totalBytes: BigInt(12345678),
        projectCount: 1,
        lastCalculatedAt: new Date(),
      },
    }))
    const result = await getInstanceForWorkspace('ws_bi')
    expect(typeof result!.storage!.totalBytes).toBe('number')
    expect(result!.storage!.totalBytes).toBe(12345678)
  })

  test('queries by id and selects only instanceSize + storageUsage subfields', async () => {
    findUniqueWs.mockImplementation(async () => null)
    await getInstanceForWorkspace('ws_q')
    const args = findUniqueWs.mock.calls[0][0]
    expect(args.where).toEqual({ id: 'ws_q' })
    expect(args.select.instanceSize).toBe(true)
    expect(args.select.storageUsage.select).toEqual({
      totalBytes: true,
      projectCount: true,
      lastCalculatedAt: true,
    })
  })
})

// ─── getInstanceSubscription ───────────────────────────────────────────────

describe('getInstanceSubscription', () => {
  test('queries instanceSubscription by workspaceId', async () => {
    findUniqueSub.mockImplementation(async () => ({ id: 'sub_1', workspaceId: 'ws_1' }))
    const result = await getInstanceSubscription('ws_1')
    expect(findUniqueSub).toHaveBeenCalledWith({ where: { workspaceId: 'ws_1' } })
    expect(result).toEqual({ id: 'sub_1', workspaceId: 'ws_1' })
  })

  test('returns null when no subscription exists', async () => {
    findUniqueSub.mockImplementation(async () => null)
    expect(await getInstanceSubscription('ws_no_sub')).toBeNull()
  })
})

// ─── syncInstanceFromStripe ───────────────────────────────────────────────

describe('syncInstanceFromStripe', () => {
  test('runs upsert + workspace update inside a single transaction', async () => {
    const start = new Date('2026-01-01T00:00:00Z')
    const end = new Date('2026-02-01T00:00:00Z')

    await syncInstanceFromStripe(
      'ws_sync',
      'stripe_sub_1',
      'stripe_cust_1',
      'medium',
      'active' as any,
      'monthly' as any,
      start,
      end
    )

    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(upsertSub).toHaveBeenCalledTimes(1)
    expect(updateWs).toHaveBeenCalledTimes(1)

    const upsertArgs = upsertSub.mock.calls[0][0]
    expect(upsertArgs.where).toEqual({ workspaceId: 'ws_sync' })
    expect(upsertArgs.create).toMatchObject({
      workspaceId: 'ws_sync',
      stripeSubscriptionId: 'stripe_sub_1',
      stripeCustomerId: 'stripe_cust_1',
      instanceSize: 'medium',
      status: 'active',
      billingInterval: 'monthly',
      currentPeriodStart: start,
      currentPeriodEnd: end,
    })
    expect(upsertArgs.update).toMatchObject({
      stripeSubscriptionId: 'stripe_sub_1',
      stripeCustomerId: 'stripe_cust_1',
      instanceSize: 'medium',
    })

    const updateArgs = updateWs.mock.calls[0][0]
    expect(updateArgs.where).toEqual({ id: 'ws_sync' })
    expect(updateArgs.data).toEqual({ instanceSize: 'medium' })
  })

  test('propagates transaction errors to the caller', async () => {
    transactionMock.mockImplementation(async () => {
      throw new Error('tx failed')
    })
    await expect(
      syncInstanceFromStripe(
        'w',
        's',
        'c',
        'small',
        'active' as any,
        'monthly' as any,
        new Date(),
        new Date()
      )
    ).rejects.toThrow('tx failed')
  })
})

// ─── downgradeToMicro ──────────────────────────────────────────────────────

describe('downgradeToMicro', () => {
  test('updates workspace.instanceSize=micro AND deletes the subscription in one transaction', async () => {
    await downgradeToMicro('ws_dg')
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(updateWs).toHaveBeenCalledTimes(1)
    expect(deleteManySub).toHaveBeenCalledTimes(1)

    expect(updateWs.mock.calls[0][0]).toEqual({
      where: { id: 'ws_dg' },
      data: { instanceSize: 'micro' },
    })
    expect(deleteManySub.mock.calls[0][0]).toEqual({
      where: { workspaceId: 'ws_dg' },
    })
  })

  test('propagates errors from the transaction', async () => {
    transactionMock.mockImplementation(async () => {
      throw new Error('downgrade tx failed')
    })
    await expect(downgradeToMicro('w')).rejects.toThrow('downgrade tx failed')
  })
})

// ─── buildProjectResourceOverrides ─────────────────────────────────────────

describe('buildProjectResourceOverrides', () => {
  test('delegates to getKubernetesResourceOverrides(size)', () => {
    for (const size of ['micro', 'small', 'medium', 'large', 'xlarge'] as const) {
      const result = buildProjectResourceOverrides('ws_x', size)
      expect(result).toEqual(getKubernetesResourceOverrides(size))
    }
  })

  test('ignores the workspaceId argument (per docstring: shared nodes, no nodeSelector)', () => {
    const a = buildProjectResourceOverrides('ws_a', 'small')
    const b = buildProjectResourceOverrides('ws_b', 'small')
    expect(a).toEqual(b)
    // Result should NOT contain a nodeSelector or tolerations.
    expect((a as Record<string, unknown>).nodeSelector).toBeUndefined()
    expect((a as Record<string, unknown>).tolerations).toBeUndefined()
  })
})

// ─── getProjectResourceOverrides ───────────────────────────────────────────

describe('getProjectResourceOverrides', () => {
  test('returns null when project is not found', async () => {
    findUniqueProject.mockImplementation(async () => null)
    expect(await getProjectResourceOverrides('p_missing')).toBeNull()
  })

  test('returns null when project has no workspace relation', async () => {
    findUniqueProject.mockImplementation(async () => ({ workspace: null }))
    expect(await getProjectResourceOverrides('p_orphan')).toBeNull()
  })

  test('returns the K8s overrides for the workspace instance size', async () => {
    findUniqueProject.mockImplementation(async () => ({
      workspace: { id: 'ws_p', instanceSize: 'large' },
    }))
    const result = await getProjectResourceOverrides('p_1')
    expect(result).toEqual(getKubernetesResourceOverrides('large'))
  })

  test('queries with the correct select shape', async () => {
    findUniqueProject.mockImplementation(async () => null)
    await getProjectResourceOverrides('p_q')
    const args = findUniqueProject.mock.calls[0][0]
    expect(args.where).toEqual({ id: 'p_q' })
    expect(args.select.workspace.select).toEqual({ id: true, instanceSize: true })
  })
})

// ─── applyInstanceToRuntime ────────────────────────────────────────────────

describe('applyInstanceToRuntime', () => {
  test('returns silently when workspace is not found', async () => {
    findUniqueWs.mockImplementation(async () => null)
    await applyInstanceToRuntime('ws_missing')
    expect(findManyProject).not.toHaveBeenCalled()
    expect(getKnativeProjectManager).not.toHaveBeenCalled()
  })

  test('returns silently when workspace has no projects with a knativeServiceName', async () => {
    findUniqueWs.mockImplementation(async () => ({ instanceSize: 'small' }))
    findManyProject.mockImplementation(async () => [])
    await applyInstanceToRuntime('ws_no_projects')
    expect(getKnativeProjectManager).not.toHaveBeenCalled()
  })

  test('returns silently when KUBERNETES_SERVICE_HOST is unset (local dev)', async () => {
    findUniqueWs.mockImplementation(async () => ({ instanceSize: 'small' }))
    findManyProject.mockImplementation(async () => [
      { id: 'p_1', knativeServiceName: 'svc-p_1' },
    ])
    // KUBERNETES_SERVICE_HOST is unset by beforeEach.
    await applyInstanceToRuntime('ws_local')
    expect(getKnativeProjectManager).not.toHaveBeenCalled()
    expect(patchProjectResources).not.toHaveBeenCalled()
  })

  test('patches resources for every project with a knativeServiceName', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    findUniqueWs.mockImplementation(async () => ({ instanceSize: 'medium' }))
    findManyProject.mockImplementation(async () => [
      { id: 'p_1', knativeServiceName: 'svc-1' },
      { id: 'p_2', knativeServiceName: 'svc-2' },
      { id: 'p_3', knativeServiceName: 'svc-3' },
    ])
    await applyInstanceToRuntime('ws_patch')

    expect(patchProjectResources).toHaveBeenCalledTimes(3)
    const overrides = getKubernetesResourceOverrides('medium')
    for (let i = 0; i < 3; i++) {
      expect(patchProjectResources.mock.calls[i][0]).toBe(`p_${i + 1}`)
      expect(patchProjectResources.mock.calls[i][1]).toEqual(overrides)
    }
  })

  test('filters the project query to non-null knativeServiceName', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    findUniqueWs.mockImplementation(async () => ({ instanceSize: 'small' }))
    findManyProject.mockImplementation(async () => [])
    await applyInstanceToRuntime('ws_filter')
    const args = findManyProject.mock.calls[0][0]
    expect(args.where).toEqual({
      workspaceId: 'ws_filter',
      knativeServiceName: { not: null },
    })
  })

  test('continues patching other projects when one patch fails (and logs)', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    findUniqueWs.mockImplementation(async () => ({ instanceSize: 'small' }))
    findManyProject.mockImplementation(async () => [
      { id: 'p_fail', knativeServiceName: 'svc-fail' },
      { id: 'p_ok', knativeServiceName: 'svc-ok' },
    ])
    patchProjectResources.mockImplementation(async (id: string) => {
      if (id === 'p_fail') throw new Error('knative 503')
    })

    await applyInstanceToRuntime('ws_partial')
    expect(patchProjectResources).toHaveBeenCalledTimes(2)
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('Failed to patch resources for project p_fail')
    expect(logged).toContain('knative 503')
  })

  test('lazy-loads the knative-project-manager module (dynamic import)', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    findUniqueWs.mockImplementation(async () => ({ instanceSize: 'small' }))
    findManyProject.mockImplementation(async () => [
      { id: 'p_1', knativeServiceName: 'svc-1' },
    ])
    await applyInstanceToRuntime('ws_lazy')
    expect(getKnativeProjectManager).toHaveBeenCalledTimes(1)
  })
})
