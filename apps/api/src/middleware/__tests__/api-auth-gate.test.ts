// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-api-auth-gate'

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'

const { apiAuthGate, isGatePublicPath, GATE_PUBLIC_PREFIXES } = await import('../api-auth-gate')
const { PUBLIC_PREFIXES } = await import('../auth')

function buildApp(authenticated = false): Hono {
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    c.set('auth', authenticated ? { isAuthenticated: true, userId: 'u1' } : { isAuthenticated: false })
    await next()
  })
  app.use('/api/*', apiAuthGate)
  app.all('/api/*', (c) => c.json({ ok: true }))
  return app
}

describe('apiAuthGate', () => {
  test('lets unauthenticated key-in-body endpoints through', async () => {
    const app = buildApp()
    for (const path of ['/api/api-keys/validate', '/api/api-keys/heartbeat']) {
      const res = await app.fetch(new Request(`http://x${path}`, { method: 'POST' }))
      expect(res.status).toBe(200)
    }
  })

  test('lets every requireAuth public prefix through', () => {
    for (const prefix of PUBLIC_PREFIXES) {
      expect(isGatePublicPath(`${prefix}x`)).toBe(true)
    }
  })

  test('lets gate-only public prefixes and special paths through', () => {
    for (const prefix of GATE_PUBLIC_PREFIXES) {
      expect(isGatePublicPath(`${prefix}x`)).toBe(true)
    }
    expect(isGatePublicPath('/api/github/webhook')).toBe(true)
    expect(isGatePublicPath('/api/github/callback')).toBe(true)
    expect(isGatePublicPath('/api/github/installations')).toBe(false)
    expect(isGatePublicPath('/api/voice/elevenlabs/webhook')).toBe(true)
    expect(isGatePublicPath('/api/projects/p1/thumbnail.png')).toBe(true)
    expect(isGatePublicPath('/api/projects/p1/agent-proxy/agent/channels/webchat/widget.js')).toBe(true)
  })

  test('does not duplicate requireAuth public prefixes in the gate-only list', () => {
    const shared = GATE_PUBLIC_PREFIXES.filter((p) => PUBLIC_PREFIXES.includes(p))
    expect(shared).toEqual([])
  })

  test('401s an unauthenticated request to a non-public path', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/api-keys'))
    expect(res.status).toBe(401)
  })

  test('passes an authenticated request to a non-public path', async () => {
    const res = await buildApp(true).fetch(new Request('http://x/api/api-keys'))
    expect(res.status).toBe(200)
  })
})
