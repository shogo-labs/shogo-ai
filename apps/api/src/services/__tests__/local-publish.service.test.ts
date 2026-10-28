// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Desktop publish service (SHO-245): build in the project's local runtime,
// upload to Shogo Cloud, mirror the result onto the local Project row.
//
// The local runtime and the cloud are both faked with an injected `fetch`, so
// these tests pin the CONTRACT (what we send, what we do with the answer) and
// never touch a pod, S3 or the network.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createHash } from 'node:crypto'

type ProjectRow = {
  id: string
  workspaceId: string
  publishedSubdomain: string | null
  publishedAt: Date | null
  publishStatus: string
  publishError: string | null
  publishStatusAt: Date | null
  accessLevel: string
  sitePasswordHash: string | null
  siteTitle: string | null
  siteDescription: string | null
}

let projects: Record<string, ProjectRow> = {}
const projectUpdates: Array<{ id: string; data: any }> = []
let localConfig: Record<string, string> = {}

const prismaApi = {
  project: {
    findUnique: async ({ where }: any) => {
      const row = projects[where.id]
      return row ? { ...row } : null
    },
    update: async ({ where, data }: any) => {
      projectUpdates.push({ id: where.id, data })
      const row = projects[where.id]
      if (!row) throw new Error('no project')
      Object.assign(row, data)
      return { ...row }
    },
  },
  localConfig: {
    findUnique: async ({ where }: any) => {
      const value = localConfig[where.key]
      return value === undefined ? null : { key: where.key, value }
    },
    upsert: async ({ where, update, create }: any) => {
      localConfig[where.key] = update?.value ?? create?.value
      return { key: where.key, value: localConfig[where.key] }
    },
  },
}

let cloudKey: string | null = 'shogo_sk_test'

mock.module('../../lib/prisma', () => ({ prisma: prismaApi, SubscriptionStatus: {}, BillingInterval: {} }))
mock.module('../../lib/federated-upstream', () => ({
  getUpstreamCredential: async () => cloudKey,
}))
mock.module('../../lib/cloud-urls', () => ({
  getShogoCloudUrl: () => 'https://cloud.test',
  SHOGO_CLOUD_URL_DEFAULT: 'https://cloud.test',
}))

const {
  localPublishProject,
  localPublishState,
  localRepublishProject,
  localUnpublishProject,
  readPublishHosts,
} = await import('../local-publish.service')

// ─── fake runtime + cloud ───────────────────────────────────────────────────

type Call = { url: string; method: string; body: any }

let calls: Call[] = []
let serverBacked = false
let buildOk = true
let buildBody: any = { ok: true }
let distFiles: Array<{ path: string; content: string }> = [
  { path: 'index.html', content: Buffer.from('<html>hi</html>').toString('base64') },
  { path: 'assets/app.js', content: Buffer.from('console.log(1)').toString('base64') },
]
let cloudResponse: { status: number; body: any } = {
  status: 200,
  body: {
    ok: true,
    url: 'https://my-app.shogo.one',
    subdomain: 'my-app',
    accessLevel: 'anyone',
    hasPassword: false,
    hostProjectId: 'host-1',
  },
}

function fakeFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input)
  const method = (init.method ?? 'GET').toUpperCase()
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
  calls.push({ url, method, body })

  if (url.includes('/agent/server-info')) {
    return Promise.resolve(
      new Response(JSON.stringify({ serverBacked }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  }
  if (url.includes('/agent/publish-build')) {
    return Promise.resolve(
      new Response(JSON.stringify(buildBody), {
        status: buildOk ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  if (url.includes('/agent/dist-files')) {
    return Promise.resolve(
      new Response(JSON.stringify(distFiles), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  }
  if (url.includes('/api/published-sites/')) {
    return Promise.resolve(
      new Response(JSON.stringify(cloudResponse.body), {
        status: cloudResponse.status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  return Promise.resolve(new Response('{}', { status: 200 }))
}

const deps = {
  resolveRuntimeUrl: async () => 'http://127.0.0.1:9999',
  runtimeToken: async () => 'runtime-token',
  cloudKey: async () => cloudKey,
  cloudUrl: () => 'https://cloud.test',
  fetch: fakeFetch as unknown as typeof fetch,
}

beforeEach(() => {
  projects = {
    p1: {
      id: 'p1',
      workspaceId: 'ws1',
      publishedSubdomain: null,
      publishedAt: null,
      publishStatus: 'idle',
      publishError: null,
      publishStatusAt: null,
      accessLevel: 'anyone',
      sitePasswordHash: null,
      siteTitle: null,
      siteDescription: null,
    },
  }
  projectUpdates.length = 0
  localConfig = {}
  calls = []
  cloudKey = 'shogo_sk_test'
  serverBacked = false
  buildOk = true
  buildBody = { ok: true }
  distFiles = [
    { path: 'index.html', content: Buffer.from('<html>hi</html>').toString('base64') },
    { path: 'assets/app.js', content: Buffer.from('console.log(1)').toString('base64') },
  ]
  cloudResponse = {
    status: 200,
    body: {
      ok: true,
      url: 'https://my-app.shogo.one',
      subdomain: 'my-app',
      accessLevel: 'anyone',
      hasPassword: false,
      hostProjectId: 'host-1',
    },
  }
})

afterEach(() => {
  mock.restore()
})

describe('localPublishProject', () => {
  it('builds locally, uploads to the cloud, and mirrors the live state onto the local row', async () => {
    const result = await localPublishProject('p1', { subdomain: 'my-app' }, deps)

    expect(result.ok).toBe(true)
    expect(result.url).toBe('https://my-app.shogo.one')
    expect(result.subdomain).toBe('my-app')

    // Build order: probe → build → dist → upload.
    const order = calls.map((c) => new URL(c.url).pathname)
    expect(order).toEqual([
      '/agent/server-info',
      '/agent/publish-build',
      '/agent/dist-files',
      '/api/published-sites/p1',
    ])

    const upload = calls.find((c) => c.url.endsWith('/api/published-sites/p1'))!
    expect(upload.method).toBe('POST')
    expect(upload.body.subdomain).toBe('my-app')
    expect(upload.body.files).toHaveLength(2)
    expect(upload.body.files[0].path).toBe('index.html')

    const row = projects.p1
    expect(row.publishedSubdomain).toBe('my-app')
    expect(row.publishStatus).toBe('live')
    expect(row.publishedAt).toBeInstanceOf(Date)

    // The cloud's host project id is remembered so the desktop can report it.
    expect(await readPublishHosts()).toEqual({ p1: 'host-1' })
  })

  it('refuses with cloud_signin_required (503) when no cloud key is connected', async () => {
    cloudKey = null
    const result = await localPublishProject('p1', { subdomain: 'my-app' }, deps)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.code).toBe('cloud_signin_required')
    expect(result.message).toMatch(/sign in/i)
    // Nothing was built — the key is checked before any expensive work.
    expect(calls.some((c) => c.url.includes('/agent/publish-build'))).toBe(false)
  })

  it('refuses a server-backed project instead of publishing a half-working site', async () => {
    serverBacked = true
    const result = await localPublishProject('p1', { subdomain: 'my-app' }, deps)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(result.code).toBe('server_backed_requires_cloud_project')
    expect(calls.some((c) => c.url.includes('/agent/publish-build'))).toBe(false)
    expect(projects.p1.publishedSubdomain).toBeNull()
  })

  it('reports a failed build without uploading anything', async () => {
    buildOk = false
    buildBody = { ok: false, error: 'vite exploded' }
    const result = await localPublishProject('p1', { subdomain: 'my-app' }, deps)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('build_failed')
    expect(result.message).toBe('vite exploded')
    expect(calls.some((c) => c.url.includes('/api/published-sites'))).toBe(false)
    expect(projects.p1.publishStatus).toBe('failed')
  })

  it('surfaces the cloud subdomain_taken code and leaves the local row unpublished', async () => {
    cloudResponse = { status: 409, body: { error: { code: 'subdomain_taken', message: 'Subdomain is already in use' } } }
    const result = await localPublishProject('p1', { subdomain: 'taken' }, deps)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(409)
    expect(result.code).toBe('subdomain_taken')
    expect(projects.p1.publishedSubdomain).toBeNull()
    expect(projects.p1.publishStatus).toBe('failed')
  })

  it('turns a 401 from the cloud into an actionable cloud_signin_required', async () => {
    cloudResponse = { status: 401, body: { error: { code: 'cloud_signin_required', message: 'Sign in to Shogo Cloud to publish.' } } }
    const result = await localPublishProject('p1', { subdomain: 'my-app' }, deps)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.code).toBe('cloud_signin_required')
  })

  it('surfaces the cloud plan_not_allowed gate unchanged', async () => {
    cloudResponse = { status: 402, body: { error: { code: 'plan_not_allowed', message: 'Pro required' } } }
    const result = await localPublishProject('p1', { subdomain: 'my-app' }, deps)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(402)
    expect(result.code).toBe('plan_not_allowed')
  })

  it('asks for a subdomain on a first publish with none given', async () => {
    const result = await localPublishProject('p1', {}, deps)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('subdomain_required')
    expect(calls).toHaveLength(0)
  })

  it('stores a password-gate hash so the panel reports hasPassword', async () => {
    cloudResponse.body = { ...cloudResponse.body, accessLevel: 'password', hasPassword: true }
    const result = await localPublishProject('p1', { subdomain: 'my-app', accessLevel: 'password', password: 'hunter2' }, deps)

    expect(result.ok).toBe(true)
    expect(result.hasPassword).toBe(true)
    expect(projects.p1.accessLevel).toBe('password')
    // sha256('my-app:hunter2') — the same salt the edge Worker uses.
    const expected = createHash('sha256').update('my-app:hunter2').digest('hex')
    expect(projects.p1.sitePasswordHash).toBe(expected)
  })
})

describe('localRepublishProject', () => {
  it('reuses the live subdomain when none is given', async () => {
    projects.p1.publishedSubdomain = 'my-app'
    const result = await localRepublishProject('p1', deps)

    expect(result.ok).toBe(true)
    const upload = calls.find((c) => c.url.includes('/api/published-sites'))!
    expect(upload.body.subdomain).toBe('my-app')
  })

  it('refuses when the project was never published', async () => {
    const result = await localRepublishProject('p1', deps)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('not_published')
  })
})

describe('localUnpublishProject', () => {
  it('clears the local row once the cloud has taken the site down', async () => {
    projects.p1.publishedSubdomain = 'my-app'
    projects.p1.publishStatus = 'live'
    localConfig.CLOUD_PUBLISH_HOSTS = JSON.stringify({ p1: 'host-1' })
    cloudResponse = { status: 200, body: { ok: true, success: true } }

    const result = await localUnpublishProject('p1', deps)

    expect(result.ok).toBe(true)
    const call = calls.find((c) => c.url.includes('/unpublish'))!
    expect(call.method).toBe('POST')
    expect(projects.p1.publishedSubdomain).toBeNull()
    expect(projects.p1.sitePasswordHash).toBeNull()
    expect(projects.p1.publishStatus).toBe('idle')
    expect(await readPublishHosts()).toEqual({})
  })

  it('still clears the local row when the cloud says not_published', async () => {
    projects.p1.publishedSubdomain = 'my-app'
    cloudResponse = { status: 400, body: { error: { code: 'not_published', message: 'Nothing published' } } }

    const result = await localUnpublishProject('p1', deps)
    expect(result.ok).toBe(true)
    expect(projects.p1.publishedSubdomain).toBeNull()
  })
})

describe('localPublishState', () => {
  it('reports the mirrored state plus whether a cloud key is connected', async () => {
    projects.p1.publishedSubdomain = 'my-app'
    projects.p1.publishStatus = 'live'
    localConfig.CLOUD_PUBLISH_HOSTS = JSON.stringify({ p1: 'host-1' })

    const state = await localPublishState('p1')
    expect(state.ok).toBe(true)
    if (!state.ok) throw new Error('unreachable')
    expect(state.subdomain).toBe('my-app')
    expect(state.publishStatus).toBe('live')
    expect(state.cloudConnected).toBe(true)
    expect(state.cloudHostProjectId).toBe('host-1')
  })

  it('404s for an unknown project', async () => {
    const state = await localPublishState('nope')
    expect(state.ok).toBe(false)
  })
})
