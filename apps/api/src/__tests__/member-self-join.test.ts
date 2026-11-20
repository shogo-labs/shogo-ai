// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-455 — a first-time accept must be able to create its own membership.
 *
 * `acceptInvitation` creates the member *before* it marks the invitation
 * accepted (SHO-422, so a refused seat does not burn the link). The self-join
 * branch in `member.hooks.beforeCreate` only matched `status: 'accepted'`, so on
 * a first accept the row was still `pending`, nothing matched, and the request
 * fell through to the role check — a 403 for every brand-new invitee, on both
 * workspace and project invites.
 *
 * These run against a real database because the fix is a query: the branch has
 * to find a `pending` invitation for the caller's email in the right scope, and
 * must not find an expired one.
 *
 * Run one file per invocation (how CI runs apps/api, via run-tests-isolated):
 *   bun --no-env-file --conditions=development test src/__tests__/member-self-join.test.ts
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { TRIAL_MAX_SEATS } from '../config/usage-plans'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma: db } = await import('../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

const { memberHooks } = await import('../generated/member.hooks')
const memberRoutes = await import('../generated/member.routes')
const { Hono } = await import('hono')

memberRoutes.setPrisma(db)
memberRoutes.setMemberHooks(memberHooks)

/** The generated `/api/members` router, with `auth` injected the way the app does. */
function membersApp(userId: string) {
  const app = new Hono()
  app.use('*', async (c: any, next: any) => {
    c.set('auth', { userId })
    await next()
  })
  app.route('/api/members', memberRoutes.createMemberRoutes())
  return app
}

const DAY = 24 * 60 * 60 * 1000

interface World {
  workspaceId: string
  projectId: string
  ownerId: string
}

async function seedWorld(opts: { seats?: number; status?: 'trialing' | 'active' } = {}): Promise<World> {
  const suffix = crypto.randomUUID().slice(0, 8)
  const owner = await db.user.create({ data: { name: 'owner', email: `owner-${suffix}@example.com` } })
  const workspace = await db.workspace.create({
    data: { name: 'Acme', slug: `acme-${suffix}`, kind: 'team' },
  })
  const project = await db.project.create({ data: { name: 'Billing Bot', workspaceId: workspace.id } })
  await db.member.create({ data: { userId: owner.id, workspaceId: workspace.id, role: 'owner' } })

  if (opts.status) {
    await db.subscription.create({
      data: {
        workspaceId: workspace.id,
        stripeSubscriptionId: `sub_${suffix}`,
        stripeCustomerId: `cus_${suffix}`,
        planId: 'business',
        seats: opts.seats ?? 1,
        status: opts.status,
        billingInterval: 'monthly',
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      },
    })
  }

  return { workspaceId: workspace.id, projectId: project.id, ownerId: owner.id }
}

async function newUser(): Promise<{ id: string; email: string }> {
  const suffix = crypto.randomUUID().slice(0, 8)
  return db.user.create({ data: { name: 'invitee', email: `invitee-${suffix}@example.com` } })
}

function invite(
  world: World,
  email: string,
  opts: { projectId?: string; role?: string; status?: string; expiresAt?: Date } = {},
) {
  return db.invitation.create({
    data: {
      email,
      workspaceId: world.workspaceId,
      projectId: opts.projectId ?? null,
      role: (opts.role ?? 'member') as never,
      status: (opts.status ?? 'pending') as never,
      invitedBy: world.ownerId,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * DAY),
    },
  })
}

/** The client's first step: create the membership as the invitee. */
function join(userId: string, body: Record<string, unknown>) {
  return membersApp(userId).request('/api/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, ...body }),
  })
}

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('a first-time accept self-joins from a pending invitation', () => {
  test('a workspace invite creates the member with the invitation role', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    await invite(world, invitee.email, { role: 'admin' })

    const res = await join(invitee.id, { workspaceId: world.workspaceId, role: 'member' })

    expect(res.status).toBe(201)
    const body: any = await res.json()
    // The invitation decides the role, not the body the client sent.
    expect(body.data?.role).toBe('admin')
    const member = await db.member.findFirst({
      where: { userId: invitee.id, workspaceId: world.workspaceId, projectId: null },
    })
    expect(member?.role).toBe('admin')
  })

  test('a project invite creates the project member with the project role', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    await invite(world, invitee.email, { projectId: world.projectId, role: 'viewer' })

    const res = await join(invitee.id, { projectId: world.projectId, role: 'member' })

    expect(res.status).toBe(201)
    const body: any = await res.json()
    expect(body.data?.role).toBe('viewer')
    expect(body.data?.projectId).toBe(world.projectId)
  })

  test('an already-accepted invitation still self-joins (replayed accept)', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    await invite(world, invitee.email, { role: 'admin', status: 'accepted' })

    const res = await join(invitee.id, { workspaceId: world.workspaceId, role: 'member' })

    expect(res.status).toBe(201)
    const body: any = await res.json()
    expect(body.data?.role).toBe('admin')
  })
})

describe('a self-join that must still be refused', () => {
  test('an expired pending invitation grants nothing', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    await invite(world, invitee.email, { expiresAt: new Date(Date.now() - DAY) })

    const res = await join(invitee.id, { workspaceId: world.workspaceId, role: 'member' })

    expect(res.status).toBe(403)
    expect(await db.member.count({ where: { userId: invitee.id } })).toBe(0)
  })

  test('no invitation at all is still a 403', async () => {
    const world = await seedWorld()
    const invitee = await newUser()

    const res = await join(invitee.id, { workspaceId: world.workspaceId, role: 'member' })

    expect(res.status).toBe(403)
    expect(await db.member.count({ where: { userId: invitee.id } })).toBe(0)
  })

  test('an invitation for another workspace does not grant this one', async () => {
    const world = await seedWorld()
    const other = await seedWorld()
    const invitee = await newUser()
    await invite(other, invitee.email, { role: 'admin' })

    const res = await join(invitee.id, { workspaceId: world.workspaceId, role: 'member' })

    expect(res.status).toBe(403)
  })

  test('an existing member is a 409 already_member', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    await db.member.create({ data: { userId: invitee.id, workspaceId: world.workspaceId, role: 'member' } })
    await invite(world, invitee.email, { role: 'admin' })

    const res = await join(invitee.id, { workspaceId: world.workspaceId, role: 'member' })

    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body.error?.code).toBe('already_member')
  })

  test('a trialing workspace at its seat cap still refuses, and the invite stays pending', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS, status: 'trialing' })
    // Fill the remaining seats so the workspace is at the cap.
    for (let i = 1; i < TRIAL_MAX_SEATS; i++) {
      const u = await newUser()
      await db.member.create({ data: { userId: u.id, workspaceId: world.workspaceId, role: 'member' } })
    }
    const invitee = await newUser()
    const invitation = await invite(world, invitee.email, { role: 'admin' })

    const res = await join(invitee.id, { workspaceId: world.workspaceId, role: 'member' })

    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body.error?.code).toBe('trial_seat_limit')
    // SHO-422: a refused seat must not burn the invitee's only link.
    const after = await db.invitation.findUnique({ where: { id: invitation.id } })
    expect(after?.status).toBe('pending')
  })
})
