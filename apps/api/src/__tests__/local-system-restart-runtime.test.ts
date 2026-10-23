// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `POST /api/local/system/restart-runtime` stops every host runtime the API
 * supervises, which is exactly what `e2e/local/chat-task-interrupted-restart`
 * needs to kill a running background task the way a restart does (SHO-141).
 *
 * That makes it a switch that must not be reachable without the e2e secret:
 * the endpoint exists on every desktop install, and anything able to POST to
 * it could tear down a user's running turns. These tests lock the refusals; the
 * happy path needs a real RuntimeManager and is covered by the e2e spec.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

mock.module('../auth', () => ({ auth: {} }))
mock.module('../lib/prisma', () => ({
  prisma: {
    localConfig: {
      findUnique: async () => null,
      upsert: async () => ({}),
      deleteMany: async () => ({}),
      findMany: async () => [],
    },
  },
}))
mock.module('../lib/cloud-urls', () => ({ getShogoCloudUrl: () => 'https://cloud.test' }))
mock.module('../lib/federated-upstream', () => ({
  _resetAgentModelDefaultsCache: () => {},
  _resetUpstreamCredentialCache: () => {},
}))
mock.module('../lib/instance-tunnel', () => ({
  startInstanceTunnel: () => {},
  stopInstanceTunnel: () => {},
  isTunnelConnected: () => false,
  getInstanceTunnelStatus: () => [],
}))
mock.module('../services/cloud-workspaces', () => ({
  setCloudWorkspaces: async () => {},
  clearCloudWorkspaces: async () => {},
}))

let stopAllCalls = 0

mock.module('../lib/runtime', () => ({
  getRuntimeManager: () => ({
    getActiveProjects: () => ['ws:proj:anchor'],
    stopAll: async () => {
      stopAllCalls += 1
    },
  }),
}))

const { localSystemRoutes } = await import('../routes/local-system')

const SECRET = 'restart-secret'

function restart(header?: string): Promise<Response> {
  const app = new Hono()
  app.route('/api', localSystemRoutes())
  return app.fetch(
    new Request('http://x/api/local/system/restart-runtime', {
      method: 'POST',
      headers: header ? { 'x-e2e-bootstrap-secret': header } : {},
    }),
  )
}

const origSecret = process.env.SHOGO_E2E_BOOTSTRAP_SECRET

beforeEach(() => {
  stopAllCalls = 0
  delete process.env.SHOGO_E2E_BOOTSTRAP_SECRET
})

afterEach(() => {
  if (origSecret === undefined) delete process.env.SHOGO_E2E_BOOTSTRAP_SECRET
  else process.env.SHOGO_E2E_BOOTSTRAP_SECRET = origSecret
})

describe('POST /api/local/system/restart-runtime', () => {
  test('401 when no secret is configured, even with a header', async () => {
    const res = await restart(SECRET)
    expect(res.status).toBe(401)
    expect(stopAllCalls).toBe(0)
  })

  test('401 when the header is missing', async () => {
    process.env.SHOGO_E2E_BOOTSTRAP_SECRET = SECRET
    const res = await restart()
    expect(res.status).toBe(401)
    expect(stopAllCalls).toBe(0)
  })

  test('401 when the header is wrong', async () => {
    process.env.SHOGO_E2E_BOOTSTRAP_SECRET = SECRET
    const res = await restart('not-the-secret')
    expect(res.status).toBe(401)
    expect(stopAllCalls).toBe(0)
  })

  test('200 with the configured secret, and it reports what it stopped', async () => {
    process.env.SHOGO_E2E_BOOTSTRAP_SECRET = SECRET
    const res = await restart(SECRET)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stopped: ['ws:proj:anchor'] })
    expect(stopAllCalls).toBe(1)
  })
})
