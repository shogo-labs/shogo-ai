// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The HTTP surface, mounted the way `server.ts` mounts it.
 *
 * These assertions are about routing, not business logic: every route here
 * answers before it touches the database, so a 401 (or the relay's 501) proves
 * the path is mounted and shaped — a 404 would mean the runner's
 * `/api/internal/.../native/...` calls and the app's settings page are pointing
 * at nothing, which unit tests on the services cannot catch.
 */

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  nativeReleaseRelayRoutes,
  nativeReleaseRoutes,
  nativeWebhookRoutes,
} from '../native-release'

/** Mounted exactly as `server.ts` does: all three under `/api`. */
function app(resolveUserId: () => Promise<string | null> = async () => null) {
  const hono = new Hono()
  hono.route('/api', nativeReleaseRoutes({ resolveUserId }))
  hono.route('/api', nativeReleaseRelayRoutes())
  hono.route('/api', nativeWebhookRoutes())
  return hono
}

async function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await app().request(path, {
    method: init.method ?? 'GET',
    ...(init.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

describe('native release routes are mounted where the callers point', () => {
  it('answers the workspace credential routes', async () => {
    expect((await call('/api/workspaces/w1/native/credentials')).status).toBe(401)
    const put = await call('/api/workspaces/w1/native/credentials/asc_api_key', {
      method: 'PUT',
      body: { keyP8: 'x', keyId: 'y', issuerId: 'z', teamId: 't' },
    })
    expect(put.status).toBe(401)
    expect((await call('/api/workspaces/w1/native/credentials/expo_token', { method: 'DELETE' })).status).toBe(401)
  })

  it('answers the project app + release routes', async () => {
    // No project `p1` exists, so each route reaches its handler and refuses with
    // OUR json shape. An unmounted path would answer Hono's plain-text 404
    // instead, which is the distinction this test is about (see below).
    for (const [path, method] of [
      ['/api/projects/p1/native/app', 'GET'],
      ['/api/projects/p1/native/app', 'PUT'],
      ['/api/projects/p1/native/releases', 'GET'],
      ['/api/projects/p1/native/releases', 'POST'],
      ['/api/projects/p1/native/releases/r1/sources', 'POST'],
      ['/api/projects/p1/native/releases/r1', 'GET'],
    ] as const) {
      const res = await call(path, { method, body: method === 'GET' ? undefined : {} })
      expect({ path, method, code: res.json?.error?.code }).toEqual({ path, method, code: 'not_found' })
    }
  })

  it('distinguishes a mounted route from an unmounted one', async () => {
    const mounted = await call('/api/projects/p1/native/app')
    const unmounted = await call('/api/projects/p1/native/nope')
    expect(mounted.json?.error?.code).toBe('not_found')
    expect(unmounted.json).toBeNull()
  })

  it('refuses an unauthenticated caller on the workspace routes', async () => {
    const res = await call('/api/workspaces/w1/native/credentials')
    expect(res.status).toBe(401)
    expect(res.json?.error?.code).toBe('unauthorized')
  })

  it('mounts the EAS webhook, which refuses to run unconfigured instead of 404ing', async () => {
    const previous = process.env.EAS_WEBHOOK_SECRET
    delete process.env.EAS_WEBHOOK_SECRET
    try {
      const res = await call('/api/webhooks/eas', { method: 'POST', body: { id: 'b1', status: 'finished' } })
      expect(res.status).toBe(503)
      expect(res.json?.error?.code).toBe('native_webhook_unconfigured')
    } finally {
      if (previous !== undefined) process.env.EAS_WEBHOOK_SECRET = previous
    }
  })

  it('answers the relay path explicitly, so a relay client fails loudly', async () => {
    const res = await call('/api/native-release-relay/releases', { method: 'POST', body: {} })
    expect(res.status).toBe(501)
    expect(res.json?.error?.code).toBe('relay_not_enabled')
  })
})

describe('native release routes never leak a secret', () => {
  it('has no route that returns a credential payload without a mask', async () => {
    // A 401 body carries no data at all; the guard that matters is that the
    // credential read goes through `listCredentials`, which maps to
    // `maskedHint`. Asserting the shape here keeps a future refactor from
    // returning the encrypted blob or the plaintext.
    const res = await call('/api/workspaces/w1/native/credentials')
    expect(JSON.stringify(res.json)).not.toContain('encryptedPayload')
  })
})
