// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the home-region write router decision logic.
 *
 *   bun test apps/api/src/middleware/__tests__/home-region-router.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// --- mocks -----------------------------------------------------------------
const workspaces: Record<string, { homeRegion: string | null } | null> = {
  ws_eu: { homeRegion: 'eu-frankfurt-1' },
  ws_us: { homeRegion: 'us-ashburn-1' },
  ws_legacy: { homeRegion: null },
  ws_india: { homeRegion: 'ap-mumbai-1' },
}

const users: Record<string, { homeRegion: string | null } | null> = {
  user_eu: { homeRegion: 'eu-frankfurt-1' },
  user_us: { homeRegion: 'us-ashburn-1' },
  user_legacy: { homeRegion: null },
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id in workspaces ? workspaces[id] : null,
    },
    user: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id in users ? users[id] : null,
    },
  },
}))

const PEERS: Record<string, { id: string; label: string; url: string }> = {
  'us-ashburn-1': { id: 'us-ashburn-1', label: 'US', url: 'https://us.studio.shogo.ai' },
  'ap-mumbai-1': { id: 'ap-mumbai-1', label: 'India', url: 'https://india.studio.shogo.ai' },
}

mock.module('../../lib/region', () => ({
  RAW_REGION_ID: 'eu-frankfurt-1',
  PRIMARY_REGION: 'us-ashburn-1',
  getPeer: (id: string) => PEERS[id],
}))

let resolved: string | null = null
let resolveThrows = false
mock.module('../../lib/resolve-workspace-id', () => ({
  resolveWorkspaceIdForRequest: async () => {
    if (resolveThrows) throw new Error('boom')
    return resolved
  },
}))

let resolvedUser: string | null = null
mock.module('../../lib/resolve-user-id', () => ({
  resolveUserHomeRegionUserId: async () => resolvedUser,
}))

const proxyCalls: Array<{ region: string }> = []
const PROXY_RESPONSE = new Response('proxied', { status: 299 })
mock.module('../../lib/region-peer-proxy', () => ({
  proxyToPeer: async (_c: any, region: string) => {
    proxyCalls.push({ region })
    return PROXY_RESPONSE
  },
  isProxiedRequest: (c: any) => c.req.header('x-shogo-home-region-proxy') === '1',
}))

const { homeRegionWriteProxy } = await import('../home-region-router')

