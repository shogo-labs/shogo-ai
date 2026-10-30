// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-256 acceptance: `/api/workspace-moves/receive/init` creates a real cloud
 * workspace, so it has to obey the same one-free-per-kind rule as
 * `POST /api/workspaces`.
 *
 * Before this, the route only checked that the caller was signed in (which it
 * has to, because the target workspace does not exist yet) and then wrote the
 * `Workspace` row straight through Prisma. Any account could therefore mint
 * unlimited `team` workspaces by calling it, and choose its `instanceSize` from
 * the request body.
 *
 * Runs against a real SQLite database built from the desktop migration history,
 * over the real Hono routes, with the caller's principal injected exactly as the
 * auth middleware does.
 *
 *   bun test apps/api/src/__tests__/sho-256-receive-init-workspace-limit.acceptance.test.ts
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb } from './helpers/channels-test-db'

// Must run before anything imports lib/prisma. Sets SHOGO_LOCAL_MODE=true so the
// client is built for SQLite; each test then says which surface it is testing.
const { dir } = setupChannelsTestDb()

const { Hono } = await import('hono')
const { prisma } = await import('../lib/prisma')
const { workspaceMoveRoutes } = await import('../routes/workspace-moves')
const { workspaceHooks } = await import('../generated/workspace.hooks')

const db = prisma as any

let principalUserId = ''
const app = new Hono()
app.use('*', async (c, next) => {
  c.set('auth', { userId: principalUserId, isAuthenticated: true, via: 'session' } as any)
  await next()
})
app.route('/api/workspace-moves', workspaceMoveRoutes())

/** `receive/init` exactly as the other side of a link calls it. */
function init(body: Record<string, unknown>) {
  return app.fetch(
    new Request('http://local/api/workspace-moves/receive/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceWorkspaceId: 'ws-never-seen-here', name: 'Moved workspace', ...body }),
    }),
  )
}

let seq = 0
async function makeUser(): Promise<string> {
  seq += 1
  const user = await db.user.create({
    data: { id: `u-sho256-${seq}`, email: `sho256-${seq}-${Date.now()}@example.com`, name: `Owner ${seq}` },
  })
  return user.id
}

/** Give `userId` an owned workspace of `kind`, i.e. spend that free allowance. */
async function giveOwnedWorkspace(userId: string, kind: 'personal' | 'team'): Promise<string> {
  seq += 1
  const workspace = await db.workspace.create({
    data: { name: `${kind} of ${userId}`, slug: `${kind}-${userId}-${seq}`, kind },
  })
  await db.member.create({ data: { userId, workspaceId: workspace.id, role: 'owner', isBillingAdmin: true } })
  return workspace.id
}

async function ownedWorkspaceCount(userId: string): Promise<number> {
  return db.member.count({ where: { userId, role: 'owner', projectId: null } })
}

beforeEach(() => {
  // `setupChannelsTestDb` leaves this set for the SQLite client it built.
  delete process.env.SHOGO_LOCAL_MODE
  principalUserId = ''
})

afterAll(() => {
  delete process.env.SHOGO_LOCAL_MODE
  rmSync(dir, { recursive: true, force: true })
})

describe('on the cloud, receive/init applies the create rule', () => {
  test('a free user who already owns a team workspace is refused, and nothing is written', async () => {
    const userId = await makeUser()
    await giveOwnedWorkspace(userId, 'team')
    principalUserId = userId
    const before = await ownedWorkspaceCount(userId)

    const res = await init({ name: 'Sneaky second workspace', instanceSize: 'xlarge' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('workspace_limit_reached')
    expect(body.error.message).toMatch(/paid subscription/)

    expect(await ownedWorkspaceCount(userId)).toBe(before)
    expect(await db.workspace.count({ where: { name: 'Sneaky second workspace' } })).toBe(0)
  })

  test('the refusal is the same code and message POST /api/workspaces returns', async () => {
    const userId = await makeUser()
    await giveOwnedWorkspace(userId, 'team')
    principalUserId = userId

    const res = await init({ name: 'Second workspace' })
    const fromRoute = ((await res.json()) as any).error

    const fromHook = await workspaceHooks.beforeCreate!(
      { name: 'Second workspace', kind: 'team' },
      { body: {}, params: {}, query: {}, userId, prisma: db } as any,
    )
    expect(fromHook?.ok).toBe(false)
    expect(fromHook?.error).toEqual(fromRoute)
  })

  test('a user with the free team allowance still unspent gets the workspace, at the default size', async () => {
    const userId = await makeUser()
    await giveOwnedWorkspace(userId, 'personal') // the other kind's allowance
    principalUserId = userId

    const res = await init({ name: 'Moved to cloud', instanceSize: 'xlarge' })
    expect(res.status).toBe(201)
    const created = (await res.json()) as any

    const workspace = await db.workspace.findUnique({ where: { id: created.workspaceId } })
    expect(workspace.kind).toBe('team')
    // The size is not the caller's to choose (SHO-256).
    expect(workspace.instanceSize).toBe('micro')

    const owner = await db.member.findFirst({ where: { workspaceId: created.workspaceId, userId } })
    expect(owner.role).toBe('owner')
  })

  test('a user with no workspace at all gets the first one', async () => {
    const userId = await makeUser()
    principalUserId = userId
    const res = await init({ name: 'First cloud workspace' })
    expect(res.status).toBe(201)
  })

  test('an anonymous caller is still refused before anything is created', async () => {
    const res = await init({ name: 'No principal' })
    expect(res.status).toBe(401)
  })
})

describe('on the desktop, receive/init stays unlimited', () => {
  test('a user who already owns a team workspace can still receive one', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    const userId = await makeUser()
    await giveOwnedWorkspace(userId, 'team')
    await giveOwnedWorkspace(userId, 'team')
    principalUserId = userId

    const res = await init({ name: 'Moved to desktop' })
    expect(res.status).toBe(201)
  })
})
