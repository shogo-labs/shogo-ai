// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-454 — inviting people works in the desktop composer, not just in cloud.
 *
 * `local-route-parity.test.ts` proves the four invite routes are *mounted*.
 * This drives the composed app and asserts they actually answer: the dialog's
 * link section (create / read / reset / turn off), its Resend, and the
 * `/invite/<token>` accept page. Before this, `createLocalApp()` mounted
 * `rbacRoutes()` but none of these, so every one of them 404'd in a local team
 * workspace — the desktop/cloud divergence the channel rule forbids.
 *
 * Scope note: every request here arrives through the tunnel header, and
 * `computeAccess` hands a tunnel principal every permission (the cloud proxy
 * already authorized the caller). So this file proves the routes are wired and
 * behave, not who may call them — the policy matrix lives in
 * `__tests__/rbac/guests.integration.test.ts`, which uses session principals.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'shogo-composer-invite-'))
process.env.WORKSPACES_DIR = workspacesDir

const { prisma } = await import('../../lib/prisma')
const { createLocalApp } = await import('../create-local-app')

const db = prisma as any
const app = createLocalApp().app
const suffix = crypto.randomUUID().slice(0, 8)

let userId: string
let workspaceId: string

const as = (init: RequestInit = {}) => ({
  ...init,
  headers: {
    'x-tunnel-auth-user-id': userId,
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  },
})

beforeAll(async () => {
  const user = await db.user.create({ data: { name: 'local', email: `local-${suffix}@example.com` } })
  userId = user.id
  const workspace = await db.workspace.create({
    data: { name: 'Local Team', slug: `composer-invite-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { userId, workspaceId, role: 'owner' } })
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(workspacesDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe('createLocalApp wiring for invite links', () => {
  test('creates a workspace link with a 7-day expiry and reads it back', async () => {
    const created = await app.request(
      '/api/invite-links',
      as({ method: 'POST', body: JSON.stringify({ workspaceId, role: 'member' }) }),
    )
    expect(created.status).toBe(200)
    const link = ((await created.json()) as any).data
    expect(link.workspaceId).toBe(workspaceId)
    expect(link.role).toBe('member')
    const days = (new Date(link.expiresAt).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)

    const list = await app.request(`/api/invite-links?workspaceId=${workspaceId}`, as())
    expect(list.status).toBe(200)
    expect(((await list.json()) as any).items.map((l: any) => l.id)).toContain(link.id)
  })

  test('honours a 30-day and a never-expiring link', async () => {
    const thirty = await app.request(
      '/api/invite-links',
      as({ method: 'POST', body: JSON.stringify({ workspaceId, role: 'viewer', expiresInDays: 30 }) }),
    )
    expect(thirty.status).toBe(200)
    const days = (new Date(((await thirty.json()) as any).data.expiresAt).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)

    const forever = await app.request(
      '/api/invite-links',
      as({ method: 'POST', body: JSON.stringify({ workspaceId, role: 'viewer', expiresInDays: null }) }),
    )
    expect(forever.status).toBe(200)
    expect(((await forever.json()) as any).data.expiresAt).toBeNull()
  })

  test('the accept page reads the link before anyone signs in', async () => {
    const created = await app.request(
      '/api/invite-links',
      as({ method: 'POST', body: JSON.stringify({ workspaceId, role: 'viewer' }) }),
    )
    const token = ((await created.json()) as any).data.token

    // No auth header at all: the page renders before the invitee signs in.
    const info = await app.request(`/api/invite-links/${token}/info`)
    expect(info.status).toBe(200)
    const data = ((await info.json()) as any).data
    expect(data.role).toBe('viewer')
    expect(data.workspaceName).toBe('Local Team')
    expect(data.expired).toBe(false)
  })

  test('turning a link off makes the accept page and accept 404', async () => {
    const created = await app.request(
      '/api/invite-links',
      as({ method: 'POST', body: JSON.stringify({ workspaceId, role: 'viewer' }) }),
    )
    const link = ((await created.json()) as any).data

    const off = await app.request(
      `/api/invite-links/${link.id}`,
      as({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
    )
    expect(off.status).toBe(200)

    expect((await app.request(`/api/invite-links/${link.token}/info`)).status).toBe(404)
    const accept = await app.request(`/api/invite-links/${link.token}/accept`, as({ method: 'POST' }))
    expect(accept.status).toBe(404)
  })

  test('deleting a link (Reset) makes the old token 404', async () => {
    const created = await app.request(
      '/api/invite-links',
      as({ method: 'POST', body: JSON.stringify({ workspaceId, role: 'viewer' }) }),
    )
    const link = ((await created.json()) as any).data

    expect((await app.request(`/api/invite-links/${link.id}`, as({ method: 'DELETE' }))).status).toBe(200)
    expect((await app.request(`/api/invite-links/${link.token}/info`)).status).toBe(404)
  })
})

describe('createLocalApp wiring for invitation resend', () => {
  test('resend reaches the handler and extends the expiry', async () => {
    const invitee = await db.user.create({ data: { name: 'invitee', email: `invitee-${suffix}@example.com` } })
    const invitation = await db.invitation.create({
      data: {
        workspaceId,
        email: invitee.email,
        role: 'member',
        status: 'pending',
        invitedBy: userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    const res = await app.request(`/api/invitations/${invitation.id}/resend`, as({ method: 'POST' }))
    // No SMTP in this environment, so the route reports the send failure — but
    // it must be the route's own 502, not a 404 from an unmounted path.
    expect(res.status).toBe(502)
    expect(((await res.json()) as any).error.code).toBe('email_failed')

    const after = await db.invitation.findUnique({ where: { id: invitation.id } })
    const days = (new Date(after.expiresAt).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })

  test('resend refuses an invitation that is no longer pending', async () => {
    const invitee = await db.user.create({ data: { name: 'invitee2', email: `invitee2-${suffix}@example.com` } })
    const invitation = await db.invitation.create({
      data: {
        workspaceId,
        email: invitee.email,
        role: 'member',
        status: 'accepted',
        invitedBy: userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    const res = await app.request(`/api/invitations/${invitation.id}/resend`, as({ method: 'POST' }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('not_pending')
  })
})
