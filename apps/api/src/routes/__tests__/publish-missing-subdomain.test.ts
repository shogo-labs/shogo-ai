// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// POST /projects/:id/publish with no `subdomain` (SHO-559).
//
// The route parsed the body as `PublishProjectOptions` and passed it straight
// to `preparePublish`, which called `rawSubdomain.toLowerCase()`. A re-publish
// body that omits the name (`{}`, `{ accessLevel: "anyone" }`) therefore
// answered 500 — QA hit it on staging while testing SHO-551.
//
// These tests pin the single place that now resolves it: a re-publish inherits
// the saved subdomain, a first publish without one is a 400
// `subdomain_required`, and a non-string `subdomain` or a non-object body is a
// 400 `invalid_body`. Never a 500.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.PUBLISH_BUCKET = 'test-publish-bucket'
process.env.PUBLISH_DOMAIN = 'shogo.one'
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
/** Every status write the pipeline makes, in order — `building` included. */
const statusWrites: Array<{ status: string; error: string | null }> = []
/** Whether the workspace may publish to a name it does not already own. */
let planAllows = true

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
  customDomain: { findMany: async () => [] },
  publishedEnvironment: {
    findUnique: async () => null,
    create: async ({ data }: any) => ({ id: 'env-1', minReplicas: 0, maxReplicas: 1, size: 's', ...data }),
    update: async ({ data }: any) => ({ id: 'env-1', ...data }),
    updateMany: async () => ({ count: 1 }),
  },
  publishedDeployment: { create: async ({ data }: any) => ({ id: 'dep-1', ...data }) },
}

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: {},
  BillingInterval: {},
}))
mock.module('../../services/billing.service', () => ({
  // A downgraded workspace: re-publishing a name it already owns must still work.
  canPublishSubdomain: async () => planAllows,
  canEnableAlwaysOn: async () => ({ allowed: true, planAllows: true, allowance: 1, used: 0 }),
  getAlwaysOnAllowanceForWorkspace: async () => 1,
  countAlwaysOnUsed: async () => 0,
}))
mock.module('../../lib/knative-project-manager', () => ({
  getProjectPodUrl: async () => 'http://pod.local',
  mergePatchKnativeService: async () => {},
  getKnativeProjectManager: () => ({}),
}))
mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'tok',
}))
mock.module('../../lib/cloudflare-site-auth-kv', () => ({
  getSiteAuthKvConfig: () => null,
  setSitePassword: async () => true,
  clearSitePassword: async () => true,
  hashSitePassword: () => 'hash',
}))
mock.module('../../lib/cloudflare-custom-hostnames', () => ({
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
mock.module('../../lib/publish-storage', () => ({
  PUBLISH_BUCKET: 'test-publish-bucket',
  PUBLISH_DATA_BUCKET: null,
  publishS3Client: { send: async () => ({}) },
  deletePublishedStaticBundle: async () => {},
  deletePublishedDataArchive: async () => {},
}))
mock.module('../../lib/substrate/router', () => ({
  getPublishSubstrate: async () => ({
    kind: 'knative',
    publish: async () => ({ substrate: 'knative', serverBacked: false, url: 'https://pod.local' }),
    setPublishedAlwaysOn: async () => {},
    unpublish: async () => {},
  }),
}))
mock.module('../../lib/publish-substrate-config', () => ({
  shouldProvisionPublishedDatabase: () => false,
  missingProjectsDatabaseConfig: () => [],
}))
mock.module('../../services/published-environments.service', () => ({
  ensureProductionEnvironment: async (projectId: string, subdomain: string) => ({
    id: 'env-1',
    projectId,
    name: 'production',
    subdomain,
    minReplicas: 0,
    maxReplicas: 1,
    size: 's',
  }),
  // Staging mints its own subdomain from the production one — a staging deploy
  // never reads the caller's `subdomain` (SHO-308 §8).
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
mock.module('../../services/published-deployments.service', () => ({
  recordPublishedDeployment: async () => ({ id: 'dep-1' }),
  markPublishedDeploymentReady: async () => {},
  markPublishedDeploymentFailed: async () => {},
}))
mock.module('../../services/published-ops.service', () => ({
  resolvePublishedImageRef: () => 'img:test',
  setEnvironmentPublishStatus: async () => {},
}))
mock.module('../../services/publish-git.service', () => ({
  flushGitSync: async () => ({}),
  deletePublishPointer: async () => {},
}))
mock.module('../../services/checkpoint.service', () => ({
  recordCheckpointForCommit: async () => {},
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
  planAllows = true
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const { publishRoutes } = await import('../publish')
const app = publishRoutes()

/** POST a *raw* body, so a non-object payload is expressible. */
function postRaw(projectId: string, raw: string) {
  return app.request(`/projects/${projectId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  })
}

function postPublish(projectId: string, body: any = {}) {
  return postRaw(projectId, JSON.stringify(body))
}

/** Let the background pipeline run until `done()` (or fail the test). */
async function until(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (done()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('POST /publish without a subdomain', () => {
  it('re-publishes to the saved subdomain and keeps the plan gate out of it', async () => {
    seed('p1', 'foo')
    // The workspace can no longer publish to a *new* name; repeating the one it
    // already owns must not be stopped by the gate.
    planAllows = false

    const res = await postPublish('p1', {})
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      accepted: true,
      status: 'building',
      subdomain: 'foo',
      url: 'https://foo.shogo.one',
      environment: 'production',
    })

    await until(() => projects.get('p1')!.publishStatus === 'live', 'live')
    expect(projects.get('p1')!.publishedSubdomain).toBe('foo')
  })

  it('refuses a missing subdomain on a project that was never published, taking no claim', async () => {
    seed('p1')

    const res = await postPublish('p1', { accessLevel: 'anyone' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        code: 'subdomain_required',
        message: 'A subdomain is required for the first publish.',
      },
    })

    // Nothing ran: no `building` lease, no status row, no name held.
    expect(statusWrites).toHaveLength(0)
    expect(projects.get('p1')!.publishStatus).toBe('idle')
    expect(projects.get('p1')!.publishedSubdomain).toBeNull()
  })

  it('treats a blank subdomain on a never-published project the same way', async () => {
    seed('p1')

    const res = await postPublish('p1', { subdomain: '   ' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('subdomain_required')
    expect(statusWrites).toHaveLength(0)
    expect(projects.get('p1')!.publishStatus).toBe('idle')
  })

  it('rejects a non-string subdomain with 400 invalid_body instead of a 500', async () => {
    seed('p1', 'foo')

    for (const subdomain of [123, null, { name: 'foo' }, ['foo'], true]) {
      const res = await postPublish('p1', { subdomain })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'invalid_body', message: '`subdomain` must be a string' },
      })
    }
    expect(statusWrites).toHaveLength(0)
  })

  it('rejects a body that is not a JSON object with 400 invalid_body', async () => {
    seed('p1', 'foo')

    for (const raw of ['null', '[]', '"foo"', '7', 'true']) {
      const res = await postRaw('p1', raw)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('invalid_body')
    }
    expect(statusWrites).toHaveLength(0)
  })

  it('still lowercases a supplied subdomain and still refuses an invalid name', async () => {
    seed('p1')

    const ok = await postPublish('p1', { subdomain: 'Foo' })
    expect(ok.status).toBe(202)
    expect((await ok.json()).subdomain).toBe('foo')
    await until(() => projects.get('p1')!.publishStatus === 'live', 'live')

    seed('p2')
    const bad = await postPublish('p2', { subdomain: 'Not_Valid!' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('invalid_subdomain')
  })

  it("publishes staging with no subdomain, from the staging environment's own name", async () => {
    seed('p1', 'foo')

    const res = await postPublish('p1', { environment: 'staging' })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ environment: 'staging', subdomain: 'foo--staging' })
  })
})
