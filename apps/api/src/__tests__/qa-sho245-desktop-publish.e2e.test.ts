// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-245 end-to-end: a DESKTOP project publishes through the cloud.
 *
 * Both real halves run here — the desktop route/service and the cloud route/
 * service — with only the two network legs faked: the project's local runtime
 * (build + dist files) and `fetch` to Shogo Cloud, which is dispatched straight
 * into the real cloud Hono app instead of over the wire.
 *
 * That makes this the contract test for the whole feature: the payload the
 * desktop uploads has to be one the cloud route actually accepts, and the state
 * the cloud reports has to be one the desktop can mirror onto its local row.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.PUBLISH_BUCKET = 'test-publish-bucket'
process.env.PUBLISH_DOMAIN = 'shogo.one'
delete process.env.SHOGO_LOCAL_MODE

// ─── one in-memory Project table for both halves ────────────────────────────
// The desktop's row and the cloud's hidden host row live here side by side,
// exactly as they do across the two databases in production.

type Row = Record<string, any>

let rows: Record<string, Row> = {}
let localConfig: Record<string, string> = {}
const created: Row[] = []
const s3Keys: string[] = []
const substratePublishes: Array<{ projectId: string; subdomain: string; serverBacked: boolean }> = []

const prismaApi = {
  project: {
    findUnique: async ({ where, select }: any) => {
      const row = where.id
        ? rows[where.id]
        : where.publishedSubdomain
          ? Object.values(rows).find((r) => r.publishedSubdomain === where.publishedSubdomain)
          : undefined
      if (!row) return null
      if (!select) return { ...row }
      const picked: Row = {}
      for (const key of Object.keys(select)) picked[key] = row[key] ?? null
      return picked
    },
    findFirst: async () => null,
    create: async ({ data }: any) => {
      created.push(data)
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
      }
      rows[row.id] = row
      return { ...row }
    },
    update: async ({ where, data }: any) => {
      const row = rows[where.id]
      if (!row) throw new Error(`no project ${where.id}`)
      Object.assign(row, data)
      return { ...row }
    },
  },
  localConfig: {
    findUnique: async ({ where }: any) =>
      localConfig[where.key] !== undefined ? { key: where.key, value: localConfig[where.key] } : null,
    upsert: async ({ where, update, create }: any) => {
      localConfig[where.key] = localConfig[where.key] === undefined ? create.value : update.value
      return { key: where.key, value: localConfig[where.key] }
    },
  },
}

const CLOUD_KEY = 'shogo_sk_desktop'

mock.module('../lib/prisma', () => ({ prisma: prismaApi, SubscriptionStatus: {}, BillingInterval: {} }))
mock.module('../lib/api-key-request', () => ({
  // The cloud resolves the key the desktop sent to that key's workspace.
  resolveApiKeyForRequest: async (_c: any, key: string) =>
    key === CLOUD_KEY ? { workspaceId: 'ws-a', userId: 'u1' } : null,
}))
mock.module('../lib/publish-storage', () => ({
  PUBLISH_BUCKET: 'test-publish-bucket',
  PUBLISH_DATA_BUCKET: null,
  publishS3Client: {
    send: async (cmd: any) => {
      const input = cmd?.input ?? {}
      if (input.Key) s3Keys.push(input.Key)
      return {}
    },
  },
  deletePublishedStaticBundle: async () => {},
  deletePublishedDataArchive: async () => {},
}))
mock.module('../lib/substrate/router', () => ({
  unpublishProjectEverywhere: async () => {},
  getPublishSubstrate: async () => ({
    publish: async (projectId: string, opts: any) => {
      substratePublishes.push({ projectId, subdomain: opts.subdomain, serverBacked: opts.serverBacked })
      return { substrate: 'knative', serverBacked: opts.serverBacked }
    },
    setPublishedAlwaysOn: async () => {},
  }),
}))
mock.module('../lib/knative-project-manager', () => ({
  getProjectPodUrl: async () => 'http://pod.invalid',
  mergePatchKnativeService: async () => {},
  getKnativeProjectManager: () => ({}),
}))
mock.module('../services/billing.service', () => ({
  canPublishSubdomain: async () => true,
  canEnableAlwaysOn: async () => ({ allowed: true, planAllows: true, allowance: 1, used: 0 }),
  getAlwaysOnAllowanceForWorkspace: async () => 1,
  countAlwaysOnUsed: async () => 0,
}))
mock.module('../services/publish-git.service', () => ({
  flushGitSync: async () => {},
  deletePublishPointer: async () => {},
  syncProjectToGit: async () => {},
}))
mock.module('../services/conversation-activity', () => ({
  recordProjectPublished: async () => {},
}))

