// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CLI cloud-login route tests.
 *
 * Drives the four endpoints that back `shogo login` end-to-end with a
 * mocked Prisma:
 *
 *   POST /api/cli/login/start      (public)
 *   GET  /api/cli/login/state      (public — bridge page)
 *   POST /api/cli/login/approve    (cookie-authed — bridge page)
 *   POST /api/cli/login/deny       (cookie-authed)
 *   GET  /api/cli/login/poll       (public — single-use)
 *
 * The behaviors we care about:
 *   - start validates the deviceId minimum length
 *   - the returned state + userCode round-trip via /state
 *   - approve mints a kind=device API key, dedupes prior keys for
 *     (workspaceId, deviceId), and pins it to the state
 *   - the next /poll returns the key once and only once
 *   - approve requires auth; poll/start do not
 *   - deny flips the status so /poll returns 'denied'
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

interface ApiKeyRow {
  id: string
  name: string
  keyHash: string
  keyPrefix: string
  workspaceId: string
  userId: string
  kind: string
  deviceId: string | null
  deviceName: string | null
  devicePlatform: string | null
  deviceAppVersion: string | null
  lastSeenAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

const apiKeys = new Map<string, ApiKeyRow>()
const members = [
  { id: 'm1', userId: 'user-1', workspaceId: 'ws-1', createdAt: new Date('2026-01-01') },
  { id: 'm2', userId: 'user-1', workspaceId: 'ws-2', createdAt: new Date('2026-02-01') },
]
const workspaces = new Map([
  ['ws-1', { id: 'ws-1', name: 'Personal', slug: 'personal' }],
  ['ws-2', { id: 'ws-2', name: 'Team', slug: 'team' }],
])
const users = new Map([['user-1', { id: 'user-1', email: 'cli@test.com' }]])

let idCounter = 0
const nextId = (p: string) => `${p}-${++idCounter}`

const mockPrisma = {
  apiKey: {
    create: mock(async ({ data }: any) => {
      const row: ApiKeyRow = {
        id: nextId('key'),
        name: 'Untitled',
        keyHash: '',
        keyPrefix: '',
        workspaceId: '',
        userId: '',
        kind: 'user',
        deviceId: null,
        deviceName: null,
        devicePlatform: null,
        deviceAppVersion: null,
        lastSeenAt: null,
        revokedAt: null,
        createdAt: new Date(),
        ...(data as any),
      }
      apiKeys.set(row.id, row)
      return { ...row }
    }),
    updateMany: mock(async ({ where, data }: any) => {
      let count = 0
      for (const r of apiKeys.values()) {
        let match = true
        for (const [k, v] of Object.entries(where)) {
          if ((r as any)[k] !== v) { match = false; break }
        }
        if (match) {
          Object.assign(r, data)
          count += 1
        }
      }
      return { count }
    }),
  },
  member: {
    findFirst: mock(async ({ where, orderBy }: any) => {
      const matches = members.filter((m) => {
        for (const [k, v] of Object.entries(where)) {
          if ((m as any)[k] !== v) return false
        }
        return true
      })
      if (orderBy?.createdAt === 'asc') {
        matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      }
      return matches[0] || null
    }),
  },
  workspace: {
    findUnique: mock(async ({ where }: any) => workspaces.get(where.id) || null),
  },
  user: {
    findUnique: mock(async ({ where }: any) => users.get(where.id) || null),
  },
  $transaction: mock(async (fn: any) => fn(mockPrisma)),
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

const { cliAuthRoutes, _testing } = await import('../routes/cli-auth')

const signedInUser = { id: 'user-1', userId: 'user-1' }

function buildApp(opts: { authed: boolean }): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (opts.authed) c.set('auth', signedInUser)
    else c.set('auth', { userId: undefined })
    await next()
  })
  app.route('/api', cliAuthRoutes())
  return app
}

const validStart = {
  deviceId: 'device-abcdef',
  deviceName: 'My Laptop',
  devicePlatform: 'darwin-arm64',
  deviceAppVersion: 'shogo-cli/0.1.0',
}

