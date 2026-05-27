// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * api-keys route + resolveApiKey — exhaustive unit tests.
 *
 * Mocks prisma + api-keys-mint helpers. In-memory stores for
 * apiKey / member / workspace are reset per test.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type ApiKeyRow = {
  id: string; name: string; keyHash: string; keyPrefix: string
  workspaceId: string; userId: string
  expiresAt: Date | null; revokedAt: Date | null
  kind: 'user' | 'device'
  deviceId: string | null; deviceName: string | null
  devicePlatform: string | null; deviceAppVersion: string | null
  lastUsedAt: Date | null; lastSeenAt: Date | null; createdAt: Date
}
type MemberRow = { userId: string; workspaceId: string; createdAt: Date }
type WorkspaceRow = { id: string; name: string; slug: string }
type UserRow = { id: string; name: string; email: string }

let apiKeys: ApiKeyRow[]
let members: MemberRow[]
let workspaces: Map<string, WorkspaceRow>
let usersMap: Map<string, UserRow>
let updateCalls: any[]
let mintCalls: any[]
let nextId = 0
function gen(p='id'): string { nextId++; return `${p}_${nextId}` }

function project(row: any, select: any) {
  if (!select || !row) return row
  const out: any = {}
  for (const k of Object.keys(select)) {
    if (!select[k]) continue
    if (typeof select[k] === 'object' && select[k] !== null) {
      // relation
      if (k === 'workspace') out.workspace = project(workspaces.get(row.workspaceId) ?? null, select[k].select)
      else if (k === 'user')   out.user      = project(usersMap.get(row.userId) ?? null, select[k].select)
      else out[k] = row[k]
    } else {
      out[k] = row[k]
    }
  }
  return out
}

const prismaStub = {
  $transaction: async (fn: any) => fn(prismaStub),
  member: {
    findFirst: async ({ where, orderBy, select }: any) => {
      let rows = members.filter(m => {
        if (m.userId !== where.userId) return false
        if (where.workspaceId && m.workspaceId !== where.workspaceId) return false
        return true
      })
      if (orderBy?.createdAt === 'asc') rows = [...rows].sort((a,b) => a.createdAt.getTime() - b.createdAt.getTime())
      const r = rows[0] ?? null
      if (!r) return null
      return select ? project(r, select) : r
    },
  },
  workspace: {
    findUnique: async ({ where, select }: any) => {
      const w = workspaces.get(where.id) ?? null
      return select ? project(w, select) : w
    },
  },
  apiKey: {
    create: async ({ data }: any) => {
      const row: ApiKeyRow = {
        id: gen('ak'), keyHash: '', keyPrefix: '', userId: '', workspaceId: '',
        expiresAt: null, revokedAt: null, kind: 'user',
        deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null,
        lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
        name: 'Shogo Local',
        ...data,
      }
      apiKeys.push(row)
      return row
    },
    findUnique: async ({ where, select, include }: any) => {
      let row = where.id
        ? apiKeys.find(k => k.id === where.id)
        : apiKeys.find(k => k.keyHash === where.keyHash)
      if (!row) return null
      if (include) {
        const r: any = { ...row }
        if (include.workspace) r.workspace = project(workspaces.get(row.workspaceId), include.workspace.select)
        if (include.user)      r.user      = project(usersMap.get(row.userId), include.user.select)
        return r
      }
      return select ? project(row, select) : row
    },
    findMany: async ({ where, select, orderBy }: any) => {
      let rows = apiKeys.filter(k => {
        if (where.workspaceId && k.workspaceId !== where.workspaceId) return false
        if (where.revokedAt === null && k.revokedAt !== null) return false
        if (where.kind && k.kind !== where.kind) return false
        return true
      })
      // best-effort sort
      if (Array.isArray(orderBy)) {
        rows = [...rows].sort((a, b) => {
          for (const ob of orderBy) {
            const [k, dir] = Object.entries(ob)[0] as [string, string]
            const av = (a as any)[k]?.getTime?.() ?? -1
            const bv = (b as any)[k]?.getTime?.() ?? -1
            if (av !== bv) return dir === 'desc' ? bv - av : av - bv
          }
          return 0
        })
      }
      return rows.map(r => select ? project(r, select) : r)
    },
    update: async ({ where, data }: any) => {
      updateCalls.push({ where, data })
      const row = apiKeys.find(k => k.id === where.id)
      if (!row) throw new Error('not_found')
      Object.assign(row, data)
      return row
    },
  },
}