// --- context double --------------------------------------------------------
function makeCtx(opts: { method?: string; path?: string; headers?: Record<string, string> }) {
  const headers = opts.headers ?? {}
  return {
    get: () => undefined,
    set: () => {},
    json: (body: unknown, status?: number) => ({ __json: body, status: status ?? 200 }),
    req: {
      method: opts.method ?? 'POST',
      url: `https://eu.studio.shogo.ai${opts.path ?? '/api/workspaces/ws_us'}`,
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as any
}

const NEXT_RESULT = Symbol('next')
function makeNext() {
  let called = false
  const next = async () => {
    called = true
    return NEXT_RESULT as any
  }
  return { next, wasCalled: () => called }
}

const SAVED_MODE = process.env.HOME_REGION_ROUTING

beforeEach(() => {
  resolved = null
  resolvedUser = null
  resolveThrows = false
  proxyCalls.length = 0
})
afterEach(() => {
  if (SAVED_MODE === undefined) delete process.env.HOME_REGION_ROUTING
  else process.env.HOME_REGION_ROUTING = SAVED_MODE
})

describe('homeRegionWriteProxy', () => {
  test('is a no-op when HOME_REGION_ROUTING is unset/off', async () => {
    delete process.env.HOME_REGION_ROUTING
    resolved = 'ws_us'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({}), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('does not proxy non-mutating methods', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_us'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ method: 'GET' }), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('does not re-proxy a request that already carries the loop-guard header', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_us'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(
      makeCtx({ headers: { 'x-shogo-home-region-proxy': '1' } }),
      next,
    )
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('skips auth/identity prefixes', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_us'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/auth/sign-up/email' }), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('handles locally when no workspace resolves', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = null
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/users/u1' }), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('handles locally when the workspace home is this region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_eu'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({}), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('shadow mode logs but does not proxy a non-home write', async () => {
    process.env.HOME_REGION_ROUTING = 'shadow'
    resolved = 'ws_us'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({}), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('enforce mode proxies a non-home write to the home region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_us'
    const { next, wasCalled } = makeNext()
    const res = await homeRegionWriteProxy(makeCtx({}), next)
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toEqual([{ region: 'us-ashburn-1' }])
    expect(res).toBe(PROXY_RESPONSE)
  })

  test('treats a null homeRegion as owned by the primary region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_legacy'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({}), next)
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toEqual([{ region: 'us-ashburn-1' }])
  })

  test('fails open (local) when no peer is configured for the home region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_india' // ap-mumbai-1 — present in PEERS, so use an unknown one instead
    workspaces.ws_unknown_home = { homeRegion: 'unknown-region-9' }
    resolved = 'ws_unknown_home'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({}), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('handles locally when the workspace does not exist', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_missing'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({}), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  // --- platform-global -----------------------------------------------------
  test('routes a platform-global (/api/admin) write to the primary region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = null
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/admin/model-definitions' }), next)
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toEqual([{ region: 'us-ashburn-1' }])
  })

  test('does not route /api/admin/regions (kept in SKIP_PREFIXES)', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = null
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/admin/regions/failover' }), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  // --- identity ------------------------------------------------------------
  test('proxies an identity write to the user home region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = null
    resolvedUser = 'user_us'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/users/user_us' }), next)
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toEqual([{ region: 'us-ashburn-1' }])
  })

  test('handles an identity write locally when the user home is this region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = null
    resolvedUser = 'user_eu'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/users/user_eu' }), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('treats a null user homeRegion as owned by the primary region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = null
    resolvedUser = 'user_legacy'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/notifications/n1' }), next)
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toEqual([{ region: 'us-ashburn-1' }])
  })

  test('workspace ownership wins over identity when both could resolve', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_india'
    resolvedUser = 'user_us'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/users/user_us' }), next)
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toEqual([{ region: 'ap-mumbai-1' }])
  })

  // --- fail-closed for money-sensitive writes ------------------------------
  test('fails closed (503) for a billing write when the home peer is unreachable', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    workspaces.ws_unknown_home = { homeRegion: 'unknown-region-9' }
    resolved = 'ws_unknown_home'
    const { next, wasCalled } = makeNext()
    const res = (await homeRegionWriteProxy(
      makeCtx({ path: '/api/billing/charge' }),
      next,
    )) as any
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toHaveLength(0)
    expect(res.status).toBe(503)
  })

  test('fails closed (503) on a redeem-license write when resolution errors', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolveThrows = true
    const { next, wasCalled } = makeNext()
    const res = (await homeRegionWriteProxy(
      makeCtx({ path: '/api/workspaces/ws_us/redeem-license' }),
      next,
    )) as any
    expect(wasCalled()).toBe(false)
    expect(res.status).toBe(503)
  })

  test('fails open (local) on resolution error for a non-money write', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolveThrows = true
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/projects/p1' }), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('shadow mode never fails closed even for money writes', async () => {
    process.env.HOME_REGION_ROUTING = 'shadow'
    workspaces.ws_unknown_home = { homeRegion: 'unknown-region-9' }
    resolved = 'ws_unknown_home'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(makeCtx({ path: '/api/billing/charge' }), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  // --- region-affine chat writes -------------------------------------------
  test('enforce mode proxies a chat write to the home region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_us'
    const { next, wasCalled } = makeNext()
    const res = await homeRegionWriteProxy(
      makeCtx({ method: 'POST', path: '/api/projects/p1/chat' }),
      next,
    )
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toEqual([{ region: 'us-ashburn-1' }])
    expect(res).toBe(PROXY_RESPONSE)
  })

  test('proxies a chat/stop write to the home region', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_us'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(
      makeCtx({ method: 'POST', path: '/api/projects/p1/chat/stop' }),
      next,
    )
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toEqual([{ region: 'us-ashburn-1' }])
  })

  test('fails closed (503) for a chat write when the home peer is unreachable', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    workspaces.ws_unknown_home = { homeRegion: 'unknown-region-9' }
    resolved = 'ws_unknown_home'
    const { next, wasCalled } = makeNext()
    const res = (await homeRegionWriteProxy(
      makeCtx({ method: 'POST', path: '/api/projects/p1/chat' }),
      next,
    )) as any
    expect(wasCalled()).toBe(false)
    expect(proxyCalls).toHaveLength(0)
    expect(res.status).toBe(503)
  })

  test('does NOT proxy a chat GET read (left to chat-region-pin)', async () => {
    process.env.HOME_REGION_ROUTING = 'enforce'
    resolved = 'ws_us'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(
      makeCtx({ method: 'GET', path: '/api/projects/p1/chat/s1/stream' }),
      next,
    )
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })

  test('shadow mode does not fail closed for a chat write with no peer', async () => {
    process.env.HOME_REGION_ROUTING = 'shadow'
    workspaces.ws_unknown_home = { homeRegion: 'unknown-region-9' }
    resolved = 'ws_unknown_home'
    const { next, wasCalled } = makeNext()
    await homeRegionWriteProxy(
      makeCtx({ method: 'POST', path: '/api/projects/p1/chat' }),
      next,
    )
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
  })
})
