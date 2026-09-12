// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { createAgentModelDefaultsRoute } from '../lib/runtime/agent-model-defaults-route'

const resolveDefaults = async (workspaceId: string) => ({
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
})

function buildApp(auth?: { userId?: string; workspaceId?: string; isAuthenticated?: boolean }) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth)
    await next()
  })
  app.get('/', createAgentModelDefaultsRoute(
    resolveDefaults,
    async (auth) => ({ workspaceId: auth.workspaceId || 'ws-session' }),
  ))
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

  test('resolves a workspace for an authenticated session', async () => {
    const response = await buildApp({
      userId: 'user-session',
      isAuthenticated: true,
    }).fetch(new Request('http://localhost/'))

    expect(response.status).toBe(200)
    expect((await response.json() as any).workspaceId).toBe('ws-session')
  })
})
