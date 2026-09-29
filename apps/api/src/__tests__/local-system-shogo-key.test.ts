// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PUT /api/local/shogo-key (desktop router): saving a new key must clear the
 * previous key's rejected/heartbeat state, or the UI keeps asking the user to
 * sign in again with a key that was just validated.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const upsertMock = mock(async (_args: any) => ({}))

mock.module('../auth', () => ({ auth: {} }))
mock.module('../lib/prisma', () => ({
  prisma: { localConfig: { upsert: upsertMock, findUnique: async () => null, deleteMany: async () => ({}) } },
}))
mock.module('../lib/cloud-urls', () => ({ getShogoCloudUrl: () => 'https://cloud.test' }))
mock.module('../lib/federated-upstream', () => ({
  _resetAgentModelDefaultsCache: () => {},
  _resetUpstreamCredentialCache: () => {},
}))

const { localSystemRoutes } = await import('../routes/local-system')
const { isCloudKeyRejected, markCloudKeyRejected, recordHeartbeat, getHeartbeatStatus, resetCloudKeyState } =
  await import('../lib/cloud-key-state')

const origFetch = globalThis.fetch
const origWarn = console.warn
const ORIG_KEY = process.env.SHOGO_API_KEY

function buildApp(): Hono {
  const app = new Hono()
  app.route('/api', localSystemRoutes())
  return app
}

function putKey(key: string): Promise<Response> {
  return buildApp().fetch(new Request('http://x/api/local/shogo-key', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  }))
}

beforeEach(() => {
  resetCloudKeyState()
  console.warn = () => {}
  markCloudKeyRejected('previous key revoked')
  recordHeartbeat(false, 'HTTP 401')
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.warn = origWarn
  if (ORIG_KEY === undefined) delete process.env.SHOGO_API_KEY
  else process.env.SHOGO_API_KEY = ORIG_KEY
})

describe('PUT /api/local/shogo-key', () => {
  test('clears the previous rejected and heartbeat state after saving a valid key', async () => {
    globalThis.fetch = (async () => Response.json({ valid: true, workspace: { id: 'ws1' }, user: { id: 'u1' } })) as typeof fetch

    const res = await putKey('shogo_sk_new')
    expect(res.status).toBe(200)
    expect(process.env.SHOGO_API_KEY).toBe('shogo_sk_new')
    expect(isCloudKeyRejected()).toBe(false)
    expect(getHeartbeatStatus()).toEqual({ lastHeartbeatOk: null, lastHeartbeatAt: null, lastHeartbeatError: null })
  })

  test('keeps the existing state when cloud rejects the new key', async () => {
    globalThis.fetch = (async () => Response.json({ valid: false, error: 'Key not found' })) as typeof fetch

    const res = await putKey('shogo_sk_bad')
    expect(res.status).toBe(400)
    expect(isCloudKeyRejected()).toBe(true)
  })
})
