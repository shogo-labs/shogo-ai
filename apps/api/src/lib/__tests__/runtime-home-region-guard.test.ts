// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 *   bun test apps/api/src/lib/__tests__/runtime-home-region-guard.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  assertRuntimeInHomeRegion,
  RuntimeNotInHomeRegionError,
  isNotInHomeRegion,
  runtimeNotInHomeRegionResponse,
  runtimeNotInHomeRegionUpgradeResponse,
  runtimeOriginFor,
} from '../runtime-home-region-guard'

const homes: Record<string, string | null> = {
  ws_us: 'us-ashburn-1',
  ws_eu: 'eu-frankfurt-1',
  ws_legacy: null,
  ws_foreign: 'ap-tokyo-1',
}

const lookups: string[] = []
const lookupHomeRegion = async (id: string) => {
  lookups.push(id)
  return homes[id] ?? null
}

const EU = { region: 'eu-frankfurt-1', peerIds: ['us-ashburn-1'], lookupHomeRegion }

const SAVED = process.env.RUNTIME_HOME_REGION_GUARD
afterEach(() => {
  lookups.length = 0
  if (SAVED === undefined) delete process.env.RUNTIME_HOME_REGION_GUARD
  else process.env.RUNTIME_HOME_REGION_GUARD = SAVED
})

describe('assertRuntimeInHomeRegion', () => {
  test('refuses to start a runtime whose workspace is homed in a peer region', async () => {
    const err = await assertRuntimeInHomeRegion('ws_us', EU).catch((e) => e)
    expect(err).toBeInstanceOf(RuntimeNotInHomeRegionError)
    expect(err).toMatchObject({
      code: 'runtime_not_in_home_region',
      workspaceId: 'ws_us',
      homeRegion: 'us-ashburn-1',
      region: 'eu-frankfurt-1',
    })
  })

  test('allows the home region', async () => {
    await expect(assertRuntimeInHomeRegion('ws_eu', EU)).resolves.toBeUndefined()
  })

  test('allows legacy null-homeRegion workspaces (the request pin serves them locally too)', async () => {
    await expect(assertRuntimeInHomeRegion('ws_legacy', EU)).resolves.toBeUndefined()
  })

  test('allows a home region that is not a configured peer (nowhere to defer to)', async () => {
    await expect(assertRuntimeInHomeRegion('ws_foreign', EU)).resolves.toBeUndefined()
  })

  test('fails open when the lookup throws', async () => {
    await expect(
      assertRuntimeInHomeRegion('ws_us', {
        ...EU,
        lookupHomeRegion: async () => {
          throw new Error('db down')
        },
      }),
    ).resolves.toBeUndefined()
  })

  test('is inert in single-region / local mode without touching the database', async () => {
    await assertRuntimeInHomeRegion('ws_us', { ...EU, region: null })
    await assertRuntimeInHomeRegion('ws_us', { ...EU, peerIds: [] })
    expect(lookups).toEqual([])
  })

  test('RUNTIME_HOME_REGION_GUARD=off disables the guard', async () => {
    process.env.RUNTIME_HOME_REGION_GUARD = 'off'
    await expect(assertRuntimeInHomeRegion('ws_us', EU)).resolves.toBeUndefined()
    expect(lookups).toEqual([])
  })
})

describe('runtimeNotInHomeRegionResponse', () => {
  test('answers a refused runtime with a 409 naming the home region', async () => {
    const app = new Hono()
    app.get('/x', () => {
      throw new RuntimeNotInHomeRegionError('ws_eu', 'eu-frankfurt-1', 'us-ashburn-1')
    })
    app.onError((err, c) =>
      err instanceof RuntimeNotInHomeRegionError ? runtimeNotInHomeRegionResponse(c, err) : c.text('500', 500),
    )
    const res = await app.request('/x')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: {
        code: 'runtime_not_in_home_region',
        message: 'This workspace is served from eu-frankfurt-1; retry against that region.',
        homeRegion: 'eu-frankfurt-1',
        region: 'us-ashburn-1',
      },
    })
  })
})

