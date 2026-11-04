// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

type EnvRow = {
  id: string
  projectId: string
  name: string
  subdomain: string
  minReplicas: number
  maxReplicas: number
  size: string
  dbProvider: string | null
  dbName: string | null
  currentDeploymentId: string | null
}

let envs: EnvRow[] = []
let planId = 'pro'

const prismaApi = {
  project: {
    findUnique: async ({ where }: any) => ({ workspaceId: 'ws-1', id: where.id }),
  },
  publishedEnvironment: {
    findMany: async ({ where }: any) => envs.filter((e) => e.projectId === where.projectId),
    findUnique: async ({ where }: any) => {
      if (where.projectId_name) {
        const { projectId, name } = where.projectId_name
        return envs.find((e) => e.projectId === projectId && e.name === name) ?? null
      }
      return envs.find((e) => e.id === where.id) ?? null
    },
    create: async ({ data }: any) => {
      const row: EnvRow = {
        id: `env_${envs.length + 1}`,
        minReplicas: 0,
        maxReplicas: 1,
        size: 's',
        dbProvider: null,
        dbName: null,
        currentDeploymentId: null,
        ...data,
      }
      envs.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = envs.find((e) => e.id === where.id)!
      Object.assign(row, data)
      return row
    },
    delete: async ({ where }: any) => {
      const idx = envs.findIndex((e) => e.id === where.id)
      const [removed] = envs.splice(idx, 1)
      return removed
    },
  },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaApi }))
mock.module('../billing.service', () => ({
  getEffectivePlanId: async () => planId,
}))

const {
  createStagingEnvironment,
  deleteEnvironmentRow,
  ensureProductionEnvironment,
  getProjectPublishedCaps,
  setEnvironmentScale,
} = await import('../published-environments.service')

beforeEach(() => {
  envs = []
  planId = 'pro'
})

describe('ensureProductionEnvironment', () => {
  it('creates the production row on first publish', async () => {
    const env = await ensureProductionEnvironment('p1', 'acme')
    expect(env.name).toBe('production')
    expect(env.subdomain).toBe('acme')
    expect(env.maxReplicas).toBe(1)
  })

  it('translates always-on into min-scale 1', async () => {
    const env = await ensureProductionEnvironment('p1', 'acme', { alwaysOn: true })
    expect(env.minReplicas).toBe(1)
  })

  it('is idempotent and re-points the subdomain on a rename', async () => {
    const a = await ensureProductionEnvironment('p1', 'acme')
    const b = await ensureProductionEnvironment('p1', 'acme-2')
    expect(b.id).toBe(a.id)
    expect(b.subdomain).toBe('acme-2')
    expect(envs).toHaveLength(1)
  })
})

describe('getProjectPublishedCaps', () => {
  it('reads the workspace plan', async () => {
    expect((await getProjectPublishedCaps('p1')).maxReplicas).toBe(5)
    planId = 'free'
    expect((await getProjectPublishedCaps('p1')).maxReplicas).toBe(1)
  })
})

describe('setEnvironmentScale', () => {
  beforeEach(async () => {
    await ensureProductionEnvironment('p1', 'acme')
  })

  it('applies a single-replica scale to an app that still runs local state', async () => {
    const res = await setEnvironmentScale('p1', 'production', { minReplicas: 1, maxReplicas: 1, size: 'm' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.settings).toEqual({ minReplicas: 1, maxReplicas: 1, size: 'm' })
      expect(res.value.environment.maxReplicas).toBe(1)
    }
  })

  it('applies a scale within the plan caps once the app has shared state', async () => {
    envs[0].dbProvider = 'postgres'
    envs[0].dbName = 'project_p1'
    envs[0].uploadsShared = true
    const res = await setEnvironmentScale('p1', 'production', { minReplicas: 1, maxReplicas: 4, size: 'm' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.settings).toEqual({ minReplicas: 1, maxReplicas: 4, size: 'm' })
      expect(res.value.environment.maxReplicas).toBe(4)
    }
  })

  it('refuses a second replica with local_state_in_use while the app is on pod-local SQLite', async () => {
    const res = await setEnvironmentScale('p1', 'production', { maxReplicas: 3 })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('local_state_in_use')
      expect(res.status).toBe(409)
      expect(res.message).toContain('SQLite')
      expect(envs[0].maxReplicas).toBe(1)
    }
  })

  it('still refuses local_state_in_use when only the database is shared', async () => {
    envs[0].dbProvider = 'postgres'
    envs[0].dbName = 'project_p1'
    // Uploads are the remaining per-pod state (§3 moves them to the bucket).
    envs[0].uploadsShared = false
    const res = await setEnvironmentScale('p1', 'production', { maxReplicas: 2 })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('local_state_in_use')
      expect(res.message).toContain('uploads')
    }
  })

  it('lifts the refusal for a Postgres-backed environment (SHO-308 §1)', async () => {
    envs[0].dbProvider = 'postgres'
    envs[0].dbName = 'project_p1'
    const res = await setEnvironmentScale('p1', 'production', { minReplicas: 1, maxReplicas: 3 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.environment.maxReplicas).toBe(3)
  })

  it('refuses a max above the plan cap with plan_limit', async () => {
    planId = 'pro' // cap 5
    const res = await setEnvironmentScale('p1', 'production', { maxReplicas: 20 })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('plan_limit')
      expect(res.status).toBe(402)
      expect(res.details?.cap).toBe(5)
    }
  })

  it('refuses a size the plan does not include', async () => {
    planId = 'free' // s only
    const res = await setEnvironmentScale('p1', 'production', { size: 'l' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('plan_limit')
  })

  it('rejects an invalid scale shape', async () => {
    const res = await setEnvironmentScale('p1', 'production', { minReplicas: 5, maxReplicas: 2 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('invalid_scale')
  })

  it('404s for an environment that does not exist', async () => {
    const res = await setEnvironmentScale('p1', 'staging', { maxReplicas: 2 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })
})

describe('createStagingEnvironment', () => {
  it('requires production to exist first', async () => {
    const res = await createStagingEnvironment('p1')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('not_published')
  })

  it('is gated to pro+ plans', async () => {
    await ensureProductionEnvironment('p1', 'acme')
    planId = 'free'
    const res = await createStagingEnvironment('p1')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('plan_limit')
  })

  it('creates a staging environment one label off the base subdomain', async () => {
    await ensureProductionEnvironment('p1', 'acme')
    const res = await createStagingEnvironment('p1')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.name).toBe('staging')
      expect(res.value.subdomain).toBe('acme--staging')
      expect(res.value.minReplicas).toBe(0)
    }
  })

  it('is idempotent', async () => {
    await ensureProductionEnvironment('p1', 'acme')
    const a = await createStagingEnvironment('p1')
    const b = await createStagingEnvironment('p1')
    expect(a.ok && b.ok && a.value.id === b.value.id).toBe(true)
  })
})

describe('deleteEnvironmentRow', () => {
  it('refuses to delete production', async () => {
    await ensureProductionEnvironment('p1', 'acme')
    const res = await deleteEnvironmentRow('p1', 'production')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('cannot_delete_production')
  })

  it('deletes staging and leaves production untouched', async () => {
    await ensureProductionEnvironment('p1', 'acme')
    await createStagingEnvironment('p1')
    const res = await deleteEnvironmentRow('p1', 'staging')
    expect(res.ok).toBe(true)
    expect(envs.map((e) => e.name)).toEqual(['production'])
  })
})