describe('cli-auth routes', () => {
  let publicApp: Hono
  let authedApp: Hono

  beforeEach(() => {
    apiKeys.clear()
    _testing.pendingStates.clear()
    idCounter = 0
    publicApp = buildApp({ authed: false })
    authedApp = buildApp({ authed: true })
  })

  describe('POST /api/cli/login/start', () => {
    it('rejects missing/short deviceId', async () => {
      const r = await publicApp.request('/api/cli/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'short' }),
      })
      expect(r.status).toBe(400)
    })

    it('returns state, userCode, authUrl, expiresInMs, pollIntervalMs', async () => {
      const r = await publicApp.request('/api/cli/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validStart),
      })
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.ok).toBe(true)
      expect(body.state).toBeString()
      expect(body.userCode).toMatch(/^[0-9A-F]{6}$/)
      expect(body.authUrl).toContain('/auth/cli-link?')
      expect(body.authUrl).toContain(`state=${body.state}`)
      expect(body.expiresInMs).toBeGreaterThan(0)
      expect(body.pollIntervalMs).toBeGreaterThan(0)
    })
  })

  describe('GET /api/cli/login/state', () => {
    it('returns the state metadata for the bridge page', async () => {
      const start = await publicApp.request('/api/cli/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validStart),
      })
      const { state, userCode } = await start.json()

      const r = await publicApp.request(`/api/cli/login/state?state=${state}`)
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.ok).toBe(true)
      expect(body.userCode).toBe(userCode)
      expect(body.deviceId).toBe(validStart.deviceId)
      expect(body.deviceName).toBe(validStart.deviceName)
      expect(body.devicePlatform).toBe(validStart.devicePlatform)
    })

    it('returns 404 for an unknown state', async () => {
      const r = await publicApp.request('/api/cli/login/state?state=notreal')
      expect(r.status).toBe(404)
    })
  })

  describe('POST /api/cli/login/approve', () => {
    it('requires authentication', async () => {
      const start = await publicApp.request('/api/cli/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validStart),
      })
      const { state } = await start.json()

      const r = await publicApp.request('/api/cli/login/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state }),
      })
      expect(r.status).toBe(401)
    })

    it('mints a device key and pins it to the state', async () => {
      const start = await publicApp.request('/api/cli/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validStart),
      })
      const { state } = await start.json()

      const approve = await authedApp.request('/api/cli/login/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, workspaceId: 'ws-1' }),
      })
      expect(approve.status).toBe(200)
      const approveBody = await approve.json()
      expect(approveBody.ok).toBe(true)
      expect(approveBody.workspace).toBe('Personal')
      expect(approveBody.email).toBe('cli@test.com')

      // Exactly one device-kind key was created.
      const keys = [...apiKeys.values()]
      expect(keys.length).toBe(1)
      expect(keys[0].kind).toBe('device')
      expect(keys[0].deviceId).toBe(validStart.deviceId)
      expect(keys[0].workspaceId).toBe('ws-1')
    })

    it('rejects approval for a workspace the user is not in', async () => {
      const start = await publicApp.request('/api/cli/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validStart),
      })
      const { state } = await start.json()

      const approve = await authedApp.request('/api/cli/login/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, workspaceId: 'ws-stranger' }),
      })
      expect(approve.status).toBe(403)
    })
  })

  describe('GET /api/cli/login/poll', () => {
    it('returns pending before approval', async () => {
      const start = await publicApp.request('/api/cli/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validStart),
      })
      const { state } = await start.json()

      const r = await publicApp.request(`/api/cli/login/poll?state=${state}`)
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.status).toBe('pending')
      expect(body.key).toBeUndefined()
    })

    it('returns the key once after approval, then expires the state', async () => {
      const start = await publicApp.request('/api/cli/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validStart),
      })
      const { state } = await start.json()

      await authedApp.request('/api/cli/login/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, workspaceId: 'ws-1' }),
      })

      const first = await publicApp.request(`/api/cli/login/poll?state=${state}`)
      expect(first.status).toBe(200)
      const firstBody = await first.json()
      expect(firstBody.status).toBe('approved')
      expect(firstBody.key).toStartWith('shogo_sk_')
      expect(firstBody.workspace).toBe('Personal')
      expect(firstBody.email).toBe('cli@test.com')

      // Single-use: the second poll should report expired (state burned).
      const second = await publicApp.request(`/api/cli/login/poll?state=${state}`)
      const secondBody = await second.json()
      expect(secondBody.status).toBe('expired')
      expect(secondBody.key).toBeUndefined()
    })

    it('returns expired for unknown state', async () => {
      const r = await publicApp.request('/api/cli/login/poll?state=notreal')
      const body = await r.json()
      expect(body.status).toBe('expired')
    })
  })

  describe('POST /api/cli/login/deny', () => {
    it('flips the state so subsequent polls report denied', async () => {
      const start = await publicApp.request('/api/cli/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validStart),
      })
      const { state } = await start.json()

      const deny = await authedApp.request('/api/cli/login/deny', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state }),
      })
      expect(deny.status).toBe(200)

      const poll = await publicApp.request(`/api/cli/login/poll?state=${state}`)
      const body = await poll.json()
      expect(body.status).toBe('denied')
    })
  })
})