describe('the WebSocket upgrade answer', () => {
  // The PTY / port-tunnel / preview bridges are upgraded before Hono, so they
  // cannot be proxied to the home region and have no Context to answer through.
  // They used to reply a bare `503 Runtime unavailable`, which is
  // indistinguishable from a host that is merely down: one workspace retried a
  // terminal session against the wrong region forever (3105 rows/24h).
  test('answers the same typed 409 as the HTTP path, without a Hono Context', async () => {
    const res = runtimeNotInHomeRegionUpgradeResponse(
      new RuntimeNotInHomeRegionError('ws_eu', 'eu-frankfurt-1', 'us-ashburn-1'),
    )
    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      error: {
        code: 'runtime_not_in_home_region',
        message: 'This workspace is served from eu-frankfurt-1; retry against that region.',
        homeRegion: 'eu-frankfurt-1',
        region: 'us-ashburn-1',
      },
    })
  })

  test('isNotInHomeRegion recognises the same refusal from another module instance', () => {
    expect(isNotInHomeRegion(new RuntimeNotInHomeRegionError('ws_eu', 'eu-frankfurt-1', 'us-ashburn-1'))).toBe(true)
    // A second copy of this module (query-string import, lazy import inside a
    // catch block) makes `instanceof` false; the code is the stable contract.
    expect(
      isNotInHomeRegion({
        name: 'RuntimeNotInHomeRegionError',
        code: 'runtime_not_in_home_region',
        workspaceId: 'ws_eu',
        homeRegion: 'eu-frankfurt-1',
        region: 'us-ashburn-1',
      }),
    ).toBe(true)
  })

  test('isNotInHomeRegion leaves ordinary failures on the 503 path', () => {
    expect(isNotInHomeRegion(new Error('connect ECONNREFUSED'))).toBe(false)
    expect(isNotInHomeRegion(new (class MetalHostUnreachableError extends Error {})('down'))).toBe(false)
    // A matching code with no homeRegion cannot produce the 409 body.
    expect(isNotInHomeRegion({ code: 'runtime_not_in_home_region' })).toBe(false)
    expect(isNotInHomeRegion(undefined)).toBe(false)
    expect(isNotInHomeRegion('runtime_not_in_home_region')).toBe(false)
  })
})

describe('runtimeOriginFor (GET /api/projects/:projectId/runtime-origin)', () => {
  // The terminal WebSocket cannot be proxied, so the client learns where to
  // reconnect from this route. It is only correct if a workspace homed in a peer
  // region gets that peer's origin and everything else gets ours.
  const peerUrl = (id: string) => (id === 'eu-frankfurt-1' ? 'https://api-eu.test' : undefined)

  test("a workspace homed in a peer region gets the peer's origin", () => {
    expect(runtimeOriginFor('eu-frankfurt-1', { region: 'us-ashburn-1', selfOrigin: 'https://api-us.test', peerUrl })).toBe(
      'https://api-eu.test',
    )
  })

  test('a workspace homed here gets our own origin', () => {
    expect(runtimeOriginFor('us-ashburn-1', { region: 'us-ashburn-1', selfOrigin: 'https://api-us.test', peerUrl })).toBe(
      'https://api-us.test',
    )
  })

  test('no home region (legacy row, single-region mode) gets our own origin', () => {
    expect(runtimeOriginFor(null, { region: null, selfOrigin: 'http://localhost:3000', peerUrl })).toBe(
      'http://localhost:3000',
    )
  })

  test('a home region that is not a configured peer still answers our origin', () => {
    expect(runtimeOriginFor('ap-tokyo-1', { region: 'us-ashburn-1', selfOrigin: 'https://api-us.test', peerUrl })).toBe(
      'https://api-us.test',
    )
  })
})
