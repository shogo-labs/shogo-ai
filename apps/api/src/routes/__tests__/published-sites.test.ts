// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Cloud half of desktop publishing (SHO-245): `POST /api/published-sites/:id`.
// Exercises the real route + real `publishProject` pipeline against an
// in-memory Project table and a fake S3/substrate, so what is asserted is the
// behaviour that matters: key auth, the Pro gate, subdomain uniqueness, host
// reuse on republish, and cross-workspace refusal.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.PUBLISH_BUCKET = 'test-publish-bucket'
delete process.env.SHOGO_LOCAL_MODE

type Row = {
  id: string
  workspaceId: string
  name: string
  hidden: boolean
  settings: unknown
  publishedSubdomain: string | null
  publishedAt: Date | null
  publishStatus: string
  publishError: string | null
  publishStatusAt: Date | null
  accessLevel: string
  sitePasswordHash: string | null
  siteTitle: string | null
  siteDescription: string | null
  publishedAlwaysOn: boolean
}

let rows: Record<string, Row> = {}
const createCalls: any[] = []
const updateCalls: Array<{ where: any; data: any }> = []

const prismaApi = {
  project: {
    findUnique: async ({ where }: any) => {
      if (where.id) return rows[where.id] ? { ...rows[where.id] } : null
      if (where.publishedSubdomain) {
        const found = Object.values(rows).find((r) => r.publishedSubdomain === where.publishedSubdomain)
        return found ? { ...found } : null
      }
      return null
    },
    findFirst: async () => null,
    create: async ({ data }: any) => {
      createCalls.push(data)
      const row: Row = {
        publishedSubdomain: null,
        publishedAt: null,
        publishStatus: 'idle',
        publishError: null,
        publishStatusAt: null,
        accessLevel: 'anyone',
        sitePasswordHash: null,
        siteTitle: null,
        siteDescription: null,
        publishedAlwaysOn: false,
        ...data,
      } as Row
      rows[row.id] = row
      return { ...row }
    },
    update: async ({ where, data }: any) => {
      updateCalls.push({ where, data })
      const row = rows[where.id]
      if (!row) throw new Error(`no project ${where.id}`)
      Object.assign(row, data)
      return { ...row }
    },
  },
}

let apiKeyResult: { workspaceId: string; userId: string } | null = { workspaceId: 'ws-a', userId: 'u1' }
let canPublish = true
const s3Puts: Array<{ key: string; size: number }> = []
const substratePublishes: Array<{ projectId: string; subdomain: string; serverBacked: boolean }> = []

mock.module('../../lib/prisma', () => ({ prisma: prismaApi, SubscriptionStatus: {}, BillingInterval: {} }))
mock.module('../../lib/api-key-request', () => ({
  resolveApiKeyForRequest: async () => apiKeyResult,
}))
mock.module('../../lib/publish-storage', () => ({
  PUBLISH_BUCKET: 'test-publish-bucket',
  PUBLISH_DATA_BUCKET: null,
  publishS3Client: {
    send: async (cmd: any) => {
      const input = cmd?.input ?? {}
      if (input.Key) s3Puts.push({ key: input.Key, size: input.Body?.length ?? 0 })
      return {}
    },
  },
  deletePublishedStaticBundle: async () => {},
  deletePublishedDataArchive: async () => {},
}))
mock.module('../../services/publish-git.service', () => ({
  flushGitSync: async () => {},
  deletePublishPointer: async () => {},
  syncProjectToGit: async () => {},
}))
// The activity feed is a side effect of publishing, not part of what this test
// is about — keep it from reaching the DB.
mock.module('../../services/conversation-activity', () => ({
  recordProjectPublished: async () => {},
}))
mock.module('../../lib/substrate/router', () => ({
  unpublishProjectEverywhere: async () => {},
  getPublishSubstrate: async () => ({
    publish: async (projectId: string, opts: any) => {
      substratePublishes.push({ projectId, subdomain: opts.subdomain, serverBacked: opts.serverBacked })
      return { substrate: 'knative', serverBacked: opts.serverBacked }
    },
    setPublishedAlwaysOn: async () => {},
  }),
}))
mock.module('../../lib/knative-project-manager', () => ({
  getProjectPodUrl: async () => 'http://pod.invalid',
  mergePatchKnativeService: async () => {},
  getKnativeProjectManager: () => ({}),
}))
mock.module('../../services/billing.service', () => ({
  canPublishSubdomain: async () => canPublish,
  canEnableAlwaysOn: async () => ({ allowed: true, planAllows: true, allowance: 1, used: 0 }),
  getAlwaysOnAllowanceForWorkspace: async () => 1,
  countAlwaysOnUsed: async () => 0,
}))

