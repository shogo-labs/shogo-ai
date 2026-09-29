// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The two routes the rootfs release gate depends on: /release must carry the
 * pinned runtime image through to the heartbeat's desired release (or hosts
 * bake the moving `-latest` tag), and /fleet must report the revision each
 * host's image actually holds.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const settings = new Map<string, string>()
mock.module('../lib/prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: async ({ where }: any) => (settings.has(where.key) ? { value: settings.get(where.key) } : null),
      upsert: async ({ where, create }: any) => {
        settings.set(where.key, create.value)
        return { key: where.key, value: create.value }
      },
    },
  },
}))

const { metalRoutes } = await import('../routes/metal')
const { invalidateReleaseCache } = await import('../lib/metal-agent-release')
const { _setMetalWarmPoolController, MetalWarmPoolController } = await import('../lib/metal-warm-pool-controller')

const app = metalRoutes()
const TOKEN = 'secret-tok'
const SHA = '50be85788b10561c7052f2eaef7a7f88f0633a3a'
const IMAGE = `us-ashburn-1.ocir.io/ns/shogo/shogo-runtime:production-multiarch-${SHA}`

function req(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  return app.request(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

const REG = {
  hostId: 'dal-1',
  meshIp: '10.8.0.2',
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
  load: { available: 1, assigned: 0, suspended: 0 },
}

const release = (over: Record<string, unknown> = {}) => ({
  region: 'us',
  channel: 'stable',
  release: { version: 'v9', bundleUrl: 's3://b/agent-v9.tgz', sha256: 'aa', ...over },
})

describe('metal /release and /fleet', () => {
  const orig = process.env.METAL_REGISTER_TOKEN
  beforeEach(() => {
    process.env.METAL_REGISTER_TOKEN = TOKEN
    settings.clear()
    invalidateReleaseCache()
    _setMetalWarmPoolController(new MetalWarmPoolController(async () => ({}), (async () => new Response()) as any))
  })
  afterEach(() => {
    if (orig === undefined) delete process.env.METAL_REGISTER_TOKEN
    else process.env.METAL_REGISTER_TOKEN = orig
    _setMetalWarmPoolController(null)
  })

  it('passes the pinned runtime image and revision through to the heartbeat', async () => {
    const pub = await req('/release', {
      method: 'POST',
      token: TOKEN,
      body: release({ rebuildRootfs: true, runtimeImage: IMAGE, runtimeRevision: SHA.toUpperCase() }),
    })
    expect(pub.status).toBe(200)

    const hb = await req('/register', { method: 'POST', token: TOKEN, body: REG })
    const { desired } = (await hb.json()) as any
    expect(desired).toMatchObject({ version: 'v9', rebuildRootfs: true, runtimeImage: IMAGE, runtimeRevision: SHA })
  })

  it('drops the pin on a release that does not rebuild', async () => {
    await req('/release', { method: 'POST', token: TOKEN, body: release({ runtimeImage: IMAGE, runtimeRevision: SHA }) })
    const { desired } = (await (await req('/register', { method: 'POST', token: TOKEN, body: REG })).json()) as any
    expect(desired.version).toBe('v9')
    expect(desired.runtimeImage).toBeUndefined()
    expect(desired.runtimeRevision).toBeUndefined()
  })

  it('rejects a revision that is not a commit sha', async () => {
    const res = await req('/release', {
      method: 'POST',
      token: TOKEN,
      body: release({ rebuildRootfs: true, runtimeImage: IMAGE, runtimeRevision: 'latest' }),
    })
    expect(res.status).toBe(400)
  })

  it('/fleet requires the bearer token', async () => {
    expect((await req('/fleet')).status).toBe(401)
    expect((await req('/fleet', { token: 'nope' })).status).toBe(401)
  })

  it('/fleet reports each live host with the revision its rootfs holds', async () => {
    await req('/register', { method: 'POST', token: TOKEN, body: { ...REG, rootfsSha: 'v2.0.18', rootfsRevision: SHA } })
    await req('/register', { method: 'POST', token: TOKEN, body: { ...REG, hostId: 'dal-2', meshIp: '10.8.0.3' } })

    const res = await req('/fleet', { token: TOKEN })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    const byId = Object.fromEntries(body.hosts.map((h: any) => [h.hostId, h]))
    expect(byId['dal-1']).toMatchObject({ region: 'us', rootfsSha: 'v2.0.18', rootfsRevision: SHA, live: true })
    expect(byId['dal-2'].rootfsRevision).toBeUndefined()
  })
})
