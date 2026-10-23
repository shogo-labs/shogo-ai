// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /api/instances` — the two lists it answers (SHO-87).
 *
 *   - default (`?workspaceId=`): the machines filed under one cloud workspace,
 *     which is what a project's runtime picker asks for.
 *   - `?scope=owner`: every machine this user registered, whichever workspace is
 *     open — Settings → Remote control, which has to agree with the workspace
 *     switcher (`GET /api/machines`).
 *
 * Each row also carries `workspaceName` so Settings can say where a machine's
 * key was issued. That is information only: one tunnel serves them all.
 *
 *   bun test apps/api/src/__tests__/instances-list.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'

type Instance = {
  id: string
  workspaceId: string
  userId: string | null
  hostname: string
  name: string
  os: string | null
  arch: string | null
  lastSeenAt: Date
  metadata: any
  wsRequestedAt: Date | null
}

const instancesById = new Map<string, Instance>()
const workspaceNames = new Map<string, string>()
const members = new Set<string>()

const memberKey = (userId: string, workspaceId: string) => `${userId}::${workspaceId}`

const mockPrisma = {
  instance: {
    findUnique: async (args: any) => {
      const inst = instancesById.get(args.where.id)
      return inst ? { ...inst } : null
    },
    findMany: async (args: any) => {
      const where = args?.where ?? {}
      return [...instancesById.values()]
        .filter((i) => (where.workspaceId === undefined ? true : i.workspaceId === where.workspaceId))
        .filter((i) => (where.userId === undefined ? true : i.userId === where.userId))
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .map((i) => ({ ...i }))
    },
  },
  workspace: {
    findMany: async (args: any) => {
      const ids: string[] = args?.where?.id?.in ?? []
      return ids
        .filter((id) => workspaceNames.has(id))
        .map((id) => ({ id, name: workspaceNames.get(id) as string }))
    },
  },
  member: {
    findFirst: async (args: any) =>
      members.has(memberKey(args.where.userId, args.where.workspaceId))
        ? { role: 'member', projectId: null, isBillingAdmin: false }
        : null,
    findMany: async ({ where }: any) =>
      members.has(memberKey(where.userId, where.OR?.[0]?.workspaceId))
        ? [{ role: 'member', projectId: null, isBillingAdmin: false }]
        : [],
  },
  user: { findUnique: async () => ({ role: 'user' }) },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => {},
  sendPushToUser: async () => {},
}))

const { instanceRoutes, _testing } = await import('../routes/instances')

const OWNER = { id: 'u-1', userId: 'u-1', email: 'u@x', role: 'member' }
const OTHER = { id: 'u-2', userId: 'u-2', email: 'o@x', role: 'member' }

function buildApp(auth: any = OWNER) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    ;(c as any).set('auth', auth)
    await next()
  })
  app.route('/api', instanceRoutes())
  return app
}

function seedInstance(overrides: Partial<Instance> = {}): Instance {
  const inst: Instance = {
    id: 'i-1',
    workspaceId: 'ws-personal',
    userId: 'u-1',
    hostname: 'odin',
    name: 'samasra',
    os: 'win32',
    arch: 'x64',
    lastSeenAt: new Date('2026-10-20T10:00:00.000Z'),
    metadata: {},
    wsRequestedAt: null,
    ...overrides,
  }
  instancesById.set(inst.id, inst)
  return inst
}

beforeEach(() => {
  instancesById.clear()
  workspaceNames.clear()
  members.clear()
  _testing.tunnels.clear()
  _testing.activeViewers.clear()
})

describe('GET /api/instances?scope=owner', () => {
  test('lists every machine the caller registered once, with every workspace it is in', async () => {
    workspaceNames.set('ws-personal', 'Personal')
    workspaceNames.set('ws-team', 'Samsara')
    // One desktop, two tunnels: the same machine filed under both workspaces.
    seedInstance({ id: 'i-personal', workspaceId: 'ws-personal' })
    seedInstance({
      id: 'i-team',
      workspaceId: 'ws-team',
      lastSeenAt: new Date('2026-10-20T11:00:00.000Z'),
    })
    seedInstance({ id: 'i-other', workspaceId: 'ws-team', userId: 'u-2' })

    const res = await buildApp().fetch(new Request('http://x/api/instances?scope=owner'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any

    // One machine, not one per workspace it registered in.
    expect(body.instances).toHaveLength(1)
    const [machine] = body.instances
    expect(machine.id).toBe('i-team')
    expect(machine.workspaceName).toBe('Samsara')
    expect(machine.workspaces).toEqual([
      { id: 'ws-team', name: 'Samsara' },
      { id: 'ws-personal', name: 'Personal' },
    ])
  })

  test('two different machines stay two rows', async () => {
    seedInstance({ id: 'i-odin', workspaceId: 'ws-personal', hostname: 'odin', name: 'samasra' })
    seedInstance({ id: 'i-mac', workspaceId: 'ws-personal', hostname: 'mac', name: 'MacBook' })
    const body = (await (await buildApp().fetch(
      new Request('http://x/api/instances?scope=owner'),
    )).json()) as any
    expect(body.instances.map((i: any) => i.hostname).sort()).toEqual(['mac', 'odin'])
  })

  test('needs no workspaceId and no membership of anyone else’s workspace', async () => {
    seedInstance({ id: 'i-1', workspaceId: 'ws-elsewhere' })
    const res = await buildApp().fetch(new Request('http://x/api/instances?scope=owner'))
    expect(res.status).toBe(200)
  })

  test('401 without an authenticated user', async () => {
    const app = new Hono()
    app.route('/api', instanceRoutes())
    const res = await app.fetch(new Request('http://x/api/instances?scope=owner'))
    expect(res.status).toBe(401)
  })
})

describe('GET /api/instances?workspaceId=', () => {
  test('still lists only the requested workspace, for the caller', async () => {
    workspaceNames.set('ws-personal', 'Personal')
    workspaceNames.set('ws-team', 'Samsara')
    members.add(memberKey('u-1', 'ws-personal'))
    seedInstance({ id: 'i-personal', workspaceId: 'ws-personal' })
    seedInstance({ id: 'i-team', workspaceId: 'ws-team' })

    const res = await buildApp().fetch(
      new Request('http://x/api/instances?workspaceId=ws-personal'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.instances.map((i: any) => i.id)).toEqual(['i-personal'])
    expect(body.instances[0].workspaceName).toBe('Personal')
  })

  test('400 without workspaceId, 403 without membership', async () => {
    expect((await buildApp().fetch(new Request('http://x/api/instances'))).status).toBe(400)
    seedInstance()
    const forbidden = await buildApp(OTHER).fetch(
      new Request('http://x/api/instances?workspaceId=ws-personal'),
    )
    expect(forbidden.status).toBe(403)
  })
})
