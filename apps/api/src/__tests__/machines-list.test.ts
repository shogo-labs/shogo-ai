// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /api/machines` — one entry per machine, however many cloud workspaces it
 * registered in (SHO-87 §5).
 *
 * A desktop opens a tunnel per stored device key, so `odin` has one `instances`
 * row per workspace it is signed into. The workspace switcher must still show
 * `samasra` once, with every workspace it is in, or the fan-out turns into three
 * identical rows in the sidebar.
 *
 *   bun test apps/api/src/__tests__/machines-list.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
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
  kind: string
  lastSeenAt: Date | null
  metadata: any
  wsRequestedAt: Date | null
}

const rows: Instance[] = []
const workspaceNames = new Map<string, string>()

const mockPrisma = {
  instance: {
    findUnique: async (args: any) => rows.find((r) => r.id === args.where.id) ?? null,
    findMany: async (args: any) => {
      const where = args?.where ?? {}
      return rows
        .filter((r) => (where.userId === undefined ? true : r.userId === where.userId))
        .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))
        .map((r) => ({ ...r }))
    },
    update: async (args: any) => {
      const row = rows.find((r) => r.id === args.where.id)
      if (row) Object.assign(row, args.data)
      return row
    },
  },
  workspace: {
    findMany: async (args: any) => {
      const ids: string[] = args?.where?.id?.in ?? []
      return ids.filter((id) => workspaceNames.has(id)).map((id) => ({ id, name: workspaceNames.get(id) as string }))
    },
  },
  remoteAction: { create: async (args: any) => args.data },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => {},
  sendPushToUser: async () => {},
}))

const { machineRoutes, _testing } = await import('../routes/machines')

const OWNER = { id: 'u-1', userId: 'u-1', email: 'owner@x', role: 'member' }

function buildApp(auth: any = OWNER) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    ;(c as any).set('auth', auth)
    await next()
  })
  app.route('/api', machineRoutes())
  return app
}

function seed(overrides: Partial<Instance> = {}): Instance {
  const row: Instance = {
    id: 'i-1',
    workspaceId: 'ws-personal',
    userId: 'u-1',
    hostname: 'odin',
    name: 'samasra',
    os: 'win32',
    arch: 'x64',
    kind: 'desktop',
    lastSeenAt: new Date('2026-10-20T10:00:00.000Z'),
    metadata: {},
    wsRequestedAt: null,
    ...overrides,
  }
  rows.push(row)
  return row
}

beforeEach(() => {
  rows.length = 0
  workspaceNames.clear()
  _testing.resetWakeDeadlineMs()
  _testing.setWakeDeadlineMs(120)
})

describe('GET /api/machines', () => {
  test('one machine, with every workspace it registered in', async () => {
    workspaceNames.set('ws-personal', 'Personal')
    workspaceNames.set('ws-odin', 'Odin AI')
    workspaceNames.set('ws-samsara', 'Samsara')
    seed({ id: 'i-personal', workspaceId: 'ws-personal' })
    seed({
      id: 'i-odin',
      workspaceId: 'ws-odin',
      lastSeenAt: new Date('2026-10-20T11:00:00.000Z'),
    })
    seed({ id: 'i-samsara', workspaceId: 'ws-samsara' })

    const res = await buildApp().fetch(new Request('http://x/api/machines'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any

    expect(body.machines).toHaveLength(1)
    const [machine] = body.machines
    // The most recently seen row represents the machine.
    expect(machine.id).toBe('i-odin')
    expect(machine.hostname).toBe('odin')
    expect(machine.workspaces.map((w: any) => w.name).sort()).toEqual([
      'Odin AI',
      'Personal',
      'Samsara',
    ])
  })

  test('two machines stay two entries', async () => {
    seed({ id: 'i-odin', hostname: 'odin' })
    seed({ id: 'i-mac', hostname: 'mac', name: 'MacBook' })
    const body = (await (await buildApp().fetch(new Request('http://x/api/machines'))).json()) as any
    expect(body.machines.map((m: any) => m.hostname).sort()).toEqual(['mac', 'odin'])
  })

  test('another member of the same workspace sees nothing', async () => {
    seed()
    const body = (await (await buildApp({ id: 'u-2', userId: 'u-2', role: 'member' }).fetch(
      new Request('http://x/api/machines'),
    )).json()) as any
    expect(body.machines).toEqual([])
  })
})
