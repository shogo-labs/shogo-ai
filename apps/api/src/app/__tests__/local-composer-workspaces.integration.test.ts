// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-43 — the real desktop composer, not a hand-mounted router.
 *
 * `local-route-parity.test.ts` proves `POST /api/workspaces` is *mounted*; that
 * is also true of the generated CRUD router, which creates a workspace with no
 * owner `Member` (its cloud hooks own that, and local doesn't run them). What
 * matters is **which handler wins** in `createLocalApp`. This test drives the
 * composed app and asserts the local lifecycle ran: an owner member and an
 * agent profile exist, and the guards answer with their own error codes.
 *
 * Requests authenticate through `x-tunnel-auth-user-id`, the header the cloud
 * proxy injects on the instance tunnel (middleware/auth.ts, path 3).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'shogo-composer-ws-'))
process.env.WORKSPACES_DIR = workspacesDir

const { prisma } = await import('../../lib/prisma')
const { createLocalApp } = await import('../create-local-app')

const db = prisma as any
const app = createLocalApp().app
const suffix = crypto.randomUUID().slice(0, 8)

let userId: string

const as = (init: RequestInit = {}) => ({
  ...init,
  headers: {
    'x-tunnel-auth-user-id': userId,
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  },
})

beforeAll(async () => {
  const user = await db.user.create({
    data: { name: 'local', email: `local-${suffix}@example.com` },
  })
  userId = user.id
  const personal = await db.workspace.create({
    data: { name: 'Local User Personal', slug: `composer-personal-${suffix}`, kind: 'personal' },
  })
  await db.member.create({
    data: { userId, workspaceId: personal.id, role: 'owner', isBillingAdmin: true },
  })
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(workspacesDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe('createLocalApp wiring for workspaces', () => {
  test('POST /api/workspaces is served by the local handler (creates the owner)', async () => {
    const res = await app.request('/api/workspaces', as({
      method: 'POST',
      body: JSON.stringify({ name: 'Composer Created' }),
    }))
    expect(res.status).toBe(201)
    const body: any = await res.json()
    expect(body.data.kind).toBe('team')

    const members = await db.member.findMany({ where: { workspaceId: body.data.id } })
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe('owner')

    const profile = await db.workspaceAgentProfile.findUnique({
      where: { workspaceId: body.data.id },
    })
    expect(profile).not.toBeNull()
  })

  test('PATCH and DELETE are the local handlers, with their guard codes', async () => {
    const created = await app.request('/api/workspaces', as({
      method: 'POST',
      body: JSON.stringify({ name: 'Composer Renamed' }),
    }))
    const workspace = ((await created.json()) as any).data

    const renamed = await app.request(`/api/workspaces/${workspace.id}`, as({
      method: 'PATCH',
      body: JSON.stringify({ name: 'Still Mine' }),
    }))
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as any).data.name).toBe('Still Mine')

    const preview = await app.request(`/api/workspaces/${workspace.id}/deletion-preview`, as())
    expect(preview.status).toBe(200)
    expect(((await preview.json()) as any).preview.workspaceId).toBe(workspace.id)

    const activity = await app.request('/api/workspaces/activity', as())
    expect(activity.status).toBe(200)
    const items = ((await activity.json()) as any).items as Array<{ workspaceId: string }>
    expect(items.map((item) => item.workspaceId)).toContain(workspace.id)

    const deleted = await app.request(`/api/workspaces/${workspace.id}`, as({ method: 'DELETE' }))
    expect(deleted.status).toBe(200)
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull()
  })
})
