// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud Login E2E Test
 *
 * Exercises the full desktop "Sign in to Shogo Cloud" handshake end to end,
 * in-process, with mocked Prisma. Covers the cloud-side api-keys routes
 * (device minting + heartbeat + validate + revoke) AND the local-mode
 * cloud-login routes (start/complete/status/heartbeat/signout) on a single
 * Hono app, with `globalThis.fetch` rerouted so the local-auth `/complete`
 * handler's outbound calls land back on the same app.
 *
 * Scenarios:
 *   1. Device-kind key flow — mint, validate, dedupe, revoke
 *   2. resolveApiKey bumps lastSeenAt + deviceAppVersion for device keys
 *   3. Full local-mode happy path: start → complete persists localConfig
 *   4. State nonce: missing / unknown / single-use / expired
 *   5. Heartbeat with revoked key wipes local config (cloud-revoke takes effect)
 *   6. Signout wipes localConfig and status flips
 *
 * Run: bun test apps/api/src/__tests__/cloud-login-e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

// ─── Types ──────────────────────────────────────────────────────────────────

interface ApiKeyRow {
  id: string
  name: string
  keyHash: string
  keyPrefix: string
  workspaceId: string
  userId: string
  lastUsedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
  revokedAt: Date | null
  kind: 'user' | 'device'
  deviceId: string | null
  deviceName: string | null
  devicePlatform: string | null
  deviceAppVersion: string | null
  lastSeenAt: Date | null
}

// ─── In-memory stores ───────────────────────────────────────────────────────

const apiKeys = new Map<string, ApiKeyRow>()
const localConfig = new Map<string, string>()
const members = [
  { id: 'member-1', userId: 'user-1', workspaceId: 'ws-1', createdAt: new Date('2026-01-01') },
  { id: 'member-2', userId: 'user-1', workspaceId: 'ws-2', createdAt: new Date('2026-02-01') },
]
const workspaces = new Map<string, { id: string; name: string; slug: string }>([
  ['ws-1', { id: 'ws-1', name: 'Personal', slug: 'personal' }],
  ['ws-2', { id: 'ws-2', name: 'Team', slug: 'team' }],
])
const users = new Map([
  ['user-1', { id: 'user-1', name: 'Test User', email: 'e2e@test.com' }],
])

let idCounter = 0
function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

function matchApiKey(where: Record<string, unknown>): ApiKeyRow[] {
  return [...apiKeys.values()].filter((row) => {
    for (const [k, v] of Object.entries(where)) {
      if ((row as any)[k] !== v) return false
    }
    return true
  })
}

// ─── Prisma mock ────────────────────────────────────────────────────────────

