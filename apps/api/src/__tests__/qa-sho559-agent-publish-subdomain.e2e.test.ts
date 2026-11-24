// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * E2E (QA, SHO-559): the *agent* publish route accepts a body with no
 * `subdomain` and re-publishes the saved one.
 *
 * `POST /api/internal/projects/:id/publish` is the route the agent's `publish`
 * tool actually calls, and it was the other half of the bug: it carried its own
 * `subdomain_required` refusal and passed `body.subdomain ?? ''` on, so a
 * re-publish that omitted the name was refused there even after the shared
 * runner learned to fall back.
 *
 * The dev's unit test (`routes/__tests__/publish-missing-subdomain.test.ts`)
 * covers the session route and the internal route's *forwarding* with
 * `startPublish` mocked. This file mounts the real `internal.ts` app on top of
 * the real runner and real `preparePublish`, so the seam between them is
 * exercised end to end: auth → ability gate → forwarding → subdomain resolution
 * → claim → the background pipeline reaching `live`.
 *
 * Run: bun test apps/api/src/__tests__/qa-sho559-agent-publish-subdomain.e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.PUBLISH_BUCKET = 'test-publish-bucket'
process.env.PUBLISH_DOMAIN = 'shogo.one'
process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-qa-559'
delete process.env.SHOGO_LOCAL_MODE

type Project = {
  id: string
  workspaceId: string
  publishedSubdomain: string | null
  publishedAlwaysOn: boolean
  publishStatus: string
  publishError: string | null
  publishStatusAt: Date | null
  accessLevel: string
  sitePasswordHash: string | null
  siteTitle: string | null
  siteDescription: string | null
  publishedAt: Date | null
}

const projects = new Map<string, Project>()
/** Every status write the pipeline makes — `building` included. */
const statusWrites: Array<{ status: string; error: string | null }> = []

function seed(id: string, subdomain: string | null = null): Project {
  const row: Project = {
    id,
    workspaceId: 'ws_1',
    publishedSubdomain: subdomain,
    publishedAlwaysOn: false,
    publishStatus: 'idle',
    publishError: null,
    publishStatusAt: null,
    accessLevel: 'anyone',
    sitePasswordHash: null,
    siteTitle: null,
    siteDescription: null,
    publishedAt: null,
  }
  projects.set(id, row)
  return row
}

// A cluster ServiceAccount token, so `authenticate` answers `kind: 'sa'` and the
// per-project ability gate is not consulted — exactly how a runtime pod calls in.
mock.module('../lib/k8s-auth', () => ({
  validatePodToken: async (_t: string) => ({ serviceAccountName: 'runtime', namespace: 'default' }),
}))

const prismaApi = {
  project: {
    findUnique: async ({ where }: any) => {
      if (where.id) {
        const row = projects.get(where.id)
        return row ? { ...row } : null
      }
      if (where.publishedSubdomain) {
        for (const row of projects.values()) {
          if (row.publishedSubdomain === where.publishedSubdomain) return { id: row.id }
        }
      }
      return null
    },
    findFirst: async () => null,
    update: async ({ where, data }: any) => {
      if (typeof data?.publishStatus === 'string') {
        statusWrites.push({ status: data.publishStatus, error: data.publishError ?? null })
      }
      const row = projects.get(where.id)
      if (row) Object.assign(row, data)
      return row ? { ...row } : null
    },
    // The in-flight lease: one conditional statement, like the real updateMany.
    updateMany: async ({ where, data }: any) => {
      const row = projects.get(where.id)
      if (!row) return { count: 0 }
      const inFlight = ['building', 'uploading', 'configuring'].includes(row.publishStatus)
      const at = row.publishStatusAt instanceof Date ? row.publishStatusAt.getTime() : 0
      const stale = !at || Date.now() - at > 30 * 60_000
      if (inFlight && !stale) return { count: 0 }
      if (typeof data?.publishStatus === 'string') {
        statusWrites.push({ status: data.publishStatus, error: data.publishError ?? null })
      }
      Object.assign(row, data)
      return { count: 1 }
    },
  },
  customDomain: { findMany: async () => [], findUnique: async () => null },
  publishedEnvironment: {
    findUnique: async () => null,
    create: async ({ data }: any) => ({ id: 'env-1', minReplicas: 0, maxReplicas: 1, size: 's', ...data }),
    update: async ({ data }: any) => ({ id: 'env-1', ...data }),
    updateMany: async () => ({ count: 1 }),
  },
  publishedDeployment: { create: async ({ data }: any) => ({ id: 'dep-1', ...data }) },
  agentConfig: { findUnique: async () => null, update: async () => ({}), updateMany: async () => ({ count: 0 }) },
  projectCheckpoint: { findFirst: async () => null, create: async () => ({ id: 'cp' }) },
}