let throwMintNext = false
const mintImpl = async (opts: any) => {
  mintCalls.push(opts)
  if (throwMintNext) throw new Error('mint failed')
  const row: ApiKeyRow = {
    id: gen('ak'), name: opts.deviceName ?? opts.defaultDeviceName ?? 'Shogo Desktop',
    keyHash: 'h', keyPrefix: 'pfx_',
    workspaceId: opts.workspaceId, userId: opts.userId,
    expiresAt: null, revokedAt: null, kind: 'device',
    deviceId: opts.deviceId, deviceName: opts.deviceName ?? null,
    devicePlatform: opts.devicePlatform ?? null,
    deviceAppVersion: opts.deviceAppVersion ?? null,
    lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
  }
  apiKeys.push(row)
  return { fullKey: 'shogo_sk_FULL_DEVICE', apiKey: row, keyPrefix: 'pfx_' }
}

mock.module('../../lib/prisma', () => ({ prisma: prismaStub }))
mock.module('../../lib/api-keys-mint', () => ({
  SHOGO_API_KEY_PREFIX: 'shogo_sk_',
  generateApiKey: async () => ({ fullKey: 'shogo_sk_FULL', keyHash: 'hash_generated', keyPrefix: 'shogo_sk_FULL' }),
  hashApiKey: async (k: string) => `H(${k})`,
  mintDeviceApiKey: mintImpl,
}))

import { apiKeyRoutes, resolveApiKey } from '../api-keys'

function app() {
  const { Hono } = require('hono')
  const a = new Hono()
  a.use('*', async (c: any, next: any) => {
    const uid = c.req.header('x-test-user-id')
    if (uid) c.set('auth', { userId: uid, isAuthenticated: true })
    await next()
  })
  a.route('/api', apiKeyRoutes())
  return a
}

beforeEach(() => {
  apiKeys = []
  members = []
  workspaces = new Map()
  usersMap = new Map()
  updateCalls = []
  mintCalls = []
  nextId = 0
  throwMintNext = false
})

// ─── POST /api-keys (user kind) ─────────────────────────────────────────────

describe('POST /api-keys', () => {
  test('401 unauthenticated', async () => {
    const r = await app().request('/api/api-keys', { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
  })

  test('400 when workspaceId missing', async () => {
    const r = await app().request('/api/api-keys', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
  })

  test('403 when not a member of workspace', async () => {
    const r = await app().request('/api/api-keys', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ workspaceId: 'w1' }),
    })
    expect(r.status).toBe(403)
  })

  test('200 happy path with default name + no expiry', async () => {
    members.push({ userId: 'u1', workspaceId: 'w1', createdAt: new Date() })
    const r = await app().request('/api/api-keys', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ workspaceId: 'w1' }),
    })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.key).toBe('shogo_sk_FULL')
    expect(j.kind).toBe('user')
    expect(j.expiresAt).toBeNull()
    expect(apiKeys[0].name).toBe('Shogo Local')
  })

  test('200 with custom name + expiresInDays computes future date', async () => {
    members.push({ userId: 'u1', workspaceId: 'w1', createdAt: new Date() })
    const before = Date.now()
    const r = await app().request('/api/api-keys', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ workspaceId: 'w1', name: 'CI', expiresInDays: 30 }),
    })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.name).toBe('CI')
    const exp = new Date(j.expiresAt).getTime()
    expect(exp).toBeGreaterThan(before + 29*24*3600*1000)
    expect(exp).toBeLessThan(before + 31*24*3600*1000)
  })
})

// ─── POST /api-keys/device ──────────────────────────────────────────────────