const mockPrisma = {
  apiKey: {
    create: mock(async (args: { data: Partial<ApiKeyRow> }) => {
      const row: ApiKeyRow = {
        id: nextId('key'),
        name: 'Untitled',
        keyHash: '',
        keyPrefix: '',
        workspaceId: '',
        userId: '',
        lastUsedAt: null,
        expiresAt: null,
        createdAt: new Date(),
        revokedAt: null,
        kind: 'user',
        deviceId: null,
        deviceName: null,
        devicePlatform: null,
        deviceAppVersion: null,
        lastSeenAt: null,
        ...(args.data as any),
      }
      apiKeys.set(row.id, row)
      return { ...row }
    }),
    findUnique: mock(async (args: { where: Record<string, unknown>; select?: any; include?: any }) => {
      const where = args.where
      let row: ApiKeyRow | undefined
      if (where.id) row = apiKeys.get(where.id as string)
      else if (where.keyHash) row = [...apiKeys.values()].find((r) => r.keyHash === where.keyHash)
      if (!row) return null
      if (args.include?.workspace) {
        return {
          ...row,
          workspace: workspaces.get(row.workspaceId) || null,
          user: users.get(row.userId) || null,
        }
      }
      return { ...row }
    }),
    findMany: mock(async (args: { where: Record<string, unknown>; select?: any; orderBy?: any }) => {
      const where = args.where || {}
      let rows = [...apiKeys.values()].filter((row) => {
        for (const [k, v] of Object.entries(where)) {
          if (k === 'revokedAt' && v === null && row.revokedAt !== null) return false
          if (k !== 'revokedAt' && (row as any)[k] !== v) return false
        }
        return true
      })
      // Attach user for select compatibility
      return rows.map((r) => ({
        ...r,
        user: users.get(r.userId) || null,
      }))
    }),
    updateMany: mock(async (args: { where: Record<string, unknown>; data: Partial<ApiKeyRow> }) => {
      const rows = matchApiKey(args.where).filter((r) => {
        if ('revokedAt' in args.where) {
          return r.revokedAt === args.where.revokedAt
        }
        return true
      })
      for (const r of rows) Object.assign(r, args.data)
      return { count: rows.length }
    }),
    update: mock(async (args: { where: { id: string }; data: Partial<ApiKeyRow> }) => {
      const row = apiKeys.get(args.where.id)
      if (!row) throw new Error('Not found')
      Object.assign(row, args.data)
      return { ...row }
    }),
  },
  member: {
    findFirst: mock(async (args: { where: Record<string, unknown>; orderBy?: any; select?: any }) => {
      const where = args.where
      const matches = members.filter((m) => {
        for (const [k, v] of Object.entries(where)) {
          if ((m as any)[k] !== v) return false
        }
        return true
      })
      if (args.orderBy?.createdAt === 'asc') {
        matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      }
      return matches[0] || null
    }),
  },
  workspace: {
    findUnique: mock(async (args: { where: { id: string } }) => {
      return workspaces.get(args.where.id) || null
    }),
  },
  localConfig: {
    findUnique: mock(async (args: { where: { key: string } }) => {
      const value = localConfig.get(args.where.key)
      return value === undefined ? null : { key: args.where.key, value }
    }),
    upsert: mock(async (args: {
      where: { key: string }
      create: { key: string; value: string }
      update: { value: string }
    }) => {
      localConfig.set(args.where.key, args.update.value ?? args.create.value)
      return { key: args.where.key, value: localConfig.get(args.where.key)! }
    }),
    deleteMany: mock(async (args: { where: { key: string } }) => {
      const existed = localConfig.delete(args.where.key)
      return { count: existed ? 1 : 0 }
    }),
  },
  $transaction: mock(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma)),
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

// The dynamic import of `../lib/instance-tunnel` inside local-auth.ts would
// otherwise pull in a large surface we don't care about here.
mock.module('../lib/instance-tunnel', () => ({
  startInstanceTunnel: mock(() => {}),
  stopInstanceTunnel: mock(() => {}),
}))

// ─── Import routes AFTER mocks ──────────────────────────────────────────────

const { apiKeyRoutes, resolveApiKey } = await import('../routes/api-keys')
const { localAuthRoutes } = await import('../routes/local-auth')

// ─── Test app & fetch interception ──────────────────────────────────────────

const CLOUD_HOST = 'http://cloud.test'
const signedInUser = { id: 'user-1', userId: 'user-1', email: 'e2e@test.com' }

function buildApp(): Hono {
  const app = new Hono()
  // The cloud api-keys routes require an authenticated user. We set auth on
  // every request; local-auth routes ignore it so this is harmless.
  app.use('*', async (c, next) => {
    c.set('auth', signedInUser)
    await next()
  })
  app.route('/api', apiKeyRoutes())
  app.route('/api', localAuthRoutes())
  return app
}

/**
 * Monkey-patch fetch so that local-auth's outbound calls to
 * `${cloudUrl}/api/api-keys/validate` (and /heartbeat) land on the same Hono
 * app instead of escaping to the network.
 */
