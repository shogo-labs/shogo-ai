// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "No access to this workspace" is the wrong answer for a workspace the caller
 * owns on their own machine (SHO-241 §B).
 *
 * Before the first sync finishes the cloud holds no `Workspace` row and no
 * `Member` row for a machine workspace, so every read answered
 * `403 No access to this workspace` — unactionable, and it sent people looking
 * for a permissions problem that did not exist. The guard rewrites exactly that
 * answer, for exactly the workspaces one of the caller's machines says it holds,
 * into `409 machine_copy_pending` plus the instance the read should go through.
 *
 * Everything else keeps its own answer, which is most of what this file checks:
 * a real permission answer, a workspace that is not on any machine, and writes.
 *
 *   bun test apps/api/src/lib/__tests__/machine-copy-pending.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

const db = {
  instances: [] as Array<{ id: string; metadata: unknown }>,
  workspaces: [] as Array<{ id: string }>,
  instanceQueries: 0,
}

const mockPrisma: any = {
  instance: {
    findMany: async () => {
      db.instanceQueries++
      return db.instances
    },
  },
  workspace: {
    findUnique: async ({ where }: any) =>
      db.workspaces.find((row) => row.id === where.id) ?? null,
  },
}

mock.module('../prisma', () => withPrismaExports({ prisma: mockPrisma }))

const { machineCopyPendingGuard, invalidatePendingMachineWorkspaceIds } = await import(
  '../machine-copy-pending.ts'
)

/** One machine holding one workspace, as its heartbeat reported it. */
function machineHolds(instanceId: string, workspaceId: string) {
  db.instances.push({
    id: instanceId,
    metadata: {
      machine: {
        id: `device-${instanceId}`,
        workspaces: [{ id: workspaceId, name: 'Samsara', kind: 'personal' }],
      },
    },
  })
}

/**
 * The app under test: a route that answers whatever the caller asked for, so the
 * guard is exercised on its own rather than through a real handler's decisions.
 */
function appAnswering(status: number, body: unknown) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { userId: 'user-1' })
    await next()
  })
  app.use('/api/*', machineCopyPendingGuard())
  app.all('/api/*', (c) => c.json(body, status as any))
  return app
}

beforeEach(() => {
  db.instances = []
  db.workspaces = []
  db.instanceQueries = 0
  invalidatePendingMachineWorkspaceIds()
})

describe('a read of a machine workspace the cloud has no copy of', () => {
  test('is answered 409 machine_copy_pending, naming the instance to read through', async () => {
    machineHolds('inst-1', 'ws-local-1')
    const app = appAnswering(403, {
      error: { code: 'forbidden', message: 'No access to this workspace' },
    })

    const res = await app.request('/api/workspaces/ws-local-1/conversations')

    expect(res.status).toBe(409)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('machine_copy_pending')
    expect(body.error.instanceId).toBe('inst-1')
    expect(body.error.workspaceId).toBe('ws-local-1')
    // The message has to say what to do, or the client has nothing to act on.
    expect(body.error.message).toContain('machine relay')
  })

  test('is answered the same way when the route phrased it as "not a member"', async () => {
    machineHolds('inst-1', 'ws-local-1')
    const app = appAnswering(403, {
      error: { message: 'You are not a member of this workspace' },
    })

    const res = await app.request('/api/workspaces/ws-local-1/projects')

    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('machine_copy_pending')
  })

  test('is found from a resource id as well as from the workspace path', async () => {
    machineHolds('inst-1', 'ws-local-1')
    // A project route resolves the workspace through the row, which the mock
    // answers with nothing — so the query parameter is the way in here.
    const app = appAnswering(403, { error: { message: 'No access to this workspace' } })

    const res = await app.request('/api/projects?workspaceId=ws-local-1')

    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.instanceId).toBe('inst-1')
  })
})

describe('everything else keeps the answer it gave', () => {
  test('a workspace that is not in any machine snapshot is left alone', async () => {
    machineHolds('inst-1', 'ws-local-1')
    const app = appAnswering(403, { error: { message: 'No access to this workspace' } })

    const res = await app.request('/api/workspaces/someone-elses/conversations')

    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBeUndefined()
  })

  test('a copy that does exist keeps its real permission answer', async () => {
    machineHolds('inst-1', 'ws-local-1')
    // The row is there: the caller is simply not allowed. That is not a sync
    // problem and must not be dressed up as one.
    db.workspaces.push({ id: 'ws-local-1' })
    const app = appAnswering(403, { error: { message: 'No access to this workspace' } })

    const res = await app.request('/api/workspaces/ws-local-1/conversations')

    expect(res.status).toBe(403)
  })

  test("a route's own 403 wording is not rewritten", async () => {
    machineHolds('inst-1', 'ws-local-1')
    const app = appAnswering(403, { error: { message: 'Only an owner can archive this workspace' } })

    const res = await app.request('/api/workspaces/ws-local-1/conversations')

    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.message).toBe('Only an owner can archive this workspace')
  })

  test('a write is left to fail: there is nowhere else to send it', async () => {
    machineHolds('inst-1', 'ws-local-1')
    const app = appAnswering(403, { error: { message: 'No access to this workspace' } })

    const res = await app.request('/api/workspaces/ws-local-1/conversations', { method: 'POST' })

    expect(res.status).toBe(403)
  })

  test('a successful read never pays for the lookup', async () => {
    machineHolds('inst-1', 'ws-local-1')
    const app = appAnswering(200, { items: [] })

    const res = await app.request('/api/workspaces/ws-local-1/conversations')

    expect(res.status).toBe(200)
    expect(db.instanceQueries).toBe(0)
  })
})

describe('the guard is mounted, and after the write guard', () => {
  test('server.ts runs it on every /api route', () => {
    const server = readFileSync(join(import.meta.dir, '..', '..', 'server.ts'), 'utf8')
    expect(server).toContain("app.use('/api/*', machineCopyPendingGuard())")
    // The write guard answers first: a write has nowhere else to go, so it must
    // not be rewritten into a "read it from the machine" answer.
    const writeAt = server.indexOf("app.use('/api/*', machineWorkspaceWriteGuard())")
    const pendingAt = server.indexOf("app.use('/api/*', machineCopyPendingGuard())")
    expect(writeAt).toBeGreaterThan(0)
    expect(pendingAt).toBeGreaterThan(writeAt)
  })
})

describe('the snapshot map is cached per person', () => {
  test('a second read reuses the first lookup, and invalidation clears it', async () => {
    machineHolds('inst-1', 'ws-local-1')
    const app = appAnswering(403, { error: { message: 'No access to this workspace' } })

    await app.request('/api/workspaces/ws-local-1/conversations')
    await app.request('/api/workspaces/ws-local-1/conversations')
    expect(db.instanceQueries).toBe(1)

    invalidatePendingMachineWorkspaceIds('user-1')
    await app.request('/api/workspaces/ws-local-1/conversations')
    expect(db.instanceQueries).toBe(2)
  })

  test('a machine with no workspace list contributes nothing', async () => {
    db.instances.push({ id: 'inst-1', metadata: { machine: { id: 'device-1' } } })
    const app = appAnswering(403, { error: { message: 'No access to this workspace' } })

    const res = await app.request('/api/workspaces/ws-local-1/conversations')

    expect(res.status).toBe(403)
  })
})