mock.module('../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: {},
  BillingInterval: {},
}))
mock.module('../services/billing.service', () => ({
  canPublishSubdomain: async () => true,
  canEnableAlwaysOn: async () => ({ allowed: true, planAllows: true, allowance: 1, used: 0 }),
  getAlwaysOnAllowanceForWorkspace: async () => 1,
  countAlwaysOnUsed: async () => 0,
}))
mock.module('../lib/knative-project-manager', () => ({
  getProjectPodUrl: async () => 'http://pod.local',
  mergePatchKnativeService: async () => {},
  getKnativeProjectManager: () => ({}),
}))
mock.module('../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'tok',
  resolveProjectWorkspaceId: async (id: string) => projects.get(id)?.workspaceId ?? null,
}))
mock.module('../lib/cloudflare-site-auth-kv', () => ({
  getSiteAuthKvConfig: () => null,
  setSitePassword: async () => true,
  clearSitePassword: async () => true,
  hashSitePassword: () => 'hash',
}))
mock.module('../lib/cloudflare-custom-hostnames', () => ({
  getCustomHostnamesConfig: () => null,
  _resetCustomHostnamesConfigForTest: () => {},
  createCustomHostname: async () => null,
  getCustomHostname: async () => null,
  retriggerCustomHostname: async () => null,
  findCustomHostnameByName: async () => null,
  deleteCustomHostname: async () => true,
  putHostnameMapping: async () => true,
  deleteHostnameMapping: async () => true,
}))
mock.module('../lib/publish-storage', () => ({
  PUBLISH_BUCKET: 'test-publish-bucket',
  PUBLISH_DATA_BUCKET: null,
  publishS3Client: { send: async () => ({}) },
  deletePublishedStaticBundle: async () => {},
  deletePublishedDataArchive: async () => {},
}))
mock.module('../lib/substrate/router', () => ({
  getPublishSubstrate: async () => ({
    kind: 'knative',
    publish: async () => ({ substrate: 'knative', serverBacked: false, url: 'https://pod.local' }),
    setPublishedAlwaysOn: async () => {},
    unpublish: async () => {},
  }),
}))
mock.module('../lib/publish-substrate-config', () => ({
  // The publish route asks for the whole decision (§G1): an environment already
  // on Postgres stays there. These tests keep everything on SQLite.
  resolvePublishDbProvider: () => ({ provider: 'sqlite', reason: 'off' }),
  missingProjectsDatabaseConfig: () => [],
}))
mock.module('../services/published-environments.service', () => ({
  ensureProductionEnvironment: async (projectId: string, subdomain: string) => ({
    id: 'env-1',
    projectId,
    name: 'production',
    subdomain,
    minReplicas: 0,
    maxReplicas: 1,
    size: 's',
  }),
  // A staging deploy mints its own name and never reads the caller's subdomain.
  createStagingEnvironment: async () => ({ ok: true }),
  getEnvironment: async (projectId: string, name: string) => {
    const host = projects.get(projectId)
    if (name !== 'staging' || !host?.publishedSubdomain) return null
    return {
      id: 'env-stg',
      projectId,
      name: 'staging',
      subdomain: `${host.publishedSubdomain}--staging`,
      minReplicas: 0,
      maxReplicas: 1,
      size: 's',
    }
  },
  scaleSettingsOf: () => ({ minReplicas: 0, maxReplicas: 1, size: 's' }),
}))
mock.module('../services/published-deployments.service', () => ({
  recordPublishedDeployment: async () => ({ id: 'dep-1' }),
  markPublishedDeploymentReady: async () => {},
  markPublishedDeploymentFailed: async () => {},
}))
mock.module('../services/published-ops.service', () => ({
  resolvePublishedImageRef: () => 'img:test',
  setEnvironmentPublishStatus: async () => {},
}))
mock.module('../services/publish-git.service', () => ({
  flushGitSync: async () => ({}),
  deletePublishPointer: async () => {},
}))
mock.module('../services/checkpoint.service', () => ({
  recordCheckpointForCommit: async () => {},
  // Imported by `internal-runtime-routes`, which `internal.ts` mounts; only the
  // publish route is exercised here.
  listCheckpoints: async () => [],
  getCheckpoint: async () => null,
  rollback: async () => ({ ok: false, code: 'not_available' }),
  getDiff: async () => null,
}))