const { publishedSitesRoutes } = await import('../published-sites')
const { hostProjectIdFor } = await import('../../services/published-sites.service')

const app = publishedSitesRoutes()

const INDEX = { path: 'index.html', content: Buffer.from('<html>hi</html>').toString('base64') }
const ASSET = { path: 'assets/app.js', content: Buffer.from('console.log(1)').toString('base64') }

function post(path: string, body: any, key: string | null = 'shogo_sk_test') {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function patch(path: string, body: any, key: string | null = 'shogo_sk_test') {
  return app.request(path, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  rows = {}
  createCalls.length = 0
  updateCalls.length = 0
  s3Puts.length = 0
  substratePublishes.length = 0
  apiKeyResult = { workspaceId: 'ws-a', userId: 'u1' }
  canPublish = true
})

afterEach(() => {
  mock.restore()
})

describe('POST /published-sites/:sourceProjectId', () => {
  it('creates a hidden host project and uploads the bundle to the subdomain prefix', async () => {
    const res = await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX, ASSET] })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.url).toBe('https://my-app.shogo.one')
    expect(body.subdomain).toBe('my-app')

    const hostId = hostProjectIdFor('ws-a', 'desktop-1')
    expect(body.hostProjectId).toBe(hostId)
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0].id).toBe(hostId)
    expect(createCalls[0].hidden).toBe(true)
    expect(createCalls[0].workspaceId).toBe('ws-a')

    expect(s3Puts.map((p) => p.key).sort()).toEqual(['my-app/assets/app.js', 'my-app/index.html'])
    // Uploaded bundles are static by construction — never probed as server-backed.
    expect(substratePublishes).toEqual([{ projectId: hostId, subdomain: 'my-app', serverBacked: false }])

    expect(rows[hostId].publishedSubdomain).toBe('my-app')
    expect(rows[hostId].publishStatus).toBe('live')
  })

  it('401s with cloud_signin_required when the request carries no key', async () => {
    const res = await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX] }, null)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('cloud_signin_required')
    expect(createCalls).toHaveLength(0)
  })

  it('401s when the key does not resolve', async () => {
    apiKeyResult = null
    const res = await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX] })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('cloud_signin_required')
  })

  it('enforces the Pro gate for a first publish', async () => {
    canPublish = false
    const res = await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX] })
    expect(res.status).toBe(402)
    expect((await res.json()).error.code).toBe('plan_not_allowed')
    expect(s3Puts).toHaveLength(0)
  })

  it('reports subdomain_taken for a name another host project owns', async () => {
    rows['other-host'] = {
      id: 'other-host',
      workspaceId: 'ws-a',
      name: 'other',
      hidden: true,
      settings: JSON.stringify({ desktopSourceProjectId: 'desktop-2' }),
      publishedSubdomain: 'my-app',
      publishedAt: new Date(),
      publishStatus: 'live',
      publishError: null,
      publishStatusAt: null,
      accessLevel: 'anyone',
      sitePasswordHash: null,
      siteTitle: null,
      siteDescription: null,
      publishedAlwaysOn: false,
    }

    const res = await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX] })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('subdomain_taken')
    expect(s3Puts).toHaveLength(0)
  })

  it('reuses the same host project on republish, including with no subdomain given', async () => {
    const first = await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX] })
    expect(first.status).toBe(200)
    const hostId = hostProjectIdFor('ws-a', 'desktop-1')

    s3Puts.length = 0
    const second = await post('/published-sites/desktop-1', { files: [INDEX, ASSET] })
    expect(second.status).toBe(200)
    const body = await second.json()
    expect(body.subdomain).toBe('my-app')
    expect(body.hostProjectId).toBe(hostId)

    // No second host row; the bundle landed under the same live subdomain.
    expect(createCalls).toHaveLength(1)
    expect(s3Puts.map((p) => p.key).sort()).toEqual(['my-app/assets/app.js', 'my-app/index.html'])
  })

  it('refuses a bundle with no index.html', async () => {
    const res = await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [ASSET] })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('no_index_html')
  })

  it('refuses path traversal in an uploaded file name', async () => {
    const res = await post('/published-sites/desktop-1', {
      subdomain: 'my-app',
      files: [INDEX, { path: '../../etc/passwd', content: INDEX.content }],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_file_path')
    expect(s3Puts).toHaveLength(0)
  })

  it('needs a subdomain on the very first publish', async () => {
    const res = await post('/published-sites/desktop-1', { files: [INDEX] })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('subdomain_required')
  })

  it('cannot touch a host project that belongs to another workspace', async () => {
    // A host row exists for workspace B; workspace A's key must not adopt it.
    const hostId = hostProjectIdFor('ws-b', 'desktop-1')
    rows[hostId] = {
      id: hostId,
      workspaceId: 'ws-b',
      name: 'b host',
      hidden: true,
      settings: JSON.stringify({ desktopSourceProjectId: 'desktop-1' }),
      publishedSubdomain: null,
      publishedAt: null,
      publishStatus: 'idle',
      publishError: null,
      publishStatusAt: null,
      accessLevel: 'anyone',
      sitePasswordHash: null,
      siteTitle: null,
      siteDescription: null,
      publishedAlwaysOn: false,
    }

    // Workspace A derives its OWN host id, so it publishes into its own row and
    // never reads or writes workspace B's.
    const res = await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX] })
    expect(res.status).toBe(200)
    expect(rows[hostId].publishedSubdomain).toBeNull()
    expect(createCalls[0].workspaceId).toBe('ws-a')
  })
})