// ─── the desktop's own wiring: cloud key, cloud URL, local runtime ──────────

const RUNTIME = 'http://runtime.local'
const CLOUD = 'https://cloud.test'

mock.module('../lib/federated-upstream', () => ({
  getUpstreamCredential: async () => CLOUD_KEY,
}))
mock.module('../lib/cloud-urls', () => ({
  getShogoCloudUrl: () => CLOUD,
}))
mock.module('../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: RUNTIME, source: 'test' }),
}))
mock.module('../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'runtime-token',
}))

const { localPublishRoutes } = await import('../routes/local-publish')
const { publishedSitesRoutes } = await import('../routes/published-sites')
const { hostProjectIdFor } = await import('../services/published-sites.service')
const { readPublishHosts } = await import('../services/local-publish.service')

// ─── the two faked network legs ─────────────────────────────────────────────

const FIXTURE = [
  { path: 'index.html', content: Buffer.from('<html><body>guides</body></html>').toString('base64') },
  { path: 'g.json', content: Buffer.from('{"ok":true}').toString('base64') },
  { path: 'g/abc/index.html', content: Buffer.from('<html>nested</html>').toString('base64') },
]

let serverBacked = false
const runtimeCalls: string[] = []
const realFetch = globalThis.fetch

/** Dispatch a desktop→cloud request into the real cloud app. */
async function cloudFetch(url: string, init: any = {}): Promise<Response> {
  const parsed = new URL(url)
  // The cloud mounts these routes under /api; the router itself is root-relative.
  const path = parsed.pathname.replace(/^\/api/, '')
  return publishedSitesRoutes().request(path + parsed.search, {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: init.body,
  })
}

const fakeFetch = (async (input: any, init: any = {}) => {
  const url = typeof input === 'string' ? input : input.url
  if (url.startsWith(RUNTIME)) {
    const path = new URL(url).pathname
    runtimeCalls.push(path)
    if (path === '/agent/server-info') return Response.json({ serverBacked })
    if (path === '/agent/publish-build') return Response.json({ ok: true })
    if (path === '/agent/dist-files') return Response.json(FIXTURE)
    return new Response('not found', { status: 404 })
  }
  if (url.startsWith(CLOUD)) return cloudFetch(url, init)
  throw new Error(`unexpected fetch: ${url}`)
}) as unknown as typeof fetch

const DESKTOP_PROJECT = 'desktop-guides'

function seedDesktopProject(id = DESKTOP_PROJECT) {
  rows[id] = {
    id,
    workspaceId: 'ws-local',
    name: 'Shogo Guides',
    hidden: false,
    settings: null,
    publishedSubdomain: null,
    publishedAt: null,
    publishStatus: 'idle',
    publishError: null,
    publishStatusAt: null,
    accessLevel: 'anyone',
    sitePasswordHash: null,
    siteTitle: null,
    siteDescription: null,
  }
}

function request(path: string, init: RequestInit = {}) {
  return localPublishRoutes().request(path, init)
}

function post(path: string, body: any = {}) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  rows = {}
  localConfig = {}
  created.length = 0
  s3Keys.length = 0
  substratePublishes.length = 0
  runtimeCalls.length = 0
  serverBacked = false
  seedDesktopProject()
  globalThis.fetch = fakeFetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  mock.restore()
})

