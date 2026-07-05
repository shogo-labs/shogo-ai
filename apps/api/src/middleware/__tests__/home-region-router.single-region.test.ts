// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression: the home-region write router must be inert in a single-region
 * deployment (REGION_ID set, but REGION_PEERS empty — e.g. staging).
 *
 * Before the fix, an affine chat write (POST /api/projects/:id/chat) for a
 * workspace whose homeRegion resolved to a non-local region (a legacy null row
 * defaults to PRIMARY_REGION 'us-ashburn-1', which is NOT the single-region
 * pod's own 'staging') found no peer and failed closed with a spurious
 * 503 {"error":"home region unavailable"}. With no peers there is nowhere to
 * proxy, so every write must resolve local.
 *
 *   bun test apps/api/src/middleware/__tests__/home-region-router.single-region.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// Single-region staging: this pod is 'staging' with NO peers.
mock.module('../../lib/region', () => ({
  RAW_REGION_ID: 'staging',
  PRIMARY_REGION: 'us-ashburn-1',
  REGION_PEERS: [],
  getPeer: () => undefined,
}))

// A legacy workspace whose homeRegion is null → resolveOwner would default it
// to PRIMARY_REGION ('us-ashburn-1'), which is not 'staging'.
mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async () => ({ homeRegion: null }),
    },
    user: {
      findUnique: async () => null,
    },
  },
}))

mock.module('../../lib/resolve-workspace-id', () => ({
  resolveWorkspaceIdForRequest: async () => 'ws_legacy',
}))
mock.module('../../lib/resolve-user-id', () => ({
  resolveUserHomeRegionUserId: async () => null,
}))

const proxyCalls: Array<{ region: string }> = []
mock.module('../../lib/region-peer-proxy', () => ({
  proxyToPeer: async (_c: any, region: string) => {
    proxyCalls.push({ region })
    return new Response('proxied', { status: 299 })
  },
  isProxiedRequest: (c: any) => c.req.header('x-shogo-home-region-proxy') === '1',
}))

const { homeRegionWriteProxy } = await import('../home-region-router')

function makeCtx(path: string) {
  return {
    get: () => undefined,
    set: () => {},
    json: (body: unknown, status?: number) => ({ __json: body, status: status ?? 200 }),
    req: {
      method: 'POST',
      url: `https://studio.staging.shogo.ai${path}`,
      header: () => undefined,
    },
  } as any
}

function makeNext() {
  let called = false
  const next = async () => {
    called = true
    return Symbol('next') as any
  }
  return { next, wasCalled: () => called }
}

const SAVED_MODE = process.env.HOME_REGION_ROUTING
beforeEach(() => {
  proxyCalls.length = 0
  process.env.HOME_REGION_ROUTING = 'enforce'
})
afterEach(() => {
  if (SAVED_MODE === undefined) delete process.env.HOME_REGION_ROUTING
  else process.env.HOME_REGION_ROUTING = SAVED_MODE
})

describe('homeRegionWriteProxy (single-region, no peers)', () => {
  test('handles a chat write locally instead of failing closed (503)', async () => {
    const { next, wasCalled } = makeNext()
    const res = await homeRegionWriteProxy(makeCtx('/api/projects/p1/chat'), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
    // Must NOT be the 503 { error: 'home region unavailable' } response.
    expect((res as any)?.status).not.toBe(503)
  })

  test('handles a money-sensitive write locally instead of failing closed', async () => {
    const { next, wasCalled } = makeNext()
    const res = await homeRegionWriteProxy(makeCtx('/api/billing/charge'), next)
    expect(wasCalled()).toBe(true)
    expect(proxyCalls).toHaveLength(0)
    expect((res as any)?.status).not.toBe(503)
  })
})