describe('PATCH /published-sites/:sourceProjectId', () => {
  it('changes the access level on the host row without a rebuild', async () => {
    await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX] })
    const hostId = hostProjectIdFor('ws-a', 'desktop-1')
    s3Puts.length = 0

    const res = await patch('/published-sites/desktop-1', { accessLevel: 'password', password: 'hunter2' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accessLevel).toBe('password')
    expect(body.hasPassword).toBe(true)
    expect(rows[hostId].accessLevel).toBe('password')
    expect(rows[hostId].sitePasswordHash).toMatch(/^[0-9a-f]{64}$/)
    expect(s3Puts).toHaveLength(0)
  })

  it('400s an unknown access level', async () => {
    await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX] })
    const res = await patch('/published-sites/desktop-1', { accessLevel: 'everyone' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_access_level')
  })
})

describe('POST /published-sites/:sourceProjectId/unpublish', () => {
  it('clears the host project', async () => {
    await post('/published-sites/desktop-1', { subdomain: 'my-app', files: [INDEX] })
    const hostId = hostProjectIdFor('ws-a', 'desktop-1')

    const res = await post('/published-sites/desktop-1/unpublish', {})
    expect(res.status).toBe(200)
    expect(rows[hostId].publishedSubdomain).toBeNull()
    expect(rows[hostId].publishStatus).toBe('idle')
  })
})