describe('POST /api-keys/device', () => {
  test('401 unauthenticated', async () => {
    const r = await app().request('/api/api-keys/device', { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
  })

  test('400 when body JSON is malformed', async () => {
    const r = await app().request('/api/api-keys/device', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: '{broken',
    })
    expect(r.status).toBe(400)
  })

  test('400 when deviceId missing', async () => {
    const r = await app().request('/api/api-keys/device', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
  })

  test('400 when deviceId is not a string', async () => {
    const r = await app().request('/api/api-keys/device', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ deviceId: 42 }),
    })
    expect(r.status).toBe(400)
  })

  test('400 when deviceId is too short (<8 chars)', async () => {
    const r = await app().request('/api/api-keys/device', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ deviceId: 'short' }),
    })
    expect(r.status).toBe(400)
  })

  test('403 when explicit workspaceId + caller not a member', async () => {
    const r = await app().request('/api/api-keys/device', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ workspaceId: 'w1', deviceId: 'dev-12345' }),
    })
    expect(r.status).toBe(403)
  })

  test('200 with explicit workspaceId membership', async () => {
    members.push({ userId: 'u1', workspaceId: 'w1', createdAt: new Date() })
    workspaces.set('w1', { id: 'w1', name: 'Acme', slug: 'acme' })
    const r = await app().request('/api/api-keys/device', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({
        workspaceId: 'w1', deviceId: 'dev-12345678', deviceName: 'MBP',
        devicePlatform: 'darwin', deviceAppVersion: '1.2.3',
      }),
    })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.key).toBe('shogo_sk_FULL_DEVICE')
    expect(j.kind).toBe('device')
    expect(j.workspace.slug).toBe('acme')
    expect(mintCalls[0].deviceId).toBe('dev-12345678')
    expect(mintCalls[0].deviceName).toBe('MBP')
    expect(mintCalls[0].defaultDeviceName).toBe('Shogo Desktop')
  })

  test('404 no_workspace when user has no memberships and no workspaceId given', async () => {
    const r = await app().request('/api/api-keys/device', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ deviceId: 'dev-12345678' }),
    })
    expect(r.status).toBe(404)
    expect((await r.json() as any).error.code).toBe('no_workspace')
  })

  test('200 defaults to user personal workspace (first by createdAt asc)', async () => {
    members.push({ userId: 'u1', workspaceId: 'w_old',  createdAt: new Date(2024, 0, 1) })
    members.push({ userId: 'u1', workspaceId: 'w_new',  createdAt: new Date(2025, 0, 1) })
    workspaces.set('w_old', { id: 'w_old', name: 'Old', slug: 'old' })
    const r = await app().request('/api/api-keys/device', {
      method: 'POST', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ deviceId: 'dev-12345678' }),
    })
    expect(r.status).toBe(200)
    expect(mintCalls[0].workspaceId).toBe('w_old')
  })
})

// ─── GET /api-keys ──────────────────────────────────────────────────────────