function installFetchBridge(app: Hono): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.startsWith(CLOUD_HOST)) {
      const path = url.slice(CLOUD_HOST.length)
      return app.request(path, init as RequestInit)
    }
    return originalFetch(input as any, init as any)
  }) as typeof fetch
  return () => { globalThis.fetch = originalFetch }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Cloud Login E2E', () => {
  let app: Hono
  let restoreFetch: () => void

  beforeEach(() => {
    apiKeys.clear()
    localConfig.clear()
    idCounter = 0
    delete process.env.SHOGO_API_KEY
    // The cloud endpoint is now sourced ONLY from SHOGO_CLOUD_URL — point
    // it at our in-process bridge for the duration of each test.
    process.env.SHOGO_CLOUD_URL = CLOUD_HOST
    app = buildApp()
    restoreFetch?.()
    restoreFetch = installFetchBridge(app)
  })

  // ─── Cloud side: device keys ───────────────────────────────────────────────

  describe('POST /api/api-keys/device', () => {
    test('mints a kind=device key with metadata', async () => {
      const res = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          deviceId: 'device-abc-123',
          deviceName: 'E2E Laptop',
          devicePlatform: 'darwin',
          deviceAppVersion: '0.1.0',
        }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.key).toStartWith('shogo_sk_')
      expect(data.kind).toBe('device')
      expect(data.deviceId).toBe('device-abc-123')
      expect(data.deviceName).toBe('E2E Laptop')
      expect(data.devicePlatform).toBe('darwin')
      expect(data.deviceAppVersion).toBe('0.1.0')
      expect(data.workspace?.id).toBe('ws-1')

      // Exactly one un-revoked row persisted
      const stored = [...apiKeys.values()]
      expect(stored.length).toBe(1)
      expect(stored[0].kind).toBe('device')
      expect(stored[0].lastSeenAt).toBeInstanceOf(Date)
    })

    test('rejects missing deviceId', async () => {
      const res = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1' }),
      })
      expect(res.status).toBe(400)
    })

    test('rejects workspace the caller is not a member of', async () => {
      const res = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-stranger',
          deviceId: 'device-abc-123',
        }),
      })
      expect(res.status).toBe(403)
    })

    test('defaults to the user\'s first workspace when omitted', async () => {
      const res = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-abc-123' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      // first membership by createdAt asc is ws-1
      expect(data.workspaceId).toBe('ws-1')
    })

    test('dedupes by (workspaceId, deviceId) on repeat calls', async () => {
      const first = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          deviceId: 'device-dedupe',
          deviceName: 'First',
          deviceAppVersion: '0.1.0',
        }),
      })
      expect(first.status).toBe(200)
      const firstKey = (await first.json()).key as string

      const second = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          deviceId: 'device-dedupe',
          deviceName: 'Still Same Mac',
          deviceAppVersion: '0.2.0',
        }),
      })
      expect(second.status).toBe(200)
      const secondKey = (await second.json()).key as string
      expect(secondKey).not.toBe(firstKey)

      const rows = [...apiKeys.values()].filter(
        (r) => r.kind === 'device' && r.deviceId === 'device-dedupe',
      )
      expect(rows.length).toBe(2)
      const unrevoked = rows.filter((r) => r.revokedAt === null)
      expect(unrevoked.length).toBe(1)
      expect(unrevoked[0].deviceAppVersion).toBe('0.2.0')
    })

    test('a different deviceId creates an additional row instead of revoking', async () => {
      await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1', deviceId: 'laptop-1' }),
      })
      await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1', deviceId: 'desktop-1' }),
      })
      const unrevoked = [...apiKeys.values()].filter((r) => r.revokedAt === null)
      expect(unrevoked.length).toBe(2)
    })
  })

  // ─── Cloud side: listing, validation, revoke ────────────────────────────

  describe('GET /api/api-keys?kind=', () => {
    test('filters by kind', async () => {
      // Seed a user key and a device key
      await app.request('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1', name: 'CI token' }),
      })
      await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          deviceId: 'laptop-filter-1',
          deviceName: 'Laptop',
        }),
      })

      const devicesRes = await app.request('/api/api-keys?workspaceId=ws-1&kind=device')
      expect(devicesRes.status).toBe(200)
      const devices = (await devicesRes.json()).keys
      expect(devices.length).toBe(1)
      expect(devices[0].kind).toBe('device')
      expect(devices[0].deviceName).toBe('Laptop')

      const usersRes = await app.request('/api/api-keys?workspaceId=ws-1&kind=user')
      const usersList = (await usersRes.json()).keys
      expect(usersList.length).toBe(1)
      expect(usersList[0].kind).toBe('user')
      expect(usersList[0].name).toBe('CI token')
    })
  })

  describe('POST /api/api-keys/validate', () => {
    test('returns kind + deviceId + user email for device keys', async () => {
      const mint = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1', deviceId: 'device-validate-1' }),
      })
      const key = (await mint.json()).key

      const res = await app.request('/api/api-keys/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.valid).toBe(true)
      expect(data.kind).toBe('device')
      expect(data.deviceId).toBe('device-validate-1')
      expect(data.user?.email).toBe('e2e@test.com')
      expect(data.workspace?.id).toBe('ws-1')
    })

    test('returns valid=false for revoked key', async () => {
      const mint = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1', deviceId: 'device-rev-1' }),
      })
      const minted = await mint.json()
      await app.request(`/api/api-keys/${minted.id}`, { method: 'DELETE' })

      const res = await app.request('/api/api-keys/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: minted.key }),
      })
      const data = await res.json()
      expect(data.valid).toBe(false)
    })
  })

  describe('resolveApiKey (AI proxy auth)', () => {
    test('device key bumps lastSeenAt and deviceAppVersion', async () => {
      const mint = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          deviceId: 'device-proxy-1',
          deviceAppVersion: '0.1.0',
        }),
      })
      const { key, id } = await mint.json()

      // Back-date lastSeenAt so we can observe the bump.
      const row = apiKeys.get(id)!
      row.lastSeenAt = new Date(0)
      row.deviceAppVersion = '0.1.0'

      const resolved = await resolveApiKey(key, { deviceAppVersion: '0.2.5' })
      expect(resolved).toEqual({
        workspaceId: 'ws-1',
        userId: 'user-1',
        kind: 'device',
        deviceId: 'device-proxy-1',
      })
      // Fire-and-forget update isn't awaited by resolveApiKey, so give the
      // microtask queue a beat before asserting the DB side-effect landed.
      // Generous timeout to avoid flakes when the whole suite is running hot.
      await new Promise((r) => setTimeout(r, 50))
      expect(row.lastSeenAt!.getTime()).toBeGreaterThan(0)
      expect(row.deviceAppVersion).toBe('0.2.5')
    })

    test('returns null for revoked keys', async () => {
      const mint = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1', deviceId: 'device-rev-proxy' }),
      })
      const { key, id } = await mint.json()
      apiKeys.get(id)!.revokedAt = new Date()

      const resolved = await resolveApiKey(key)
      expect(resolved).toBeNull()
    })
  })

  // ─── Local-mode: full handshake ────────────────────────────────────────

  describe('Local cloud-login handshake', () => {
    test('status is signedIn=false before the flow starts', async () => {
      const res = await app.request('/api/local/cloud-login/status')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.signedIn).toBe(false)
    })

    test('happy path: start → complete writes localConfig and status flips', async () => {
      // Step 1: local start. Note: the request body deliberately does NOT
      // include a cloudUrl — the endpoint now only honors SHOGO_CLOUD_URL.
      const startRes = await app.request('/api/local/cloud-login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'e2e-device-happy',
          deviceName: 'E2E Mac',
          devicePlatform: 'darwin',
          deviceAppVersion: '0.1.0',
        }),
      })
      expect(startRes.status).toBe(200)
      const start = await startRes.json()
      expect(start.ok).toBe(true)
      expect(start.state).toHaveLength(64) // 32 random bytes as hex
      expect(start.authUrl).toStartWith(`${CLOUD_HOST}/auth/local-link?`)
      expect(start.cloudUrl).toBe(CLOUD_HOST)
      const parsed = new URL(start.authUrl)
      expect(parsed.searchParams.get('deviceId')).toBe('e2e-device-happy')
      expect(parsed.searchParams.get('deviceName')).toBe('E2E Mac')
      expect(parsed.searchParams.get('appVersion')).toBe('0.1.0')
      expect(parsed.searchParams.get('callback')).toBe('shogo://auth-callback')

      // Step 2: cloud bridge would have minted a device key for this user.
      // Simulate by calling the cloud endpoint directly.
      const mint = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          deviceId: 'e2e-device-happy',
          deviceName: 'E2E Mac',
          devicePlatform: 'darwin',
          deviceAppVersion: '0.1.0',
        }),
      })
      const mintedKey = (await mint.json()).key as string

      // Step 3: Electron main process POSTs /complete
      const completeRes = await app.request('/api/local/cloud-login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: start.state,
          key: mintedKey,
          email: 'e2e@test.com',
          workspace: 'Personal',
        }),
      })
      expect(completeRes.status).toBe(200)
      const complete = await completeRes.json()
      expect(complete.ok).toBe(true)
      expect(complete.email).toBe('e2e@test.com')
      expect(complete.workspace?.id).toBe('ws-1')
      expect(complete.deviceId).toBe('e2e-device-happy')

      // localConfig persisted: ONLY the key + key-info; the cloud URL is
      // env-only and intentionally not persisted.
      expect(localConfig.get('SHOGO_API_KEY')).toBe(mintedKey)
      expect(localConfig.has('SHOGO_CLOUD_URL')).toBe(false)
      const info = JSON.parse(localConfig.get('SHOGO_KEY_INFO')!)
      expect(info.workspace?.id).toBe('ws-1')
      expect(info.email).toBe('e2e@test.com')
      expect(info.deviceId).toBe('e2e-device-happy')
      expect(info.kind).toBe('device')

      // process.env mirrors the stored key for the duration of the process.
      // SHOGO_CLOUD_URL is not mutated by the handler — it stays whatever
      // the operator set at process start.
      expect(process.env.SHOGO_API_KEY).toBe(mintedKey)
      expect(process.env.SHOGO_CLOUD_URL).toBe(CLOUD_HOST)

      // Step 4: status flips to signed in
      const statusRes = await app.request('/api/local/cloud-login/status')
      const status = await statusRes.json()
      expect(status.signedIn).toBe(true)
      expect(status.email).toBe('e2e@test.com')
      expect(status.workspace?.id).toBe('ws-1')
      expect(status.deviceId).toBe('e2e-device-happy')
      expect(status.keyPrefix).toStartWith('shogo_sk_')
      expect(status.cloudUrl).toBe(CLOUD_HOST)
    })

    test('start echoes preselected workspaceId into the bridge URL', async () => {
      // The desktop "Switch workspace" affordance passes a workspaceId so
      // the bridge picker can pre-select. start must round-trip it as a
      // query param on the generated authUrl.
      const startRes = await app.request('/api/local/cloud-login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'e2e-preselect-ws',
          workspaceId: 'ws-2',
        }),
      })
      expect(startRes.status).toBe(200)
      const start = await startRes.json()
      const parsed = new URL(start.authUrl)
      expect(parsed.searchParams.get('workspaceId')).toBe('ws-2')
    })

    test('start omits workspaceId when none provided', async () => {
      // The default sign-in flow leaves workspaceId off so the bridge
      // shows its picker (or auto-mints when the user has only one ws).
      const startRes = await app.request('/api/local/cloud-login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'e2e-no-preselect' }),
      })
      const start = await startRes.json()
      const parsed = new URL(start.authUrl)
      expect(parsed.searchParams.has('workspaceId')).toBe(false)
    })

    test('happy path: explicit workspaceId mints + persists for the chosen ws', async () => {
      // Multi-workspace user picks ws-2 instead of the default ws-1
      // (the user's first membership by createdAt). The minted key, the
      // /complete response, and SHOGO_KEY_INFO must all reflect ws-2.
      const startRes = await app.request('/api/local/cloud-login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'e2e-pick-ws-2',
          deviceName: 'E2E Mac',
          workspaceId: 'ws-2',
        }),
      })
      const start = await startRes.json()

      const mint = await app.request('/api/api-keys/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-2',
          deviceId: 'e2e-pick-ws-2',
          deviceName: 'E2E Mac',
        }),
      })
      const minted = await mint.json()
      expect(minted.workspace?.id).toBe('ws-2')

      const completeRes = await app.request('/api/local/cloud-login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: start.state,
          key: minted.key,
        }),
      })
      expect(completeRes.status).toBe(200)
      const complete = await completeRes.json()
      expect(complete.workspace?.id).toBe('ws-2')

      const info = JSON.parse(localConfig.get('SHOGO_KEY_INFO')!)
      expect(info.workspace?.id).toBe('ws-2')
      expect(info.workspace?.name).toBe('Team')
    })

    test('start ignores cloudUrl in body (env-only contract)', async () => {
      // Even if a stale client sends a cloudUrl in the request body, the
      // server must use process.env.SHOGO_CLOUD_URL.
      const startRes = await app.request('/api/local/cloud-login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'e2e-env-only',
          cloudUrl: 'https://attacker.example',
        }),
      })
      expect(startRes.status).toBe(200)
      const start = await startRes.json()
      expect(start.cloudUrl).toBe(CLOUD_HOST)
      expect(start.authUrl).toStartWith(`${CLOUD_HOST}/auth/local-link?`)
    })

    test('complete rejects unknown state', async () => {
      const res = await app.request('/api/local/cloud-login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: 'not-a-real-state',
          key: 'shogo_sk_bogus',
        }),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.ok).toBe(false)
      expect(data.error).toMatch(/expired state|Unknown/i)
    })

    test('complete rejects malformed key', async () => {
      const start = await app
        .request('/api/local/cloud-login/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'e2e-bad-key' }),
        })
        .then((r) => r.json())

      const res = await app.request('/api/local/cloud-login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: start.state,
          key: 'definitely-not-a-shogo-key',
        }),
      })
      expect(res.status).toBe(400)
    })

    test('state nonce is single-use: second call with same state fails', async () => {
      const start = await app
        .request('/api/local/cloud-login/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'e2e-single-use' }),
        })
        .then((r) => r.json())

      const mint = await app
        .request('/api/api-keys/device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'ws-1', deviceId: 'e2e-single-use' }),
        })
        .then((r) => r.json())

      const first = await app.request('/api/local/cloud-login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: start.state,
          key: mint.key,
        }),
      })
      expect(first.status).toBe(200)

      const second = await app.request('/api/local/cloud-login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: start.state,
          key: mint.key,
        }),
      })
      expect(second.status).toBe(400)
    })

    test('complete rejects a key that fails cloud validation', async () => {
      const start = await app
        .request('/api/local/cloud-login/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'e2e-bad-validate' }),
        })
        .then((r) => r.json())

      // Key has the right shape but doesn't exist in the cloud DB
      const res = await app.request('/api/local/cloud-login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: start.state,
          key: 'shogo_sk_' + 'a'.repeat(64),
        }),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.ok).toBe(false)
      expect(localConfig.has('SHOGO_API_KEY')).toBe(false)
    })
  })

  // ─── Local-mode: signout & heartbeat ─────────────────────────────────

  describe('Signout & heartbeat', () => {
    async function signInHelper(): Promise<string> {
      const start = await app
        .request('/api/local/cloud-login/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'e2e-signed-in' }),
        })
        .then((r) => r.json())
      const mint = await app
        .request('/api/api-keys/device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: 'ws-1',
            deviceId: 'e2e-signed-in',
            deviceAppVersion: '0.1.0',
          }),
        })
        .then((r) => r.json())
      await app.request('/api/local/cloud-login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: start.state,
          key: mint.key,
        }),
      })
      return mint.key
    }

    test('signout wipes local config', async () => {
      await signInHelper()
      expect(localConfig.has('SHOGO_API_KEY')).toBe(true)

      const res = await app.request('/api/local/cloud-login/signout', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(localConfig.has('SHOGO_API_KEY')).toBe(false)
      expect(localConfig.has('SHOGO_KEY_INFO')).toBe(false)
      expect(process.env.SHOGO_API_KEY).toBeUndefined()
      // SHOGO_CLOUD_URL is env-only and is NOT cleared by signout — the
      // operator's process-level configuration must persist across user
      // sign-in/sign-out cycles.
      expect(process.env.SHOGO_CLOUD_URL).toBe(CLOUD_HOST)

      const status = await app.request('/api/local/cloud-login/status').then((r) => r.json())
      expect(status.signedIn).toBe(false)
      expect(status.cloudUrl).toBe(CLOUD_HOST)
    })

    test('heartbeat while signed in bumps lastSeenAt + deviceAppVersion', async () => {
      const key = await signInHelper()
      const row = [...apiKeys.values()].find((r) => r.keyPrefix && r.kind === 'device')!
      row.lastSeenAt = new Date(0)
      row.deviceAppVersion = '0.1.0'

      const res = await app.request('/api/local/cloud-login/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceAppVersion: '0.3.0' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(row.lastSeenAt!.getTime()).toBeGreaterThan(0)
      expect(row.deviceAppVersion).toBe('0.3.0')
      // sanity: key still valid
      expect(key).toStartWith('shogo_sk_')
    })

    test('heartbeat when not signed in returns 401', async () => {
      const res = await app.request('/api/local/cloud-login/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })

    test('remote revoke: heartbeat against a revoked key wipes local config', async () => {
      await signInHelper()
      // Simulate cloud-side revocation (via Devices UI)
      const deviceRow = [...apiKeys.values()].find((r) => r.kind === 'device')!
      deviceRow.revokedAt = new Date()

      const res = await app.request('/api/local/cloud-login/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.revoked).toBe(true)

      // Local credentials are wiped so the UI flips to signed-out on next poll.
      expect(localConfig.has('SHOGO_API_KEY')).toBe(false)
      expect(localConfig.has('SHOGO_KEY_INFO')).toBe(false)
      expect(process.env.SHOGO_API_KEY).toBeUndefined()
    })
  })
})