const DIST_FILES = [{ path: 'index.html', content: Buffer.from('<html>ok</html>').toString('base64') }]

const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async (url: any) => {
    const path = new URL(String(url)).pathname
    if (path === '/agent/server-info') return Response.json({ serverBacked: false })
    if (path === '/agent/publish-build') return Response.json({ ok: true })
    if (path === '/agent/dist-files') return Response.json(DIST_FILES)
    return new Response('{}', { status: 200 })
  }) as any
  projects.clear()
  statusWrites.length = 0
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const app = (await import('../routes/internal')).default

const SA = { authorization: 'Bearer sa-token', 'content-type': 'application/json' }

function agentPublish(projectId: string, body: any = {}) {
  return app.request(`/projects/${projectId}/publish`, {
    method: 'POST',
    headers: SA,
    body: JSON.stringify(body),
  })
}

/** Let the background pipeline run until `done()` (or fail the test). */
async function until(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (done()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('agent publish route (internal) without a subdomain', () => {
  it('accepts a re-publish with no subdomain and takes the saved one live', async () => {
    seed('p1', 'foo')

    // The staging repro, at the route the agent tool actually calls.
    const res = await agentPublish('p1', { accessLevel: 'anyone' })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      ok: true,
      accepted: true,
      subdomain: 'foo',
      url: 'https://foo.shogo.one',
      environment: 'production',
    })

    await until(() => projects.get('p1')!.publishStatus === 'live', 'live')
    expect(projects.get('p1')!.publishedSubdomain).toBe('foo')
  })

  it('accepts an empty body on a published project too', async () => {
    seed('p1', 'foo')

    const res = await agentPublish('p1', {})
    expect(res.status).toBe(202)
    expect((await res.json()).subdomain).toBe('foo')
    await until(() => projects.get('p1')!.publishStatus === 'live', 'live')
  })

  it('refuses a first publish with no subdomain, writing no status and holding no name', async () => {
    seed('p1')

    const res = await agentPublish('p1', {})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { code: 'subdomain_required', message: 'A subdomain is required for the first publish.' },
    })
    expect(statusWrites).toHaveLength(0)
    expect(projects.get('p1')!.publishStatus).toBe('idle')
  })

  it('answers 400 invalid_body, never 500, for a non-string subdomain', async () => {
    seed('p1', 'foo')

    for (const subdomain of [123, null, { name: 'foo' }, ['foo']]) {
      const res = await agentPublish('p1', { subdomain })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'invalid_body', message: '`subdomain` must be a string' },
      })
    }
    expect(statusWrites).toHaveLength(0)
  })

  it('still publishes a first publish that names one, lowercased', async () => {
    seed('p1')

    const res = await agentPublish('p1', { subdomain: 'Foo' })
    expect(res.status).toBe(202)
    expect((await res.json()).subdomain).toBe('foo')
    await until(() => projects.get('p1')!.publishStatus === 'live', 'live')
  })

  it('publishes staging with no subdomain from the staging environment', async () => {
    seed('p1', 'foo')

    const res = await agentPublish('p1', { environment: 'staging' })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ environment: 'staging', subdomain: 'foo--staging' })
  })
})