describe('GET /api-keys', () => {
  test('401 unauthenticated', async () => {
    const r = await app().request('/api/api-keys')
    expect(r.status).toBe(401)
  })
  test('400 when workspaceId query param missing', async () => {
    const r = await app().request('/api/api-keys', { headers: { 'x-test-user-id': 'u1' } })
    expect(r.status).toBe(400)
  })
  test('403 when not member', async () => {
    const r = await app().request('/api/api-keys?workspaceId=w1', { headers: { 'x-test-user-id': 'u1' } })
    expect(r.status).toBe(403)
  })
  test('200 lists non-revoked keys', async () => {
    members.push({ userId: 'u1', workspaceId: 'w1', createdAt: new Date() })
    usersMap.set('u1', { id: 'u1', name: 'Alice', email: 'a@x.com' })
    apiKeys.push({
      id: 'k1', name: 'Active', keyHash: 'h', keyPrefix: 'pfx',
      workspaceId: 'w1', userId: 'u1', expiresAt: null, revokedAt: null,
      kind: 'user', deviceId: null, deviceName: null, devicePlatform: null,
      deviceAppVersion: null, lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    apiKeys.push({
      id: 'k2', name: 'Revoked', keyHash: 'h2', keyPrefix: 'pfx',
      workspaceId: 'w1', userId: 'u1', expiresAt: null, revokedAt: new Date(),
      kind: 'user', deviceId: null, deviceName: null, devicePlatform: null,
      deviceAppVersion: null, lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await app().request('/api/api-keys?workspaceId=w1', { headers: { 'x-test-user-id': 'u1' } })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.keys.length).toBe(1)
    expect(j.keys[0].id).toBe('k1')
    expect(j.keys[0].user.email).toBe('a@x.com')
  })
  test('200 with kind=device filter', async () => {
    members.push({ userId: 'u1', workspaceId: 'w1', createdAt: new Date() })
    apiKeys.push({ id: 'k1', name: 'U', keyHash: 'h', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1', expiresAt: null, revokedAt: null, kind: 'user',   deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null, lastUsedAt: null, lastSeenAt: null, createdAt: new Date() })
    apiKeys.push({ id: 'k2', name: 'D', keyHash: 'h', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1', expiresAt: null, revokedAt: null, kind: 'device', deviceId: 'd', deviceName: null, devicePlatform: null, deviceAppVersion: null, lastUsedAt: null, lastSeenAt: null, createdAt: new Date() })
    const r = await app().request('/api/api-keys?workspaceId=w1&kind=device', { headers: { 'x-test-user-id': 'u1' } })
    const j = await r.json() as any
    expect(j.keys.length).toBe(1)
    expect(j.keys[0].kind).toBe('device')
  })
  test('200 ignores unknown kind filter', async () => {
    members.push({ userId: 'u1', workspaceId: 'w1', createdAt: new Date() })
    apiKeys.push({ id: 'k1', name: 'U', keyHash: 'h', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1', expiresAt: null, revokedAt: null, kind: 'user',   deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null, lastUsedAt: null, lastSeenAt: null, createdAt: new Date() })
    apiKeys.push({ id: 'k2', name: 'D', keyHash: 'h', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1', expiresAt: null, revokedAt: null, kind: 'device', deviceId: 'd', deviceName: null, devicePlatform: null, deviceAppVersion: null, lastUsedAt: null, lastSeenAt: null, createdAt: new Date() })
    const r = await app().request('/api/api-keys?workspaceId=w1&kind=bogus', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).keys.length).toBe(2)
  })
})

// ─── DELETE /api-keys/:id ──────────────────────────────────────────────────

describe('DELETE /api-keys/:id', () => {
  test('401 unauthenticated', async () => {
    const r = await app().request('/api/api-keys/k1', { method: 'DELETE' })
    expect(r.status).toBe(401)
  })
  test('404 key not found', async () => {
    const r = await app().request('/api/api-keys/missing', { method: 'DELETE', headers: { 'x-test-user-id': 'u1' } })
    expect(r.status).toBe(404)
  })
  test('403 when not member of key.workspaceId', async () => {
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'h', keyPrefix: 'p', workspaceId: 'w1', userId: 'owner',
      expiresAt: null, revokedAt: null, kind: 'user', deviceId: null, deviceName: null,
      devicePlatform: null, deviceAppVersion: null, lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await app().request('/api/api-keys/k1', { method: 'DELETE', headers: { 'x-test-user-id': 'u_other' } })
    expect(r.status).toBe(403)
  })
  test('200 sets revokedAt on the row', async () => {
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'h', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'user', deviceId: null, deviceName: null,
      devicePlatform: null, deviceAppVersion: null, lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    members.push({ userId: 'u1', workspaceId: 'w1', createdAt: new Date() })
    const r = await app().request('/api/api-keys/k1', { method: 'DELETE', headers: { 'x-test-user-id': 'u1' } })
    expect(r.status).toBe(200)
    expect(apiKeys[0].revokedAt).toBeInstanceOf(Date)
  })
})

// ─── POST /api-keys/validate ───────────────────────────────────────────────

describe('POST /api-keys/validate', () => {
  test('400 when key missing', async () => {
    const r = await app().request('/api/api-keys/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
    expect((await r.json() as any).valid).toBe(false)
  })

  test('400 when key has wrong prefix', async () => {
    const r = await app().request('/api/api-keys/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'wrong_prefix_AAA' }),
    })
    expect(r.status).toBe(400)
  })

  test('200 valid:false when key not found', async () => {
    const r = await app().request('/api/api-keys/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_unknown' }),
    })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.valid).toBe(false)
    expect(j.error).toBe('Key not found')
  })

  test('200 valid:false when key revoked', async () => {
    workspaces.set('w1', { id: 'w1', name: 'W', slug: 'w' })
    usersMap.set('u1', { id: 'u1', name: 'A', email: 'a@x.com' })
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: new Date(), kind: 'user', deviceId: null, deviceName: null,
      devicePlatform: null, deviceAppVersion: null, lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await app().request('/api/api-keys/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_x' }),
    })
    expect((await r.json() as any).error).toBe('Key has been revoked')
  })

  test('200 valid:false when key expired', async () => {
    workspaces.set('w1', { id: 'w1', name: 'W', slug: 'w' })
    usersMap.set('u1', { id: 'u1', name: 'A', email: 'a@x.com' })
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: new Date(Date.now() - 1000), revokedAt: null, kind: 'user',
      deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await app().request('/api/api-keys/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_x' }),
    })
    expect((await r.json() as any).error).toBe('Key has expired')
  })

  test('200 valid:true updates lastUsedAt', async () => {
    workspaces.set('w1', { id: 'w1', name: 'W', slug: 'w' })
    usersMap.set('u1', { id: 'u1', name: 'A', email: 'a@x.com' })
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'device',
      deviceId: 'dev-1', deviceName: 'MBP', devicePlatform: 'darwin', deviceAppVersion: '1.0.0',
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await app().request('/api/api-keys/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_x' }),
    })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.valid).toBe(true)
    expect(j.kind).toBe('device')
    expect(j.deviceId).toBe('dev-1')
    expect(j.deviceName).toBe('MBP')
    await new Promise(r => setTimeout(r, 10))
    expect(updateCalls.some(u => u.data.lastUsedAt)).toBe(true)
  })
})