describe('SHO-245 desktop → cloud publish, end to end', () => {
  it('builds locally, uploads to the cloud route, and mirrors the live state locally', async () => {
    const res = await post(`/projects/${DESKTOP_PROJECT}/publish`, { subdomain: 'shogo-guides' })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.subdomain).toBe('shogo-guides')
    expect(body.url).toBe('https://shogo-guides.shogo.one')
    expect(body.accessLevel).toBe('anyone')

    // The desktop really built through its own runtime, in order.
    expect(runtimeCalls).toEqual(['/agent/server-info', '/agent/publish-build', '/agent/dist-files'])

    // The cloud hosted the bundle it was handed, under the subdomain prefix.
    const hostId = hostProjectIdFor('ws-a', DESKTOP_PROJECT)
    expect(s3Keys.sort()).toEqual([
      'shogo-guides/g.json',
      'shogo-guides/g/abc/index.html',
      'shogo-guides/index.html',
    ])
    expect(substratePublishes).toEqual([{ projectId: hostId, subdomain: 'shogo-guides', serverBacked: false }])
    expect(rows[hostId].publishedSubdomain).toBe('shogo-guides')
    expect(rows[hostId].hidden).toBe(true)

    // …and the desktop's own row reports it, so the panel and GET agree.
    expect(rows[DESKTOP_PROJECT].publishedSubdomain).toBe('shogo-guides')
    expect(rows[DESKTOP_PROJECT].publishStatus).toBe('live')
    expect(rows[DESKTOP_PROJECT].publishedAt).toBeInstanceOf(Date)

    // The local → cloud host mapping the panel reports is recorded.
    expect(await readPublishHosts()).toEqual({ [DESKTOP_PROJECT]: hostId })

    const state = await request(`/projects/${DESKTOP_PROJECT}/publish`)
    const stateBody = await state.json()
    expect(stateBody.published).toBe(true)
    expect(stateBody.subdomain).toBe('shogo-guides')
    expect(stateBody.cloudConnected).toBe(true)
    expect(stateBody.cloudHostProjectId).toBe(hostId)
  })

  it('republishes onto the same live subdomain and host row', async () => {
    await post(`/projects/${DESKTOP_PROJECT}/publish`, { subdomain: 'shogo-guides' })
    const hostId = hostProjectIdFor('ws-a', DESKTOP_PROJECT)
    created.length = 0
    s3Keys.length = 0

    const res = await post(`/projects/${DESKTOP_PROJECT}/publish`, {})
    expect(res.status).toBe(200)
    expect((await res.json()).subdomain).toBe('shogo-guides')

    // No second host row, and the bundle landed under the same subdomain.
    expect(created).toHaveLength(0)
    expect(s3Keys).toHaveLength(3)
    expect(s3Keys.every((k) => k.startsWith('shogo-guides/'))).toBe(true)
    expect(rows[hostId].publishedSubdomain).toBe('shogo-guides')
  })

  it('unpublish clears the cloud host row and the local row', async () => {
    await post(`/projects/${DESKTOP_PROJECT}/publish`, { subdomain: 'shogo-guides' })
    const hostId = hostProjectIdFor('ws-a', DESKTOP_PROJECT)

    const res = await post(`/projects/${DESKTOP_PROJECT}/unpublish`)
    expect(res.status).toBe(200)

    expect(rows[hostId].publishedSubdomain).toBeNull()
    expect(rows[hostId].publishStatus).toBe('idle')
    expect(rows[DESKTOP_PROJECT].publishedSubdomain).toBeNull()
    expect(await readPublishHosts()).toEqual({})
  })

  it('a taken subdomain comes back to the desktop as subdomain_taken', async () => {
    await post(`/projects/${DESKTOP_PROJECT}/publish`, { subdomain: 'shogo-guides' })
    seedDesktopProject('desktop-two')

    const res = await post('/projects/desktop-two/publish', { subdomain: 'shogo-guides' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('subdomain_taken')
    // The refused project keeps a clean local row.
    expect(rows['desktop-two'].publishedSubdomain).toBeNull()
  })

  it('a server-backed project is refused before anything is uploaded', async () => {
    serverBacked = true

    const res = await post(`/projects/${DESKTOP_PROJECT}/publish`, { subdomain: 'shogo-guides' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('server_backed_requires_cloud_project')

    expect(runtimeCalls).toEqual(['/agent/server-info'])
    expect(s3Keys).toHaveLength(0)
    expect(created).toHaveLength(0)
  })
})
