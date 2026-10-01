// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-workspace device keys for desktop cloud workspaces:
 *   - approve with `allWorkspaces` mints one key per team workspace and the
 *     poll hands them all to the desktop
 *   - POST /api/cli/device-keys/sync adds keys for new memberships, revokes
 *     keys for workspaces the user left, and never touches the primary key
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

interface KeyRow {
  id: string
  keyHash: string
  workspaceId: string
  userId: string
  kind: string
  deviceId: string | null
  deviceName: string | null
  devicePlatform: string | null
  deviceAppVersion: string | null
  revokedAt: Date | null
  [k: string]: unknown
}

const keys = new Map<string, KeyRow>()
let members: Array<{ id: string; userId: string; workspaceId: string; createdAt: Date }> = []
const workspaces = new Map([
  ['ws-personal', { id: 'ws-personal', name: 'Personal', slug: 'personal', kind: 'personal' }],
  ['ws-acme', { id: 'ws-acme', name: 'Acme', slug: 'acme', kind: 'team' }],
  ['ws-beta', { id: 'ws-beta', name: 'Beta', slug: 'beta', kind: 'team' }],
  ['ws-new', { id: 'ws-new', name: 'New Team', slug: 'new', kind: 'team' }],
])
let n = 0

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'in' in v) return v.in.includes(row[k])
    return row[k] === v
  })
}

const prisma: any = {
  apiKey: {
    create: async ({ data }: any) => {
      const row: KeyRow = { id: `key-${++n}`, revokedAt: null, deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null, ...data }
      keys.set(row.id, row)
      return { ...row }
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const r of keys.values()) if (matches(r, where)) { Object.assign(r, data); count++ }
      return { count }
    },
    findMany: async ({ where }: any) => [...keys.values()].filter((r) => matches(r, where)).map((r) => ({ ...r })),
    findUnique: async ({ where }: any) => [...keys.values()].find((r) => r.keyHash === where.keyHash) ?? null,
  },
  member: {
    findFirst: async ({ where }: any) => members.find((m) => matches(m, where)) ?? null,
    findMany: async ({ where }: any) =>
      members
        .filter((m) => m.userId === where.userId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((m) => ({ workspace: workspaces.get(m.workspaceId) ?? null })),
  },
  workspace: { findUnique: async ({ where }: any) => workspaces.get(where.id) ?? null },
  user: { findUnique: async () => ({ id: 'user-1', email: 'russ@example.com' }) },
  $transaction: async (fn: any) => fn(prisma),
}

mock.module('../lib/prisma', () => ({ prisma }))

const { cliAuthRoutes, _testing } = await import('../routes/cli-auth')
const { hashApiKey } = await import('../lib/api-keys-mint')

function app(auth: Record<string, unknown>): Hono {
  const a = new Hono()
  a.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  a.route('/api', cliAuthRoutes())
  return a
}

const device = { deviceId: 'desktop-abcdef', deviceName: 'Russ Mac', devicePlatform: 'darwin-arm64', deviceAppVersion: 'shogo-desktop/1.0.0' }
const live = () => [...keys.values()].filter((k) => !k.revokedAt)

async function signIn(allWorkspaces: boolean) {
  const start = await app({}).request('/api/cli/login/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...device, clientHint: 'desktop' }),
  })
  const { state } = await start.json()
  const approve = await app({ userId: 'user-1' }).request('/api/cli/login/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, workspaceId: 'ws-personal', allWorkspaces }),
  })
  expect(approve.status).toBe(200)
  return (await app({}).request(`/api/cli/login/poll?state=${state}`)).json()
}

async function sync(primaryKey: string, have: string[]) {
  return app({ userId: 'user-1', via: 'apiKey' }).request('/api/cli/device-keys/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${primaryKey}` },
    body: JSON.stringify({ have }),
  })
}

beforeEach(() => {
  keys.clear()
  _testing.pendingStates.clear()
  n = 0
  members = [
    { id: 'm1', userId: 'user-1', workspaceId: 'ws-personal', createdAt: new Date('2026-01-01') },
    { id: 'm2', userId: 'user-1', workspaceId: 'ws-acme', createdAt: new Date('2026-02-01') },
    { id: 'm3', userId: 'user-1', workspaceId: 'ws-beta', createdAt: new Date('2026-03-01') },
  ]
})

describe('approve with allWorkspaces', () => {
  it('mints one key per team workspace and returns them from poll', async () => {
    const poll = await signIn(true)
    expect(poll.status).toBe('approved')
    expect(poll.key).toStartWith('shogo_sk_')
    expect(poll.workspaces.map((w: any) => w.workspace.id)).toEqual(['ws-acme', 'ws-beta'])
    for (const w of poll.workspaces) expect(w.key).toStartWith('shogo_sk_')

    expect(live().map((k) => k.workspaceId).sort()).toEqual(['ws-acme', 'ws-beta', 'ws-personal'])
    for (const k of live()) expect(k).toMatchObject({ kind: 'device', deviceId: device.deviceId })
  })

  it('without the option only the primary key is minted', async () => {
    const poll = await signIn(false)
    expect(poll.workspaces).toBeUndefined()
    expect(live().map((k) => k.workspaceId)).toEqual(['ws-personal'])
  })
})

describe('POST /api/cli/device-keys/sync', () => {
  it('adds keys for new memberships and revokes keys for workspaces the user left', async () => {
    const poll = await signIn(true)
    members = members.filter((m) => m.workspaceId !== 'ws-beta')
    members.push({ id: 'm4', userId: 'user-1', workspaceId: 'ws-new', createdAt: new Date('2026-04-01') })

    const res = await sync(poll.key, ['ws-acme', 'ws-beta'])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workspaces.map((w: any) => [w.workspace.id, !!w.key])).toEqual([
      ['ws-acme', false],
      ['ws-new', true],
    ])
    expect(body.removed).toEqual(['ws-beta'])
    expect(live().map((k) => k.workspaceId).sort()).toEqual(['ws-acme', 'ws-new', 'ws-personal'])
  })

  it('keeps the primary key for a personal workspace', async () => {
    const poll = await signIn(true)
    await sync(poll.key, ['ws-acme', 'ws-beta'])
    const primary = [...keys.values()].find((k) => k.workspaceId === 'ws-personal')!
    expect(primary.revokedAt).toBeNull()
    expect(await sync(poll.key, [])).toHaveProperty('status', 200)
  })

  it('re-mints a key the desktop claims but the cloud revoked', async () => {
    const poll = await signIn(true)
    for (const k of keys.values()) if (k.workspaceId === 'ws-acme') k.revokedAt = new Date()
    const body = await (await sync(poll.key, ['ws-acme', 'ws-beta'])).json()
    expect(body.workspaces.find((w: any) => w.workspace.id === 'ws-acme').key).toStartWith('shogo_sk_')
  })

  it('requires a device key', async () => {
    const cookie = await app({ userId: 'user-1' }).request('/api/cli/device-keys/sync', { method: 'POST', body: '{}' })
    expect(cookie.status).toBe(401)

    const userKey = 'shogo_sk_userkey'
    keys.set('user-key', {
      id: 'user-key', keyHash: await hashApiKey(userKey), workspaceId: 'ws-acme', userId: 'user-1',
      kind: 'user', deviceId: null, deviceName: null, devicePlatform: null, deviceAppVersion: null, revokedAt: null,
    })
    expect((await sync(userKey, [])).status).toBe(403)
  })
})