// ─── POST /api-keys/heartbeat ──────────────────────────────────────────────

describe('POST /api-keys/heartbeat', () => {
  test('400 when key missing or malformed JSON', async () => {
    const r = await app().request('/api/api-keys/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{broken',
    })
    expect(r.status).toBe(400)
  })

  test('400 when wrong prefix', async () => {
    const r = await app().request('/api/api-keys/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'bad' }),
    })
    expect(r.status).toBe(400)
  })

  test('401 when key not found', async () => {
    const r = await app().request('/api/api-keys/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_unknown' }),
    })
    expect(r.status).toBe(401)
  })

  test('401 when key revoked', async () => {
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: new Date(), kind: 'device',
      deviceId: 'd', deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await app().request('/api/api-keys/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_x' }),
    })
    expect(r.status).toBe(401)
  })

  test('401 when key expired', async () => {
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: new Date(Date.now() - 1000), revokedAt: null, kind: 'device',
      deviceId: 'd', deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await app().request('/api/api-keys/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_x' }),
    })
    expect(r.status).toBe(401)
  })

  test('200 device key updates lastSeenAt + deviceAppVersion (truncated to 32 chars)', async () => {
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'device',
      deviceId: 'd', deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const longVer = 'v'.repeat(100)
    const r = await app().request('/api/api-keys/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_x', deviceAppVersion: longVer }),
    })
    expect(r.status).toBe(200)
    expect(updateCalls[0].data.lastSeenAt).toBeInstanceOf(Date)
    expect(updateCalls[0].data.deviceAppVersion.length).toBe(32)
  })

  test('200 user key does NOT set deviceAppVersion', async () => {
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'user',
      deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await app().request('/api/api-keys/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_x', deviceAppVersion: 'v1' }),
    })
    expect(r.status).toBe(200)
    expect(updateCalls[0].data.deviceAppVersion).toBeUndefined()
  })
})

// ─── resolveApiKey (exported) ──────────────────────────────────────────────

