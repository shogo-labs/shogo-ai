// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

mock.module('../lib/runtime/agent-model-defaults', () => ({
  resolveEffectiveAgentModelDefaults: async (workspaceId: string) => ({
    workspaceId,
    basic: 'mimo-v2.5',
    advanced: 'mimo-v2.5',
    defaultMode: 'auto',
    autoTiers: {
      economy: { id: 'mimo-v2.5', provider: 'custom' },
      standard: { id: 'mimo-v2.5', provider: 'custom' },
      premium: { id: 'mimo-v2.5', provider: 'custom' },
    },
    hasAdvancedModelAccess: true,
  }),
}))

const { agentModelDefaultsRoute } = await import('../lib/runtime/agent-model-defaults-route')

function buildApp(auth?: { workspaceId?: string; isAuthenticated?: boolean }) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth)
    await next()
  })
  app.get('/', agentModelDefaultsRoute)
  return app
}

describe('agent model defaults endpoint', () => {
  test('rejects unauthenticated requests', async () => {
    const response = await buildApp().fetch(new Request('http://localhost/'))
    expect(response.status).toBe(401)
  })

  test('returns workspace-scoped cloud defaults for an authenticated key', async () => {
    const response = await buildApp({
      workspaceId: 'ws-cloud',
      isAuthenticated: true,
    }).fetch(new Request('http://localhost/'))

    expect(response.status).toBe(200)
    expect((await response.json() as any).workspaceId).toBe('ws-cloud')
  })
})
