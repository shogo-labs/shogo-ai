// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-308 §4/§5: the published-environment routes the Deployment tab and the
// agent's `publish ops_action` both call. The router carries no auth of its
// own (the app mounts it behind the session middleware), so it is mounted bare
// here against an in-memory table. What is asserted is the contract callers
// depend on: the JSON shape per route, and the status codes for a plan cap, a
// missing environment, and an illegal delete.

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

delete process.env.KUBERNETES_SERVICE_HOST
process.env.PUBLISH_DOMAIN = 'shogo.one'

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
  createdAt: Date
  updatedAt: Date
}

let envs: EnvRow[] = []
let planId = 'pro'
let deployments: any[] = []
let usageRows: any[] = []

const prismaApi = {
  project: {
    findUnique: async () => ({ id: 'p1', workspaceId: 'ws-1' }),
  },
  publishedEnvironment: {
    findMany: async ({ where }: any) =>
      envs.filter((e) => !where?.projectId || e.projectId === where.projectId),
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
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      }
      envs.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = envs.find((e) => e.id === where.id)
      if (!row) throw new Error('no env')
      Object.assign(row, data)
      return row
    },
    delete: async ({ where }: any) => {
      const idx = envs.findIndex((e) => e.id === where.id)
      const [removed] = envs.splice(idx, 1)
      return removed
    },
  },
  publishedDeployment: {
    findUnique: async ({ where }: any) => deployments.find((d) => d.id === where.id) ?? null,
    findFirst: async () => null,
    findMany: async () => deployments,
    create: async ({ data }: any) => {
      deployments.push(data)
      return data
    },
    updateMany: async () => ({ count: 0 }),
  },
  publishedUsageMinute: {
    findMany: async ({ where }: any) =>
      usageRows.filter((r) => r.environmentId === where.environmentId),
    updateMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
  },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaApi }))
mock.module('../../services/billing.service', () => ({
  getEffectivePlanId: async () => planId,
}))

const { publishRoutes } = await import('../publish')

function app() {
  const a = new Hono()
  a.route('/', publishRoutes())
  return a
}

const get = (path: string) => app().request(path)
const post = (path: string, body?: unknown) =>
  app().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

beforeEach(() => {
  envs = []
  deployments = []
  usageRows = []
  planId = 'pro'
  envs.push({
    id: 'env_prod',
    projectId: 'p1',
    name: 'production',
    subdomain: 'acme',
    minReplicas: 0,
    maxReplicas: 1,
    size: 's',
    dbProvider: 'postgres',
    dbName: 'project_p1',
    currentDeploymentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
})

describe('GET /projects/:id/published/environments', () => {
  it('returns each environment with its caps', async () => {
    const res = await get('/projects/p1/published/environments')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.environments).toHaveLength(1)
    expect(body.environments[0].environment.subdomain).toBe('acme')
    expect(body.environments[0].environment.url).toBe('https://acme.shogo.one')
    expect(body.caps).toBeDefined()
  })
})

describe('POST /projects/:id/published/environments', () => {
  it('refuses an unknown environment name', async () => {
    const res = await post('/projects/p1/published/environments', { name: 'qa' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_environment')
  })

  it('creates staging on a pro plan and reports its derived subdomain', async () => {
    const res = await post('/projects/p1/published/environments', { name: 'staging' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.environment.subdomain).toBe('acme--staging')
    expect(envs.map((e) => e.name).sort()).toEqual(['production', 'staging'])
  })

  it('refuses staging on the free plan with a plan_limit 402', async () => {
    planId = 'free'
    const res = await post('/projects/p1/published/environments', { name: 'staging' })
    expect(res.status).toBe(402)
    expect((await res.json()).error.code).toBe('plan_limit')
    expect(envs).toHaveLength(1)
  })
})

describe('DELETE /projects/:id/published/environments/:name', () => {
  it('refuses to delete production', async () => {
    const res = await app().request('/projects/p1/published/environments/production', {
      method: 'DELETE',
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.error.code).toBe('cannot_delete_production')
    expect(envs).toHaveLength(1)
  })

  it('deletes staging and leaves production alone', async () => {
    envs.push({ ...envs[0], id: 'env_stg', name: 'staging', subdomain: 'acme--staging' })
    const res = await app().request('/projects/p1/published/environments/staging', {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    expect(envs.map((e) => e.name)).toEqual(['production'])
  })
})

describe('GET /projects/:id/published/environments/:name/status', () => {
  it('returns the environment, replica counts and deployment slot', async () => {
    const res = await get('/projects/p1/published/environments/production/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.environment.name).toBe('production')
    expect(body.replicas).toEqual({ ready: 0, total: 0, desired: null })
    expect(body.pods).toEqual([])
    expect(body.currentDeployment).toBeNull()
  })

  it('404s for an environment the project does not have', async () => {
    const res = await get('/projects/p1/published/environments/staging/status')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('environment_not_found')
  })

  it('surfaces the current deployment when one is recorded', async () => {
    deployments.push({
      id: 'dep_1',
      environmentId: 'env_prod',
      commitSha: 'abc123',
      imageRef: 'ocir.io/ns/published/p1:abc123',
      imageDigest: 'sha256:dead',
      createdAt: new Date(),
      status: 'ready',
    })
    envs[0].currentDeploymentId = 'dep_1'
    const res = await get('/projects/p1/published/environments/production/status')
    const body = await res.json()
    expect(body.currentDeployment.commitSha).toBe('abc123')
    expect(body.currentDeployment.imageDigest).toBe('sha256:dead')
  })
})

describe('GET /projects/:id/published/environments/:name/metrics', () => {
  it('sums requests, errors and pod-seconds from the metered rows', async () => {
    usageRows = [
      { environmentId: 'env_prod', minute: new Date(), requests: 10, errors5xx: 1, podSeconds: 60, p95Ms: 120, egressBytes: 0n, dbStorageBytes: 0n, billedAt: null },
      { environmentId: 'env_prod', minute: new Date(), requests: 5, errors5xx: 0, podSeconds: 60, p95Ms: 80, egressBytes: 0n, dbStorageBytes: 0n, billedAt: null },
    ]
    const res = await get('/projects/p1/published/environments/production/metrics')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.requests).toBe(15)
    expect(body.errors5xx).toBe(1)
    expect(body.podSeconds).toBe(120)
    expect(body.p95Ms).toBe(120)
  })
})

describe('POST /projects/:id/published/environments/:name/scale', () => {
  it('applies a scale inside the plan cap', async () => {
    const res = await post('/projects/p1/published/environments/production/scale', {
      minReplicas: 1,
      maxReplicas: 4,
      size: 'm',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.settings).toEqual({ minReplicas: 1, maxReplicas: 4, size: 'm' })
    expect(envs[0].maxReplicas).toBe(4)
  })

  it('refuses a scale above the plan cap with plan_limit', async () => {
    const res = await post('/projects/p1/published/environments/production/scale', {
      maxReplicas: 50,
    })
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error.code).toBe('plan_limit')
    expect(envs[0].maxReplicas).toBe(1)
  })
})

describe('POST /projects/:id/published/promote', () => {
  it('refuses to promote when there is no staging environment', async () => {
    const res = await post('/projects/p1/published/promote')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await res.json()).error.code).toBeTruthy()
    expect(envs).toHaveLength(1)
  })
})