describe('resolveApiKey', () => {
  test('null when key lacks prefix', async () => {
    expect(await resolveApiKey('nope')).toBeNull()
  })
  test('null when key not found', async () => {
    expect(await resolveApiKey('shogo_sk_unknown')).toBeNull()
  })
  test('null when revoked', async () => {
    apiKeys.push({
      id: 'k', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: new Date(), kind: 'user',
      deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    expect(await resolveApiKey('shogo_sk_x')).toBeNull()
  })
  test('null when expired', async () => {
    apiKeys.push({
      id: 'k', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: new Date(Date.now() - 1), revokedAt: null, kind: 'user',
      deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    expect(await resolveApiKey('shogo_sk_x')).toBeNull()
  })
  test('returns ctx + updates lastUsedAt for user key', async () => {
    apiKeys.push({
      id: 'k', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'user',
      deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await resolveApiKey('shogo_sk_x')
    expect(r).toEqual({ workspaceId: 'w1', userId: 'u1', kind: 'user', deviceId: null })
    await new Promise(r => setTimeout(r, 10))
    expect(updateCalls[0].data.lastUsedAt).toBeInstanceOf(Date)
    expect(updateCalls[0].data.lastSeenAt).toBeUndefined()
  })
  test('device key also bumps lastSeenAt + deviceAppVersion (truncated)', async () => {
    apiKeys.push({
      id: 'k', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'device',
      deviceId: 'dev-1', deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const r = await resolveApiKey('shogo_sk_x', { deviceAppVersion: 'x'.repeat(100) })
    expect(r?.deviceId).toBe('dev-1')
    await new Promise(r => setTimeout(r, 10))
    expect(updateCalls[0].data.lastSeenAt).toBeInstanceOf(Date)
    expect(updateCalls[0].data.deviceAppVersion.length).toBe(32)
  })
  test('device key without deviceAppVersion opt skips that field', async () => {
    apiKeys.push({
      id: 'k', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'device',
      deviceId: 'dev-1', deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    await resolveApiKey('shogo_sk_x')
    await new Promise(r => setTimeout(r, 10))
    expect(updateCalls[0].data.lastSeenAt).toBeInstanceOf(Date)
    expect(updateCalls[0].data.deviceAppVersion).toBeUndefined()
  })
})


// ─── .catch(() => {}) callback coverage ────────────────────────────────────

describe('fire-and-forget catch handlers', () => {
  test('validate swallows prisma.apiKey.update errors', async () => {
    workspaces.set('w1', { id: 'w1', name: 'W', slug: 'w' })
    usersMap.set('u1', { id: 'u1', name: 'A', email: 'a@x.com' })
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'user',
      deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const origUpdate = prismaStub.apiKey.update
    prismaStub.apiKey.update = (async () => { throw new Error('db down') }) as any
    try {
      const r = await app().request('/api/api-keys/validate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'shogo_sk_x' }),
      })
      expect(r.status).toBe(200)
      expect((await r.json() as any).valid).toBe(true)
      await new Promise(r => setTimeout(r, 10))
    } finally {
      prismaStub.apiKey.update = origUpdate
    }
  })

  test('heartbeat swallows prisma.apiKey.update errors', async () => {
    apiKeys.push({
      id: 'k1', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'device',
      deviceId: 'd', deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const origUpdate = prismaStub.apiKey.update
    prismaStub.apiKey.update = (async () => { throw new Error('db down') }) as any
    try {
      const r = await app().request('/api/api-keys/heartbeat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'shogo_sk_x' }),
      })
      expect(r.status).toBe(200)
    } finally {
      prismaStub.apiKey.update = origUpdate
    }
  })

  test('resolveApiKey swallows fire-and-forget update errors', async () => {
    apiKeys.push({
      id: 'k', name: 'K', keyHash: 'H(shogo_sk_x)', keyPrefix: 'p', workspaceId: 'w1', userId: 'u1',
      expiresAt: null, revokedAt: null, kind: 'user',
      deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null,
      lastUsedAt: null, lastSeenAt: null, createdAt: new Date(),
    })
    const origUpdate = prismaStub.apiKey.update
    prismaStub.apiKey.update = (async () => { throw new Error('db down') }) as any
    try {
      const r = await resolveApiKey('shogo_sk_x')
      expect(r?.userId).toBe('u1')
    } finally {
      prismaStub.apiKey.update = origUpdate
    }
    await new Promise(r => setTimeout(r, 10))
  })
})
