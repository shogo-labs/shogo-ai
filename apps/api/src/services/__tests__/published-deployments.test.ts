// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Two defects QA caught on PR #1911 round 2, pinned so they cannot come back:
//
//  1. A deploy recorded TWO `PublishedDeployment` rows — one inside
//     `configurePublishedService` and one in `deployToStaging` — so every
//     staging publish wrote a duplicate and rollback's default target was that
//     superseded twin: a rollback that changed nothing.
//  2. The recorded `imageRef` and the image the ksvc actually ran came from
//     different resolvers (`PUBLISHED_RUNTIME_IMAGE` vs `RUNTIME_CONFIG.image()`),
//     so they drifted apart the moment that variable was set.
//
// The second is asserted against the one resolver; the first by rolling back
// over a table that contains a same-image twin.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

delete process.env.KUBERNETES_SERVICE_HOST
process.env.PUBLISHED_RUNTIME_IMAGE = 'ghcr.io/test/published:env'
process.env.RUNTIME_IMAGE = 'ghcr.io/test/published:default'

type Dep = { id: string; environmentId: string; commitSha: string; imageRef: string; imageDigest: string | null; schemaHash: string | null; status: string; createdAt: Date }

let envs: any[] = []
let deployments: Dep[] = []

const prismaApi = {
  project: { findUnique: async () => ({ id: 'p1', workspaceId: 'ws-1' }) },
  publishedEnvironment: {
    findMany: async ({ where }: any) => envs.filter((e) => e.projectId === where.projectId),
    findUnique: async ({ where }: any) => {
      if (where.projectId_name) {
        const { projectId, name } = where.projectId_name
        return envs.find((e) => e.projectId === projectId && e.name === name) ?? null
      }
      return envs.find((e) => e.id === where.id) ?? null
    },
    update: async ({ where, data }: any) => {
      const row = envs.find((e) => e.id === where.id)
      Object.assign(row, data)
      return row
    },
    create: async ({ data }: any) => {
      const row = { id: `env_${envs.length + 1}`, ...data }
      envs.push(row)
      return row
    },
  },
  publishedDeployment: {
    // Mirrors the where-clauses the service actually issues, including the
    // `imageRef: { not: ... }` filter rollback now relies on.
    findFirst: async ({ where, orderBy }: any) => {
      let rows = deployments.filter((d) => d.environmentId === where.environmentId)
      const notId = where.id?.not
      if (notId) rows = rows.filter((d) => d.id !== notId)
      const notImage = where.imageRef?.not
      if (notImage) rows = rows.filter((d) => d.imageRef !== notImage)
      if (orderBy?.createdAt === 'desc') rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      return rows[0] ?? null
    },
    findUnique: async ({ where }: any) => deployments.find((d) => d.id === where.id) ?? null,
    create: async ({ data }: any) => {
      const row: Dep = {
        id: `dep_${deployments.length + 1}`,
        imageDigest: null,
        schemaHash: null,
        status: 'ready',
        createdAt: new Date(Date.now() + deployments.length),
        ...data,
      }
      deployments.push(row)
      return row
    },
    updateMany: async () => ({ count: 0 }),
  },
  publishedUsageMinute: { findMany: async () => [] },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaApi }))
mock.module('../../services/billing.service', () => ({ getEffectivePlanId: async () => 'pro' }))

const { resolvePublishedImageRef, rollbackEnvironment } = await import('../published-ops.service')
const { resolvePublishedRuntimeImage } = await import('../../lib/published-image')

beforeEach(() => {
  deployments = []
  envs = [
    {
      id: 'env_prod',
      projectId: 'p1',
      name: 'production',
      subdomain: 'acme',
      minReplicas: 0,
      maxReplicas: 1,
      size: 's',
      dbProvider: null,
      dbName: null,
      currentDeploymentId: 'dep_2',
      publishStatus: 'live',
    },
  ]
  // dep_1 and dep_2 serve the SAME image (the old duplicate-row shape).
  deployments = [
    { id: 'dep_1', environmentId: 'env_prod', commitSha: 'aaa', imageRef: 'img:one', imageDigest: null, schemaHash: null, status: 'superseded', createdAt: new Date(Date.now() - 60_000) },
    { id: 'dep_2', environmentId: 'env_prod', commitSha: 'bbb', imageRef: 'img:one', imageDigest: null, schemaHash: null, status: 'ready', createdAt: new Date() },
  ]
})

describe('published image resolver', () => {
  it('uses PUBLISHED_RUNTIME_IMAGE so the record and the ksvc cannot drift', () => {
    expect(resolvePublishedRuntimeImage()).toBe('ghcr.io/test/published:env')
    expect(resolvePublishedImageRef()).toBe('ghcr.io/test/published:env')
  })

  it('prefers an explicit per-publish image (§2 per-commit builds)', () => {
    expect(resolvePublishedRuntimeImage('img:commit-abc')).toBe('img:commit-abc')
  })

  it('never returns an empty string', () => {
    expect(resolvePublishedRuntimeImage('')).not.toBe('')
    expect(resolvePublishedImageRef()).not.toBe('')
  })
})

describe('rollback picks a genuinely different image', () => {
  it('skips a superseded twin that serves the same image and finds the real earlier one', async () => {
    deployments.unshift({
      id: 'dep_0',
      environmentId: 'env_prod',
      commitSha: 'zzz',
      imageRef: 'img:zero',
      imageDigest: null,
      schemaHash: null,
      status: 'superseded',
      createdAt: new Date(Date.now() - 120_000),
    })

    const res = await rollbackEnvironment('p1', 'production')
    expect(res.ok).toBe(true)
    if (res.ok) {
      // Not dep_1 — that serves the image we are already on.
      expect(res.value.imageRef).toBe('img:zero')
    }
  })

  it('reports deployment_not_found when every earlier row serves the current image', async () => {
    const res = await rollbackEnvironment('p1', 'production')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('deployment_not_found')
  })
})
