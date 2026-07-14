// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { metalRoutes } from '../routes/metal'
import { _setMetalWarmPoolController, MetalWarmPoolController } from '../lib/metal-warm-pool-controller'

const app = metalRoutes()

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
  hostId: 'ash-1',
  meshIp: '10.8.0.2',
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
  load: { available: 1, assigned: 0, suspended: 0 },
}

describe('metalRoutes', () => {
  const orig = process.env.METAL_REGISTER_TOKEN
  beforeEach(() => {
    process.env.METAL_REGISTER_TOKEN = 'secret-tok'
    _setMetalWarmPoolController(new MetalWarmPoolController(async () => ({}), (async () => new Response()) as any))
  })
  afterEach(() => {
    if (orig === undefined) delete process.env.METAL_REGISTER_TOKEN
    else process.env.METAL_REGISTER_TOKEN = orig
    _setMetalWarmPoolController(null)
  })

  it('rejects register without a bearer token', async () => {
    const res = await req('/register', { method: 'POST', body: REG })
    expect(res.status).toBe(401)
  })

  it('rejects register with a wrong token', async () => {
    const res = await req('/register', { method: 'POST', body: REG, token: 'nope' })
    expect(res.status).toBe(401)
  })

  it('400s when required fields are missing', async () => {
    const res = await req('/register', { method: 'POST', body: { hostId: 'x' }, token: 'secret-tok' })
    expect(res.status).toBe(400)
  })

  it('registers a host and reflects it in status', async () => {
    const reg = await req('/register', { method: 'POST', body: REG, token: 'secret-tok' })
    expect(reg.status).toBe(200)
    // The heartbeat response also carries the pull-based-deploy `desired`
    // version pointer (null when the control plane can't resolve one in-test).
    const regBody = (await reg.json()) as any
    expect(regBody.ok).toBe(true)
    expect(regBody).toHaveProperty('desired')

    const status = await req('/status', { token: 'secret-tok' })
    expect(status.status).toBe(200)
    const body = (await status.json()) as any
    expect(body.ok).toBe(true)
    expect(body.hosts.total).toBe(1)
    expect(body.hosts.live).toBe(1)
    expect(body.hosts.detail[0].hostId).toBe('ash-1')
  })

  it('fails closed when no token is configured', async () => {
    delete process.env.METAL_REGISTER_TOKEN
    const res = await req('/register', { method: 'POST', body: REG, token: 'anything' })
    expect(res.status).toBe(401)
  })

  it('ingests the per-class liveness decomposition + fcProcs from the heartbeat', async () => {
    const body = {
      ...REG,
      load: { available: 2, assigned: 5, suspended: 3, fcProcs: 7, liveness: { appActive: 2, agentActive: 1, idleTail: 2 } },
    }
    const reg = await req('/register', { method: 'POST', body, token: 'secret-tok' })
    expect(reg.status).toBe(200)

    const status = await req('/status', { token: 'secret-tok' })
    const detail = ((await status.json()) as any).hosts.detail[0]
    expect(detail.load.fcProcs).toBe(7)
    expect(detail.load.liveness).toEqual({ appActive: 2, agentActive: 1, idleTail: 2 })
  })

  it('leaves liveness undefined for an older agent that omits it', async () => {
    const reg = await req('/register', { method: 'POST', body: REG, token: 'secret-tok' })
    expect(reg.status).toBe(200)
    const status = await req('/status', { token: 'secret-tok' })
    const detail = ((await status.json()) as any).hosts.detail[0]
    expect(detail.load.liveness).toBeUndefined()
  })
})
