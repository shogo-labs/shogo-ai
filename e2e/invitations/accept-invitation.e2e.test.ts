// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Accepting an emailed invitation, end to end through the domain action.
 *
 * `acceptInvitation` is the one accept path — the accept page, the sidebar and
 * the pending-invitations hook all call it. It creates the member first and
 * marks the invitation accepted second (SHO-422, so a refused seat does not
 * burn the link). SHO-455 was that the member hook only matched an *accepted*
 * invitation, so a first accept found nothing and 403'd, and that an existing
 * member was a hard failure that left the invite pending forever.
 *
 * This drives the real action against the real invitation/member routes over
 * HTTP, so the hook, the route status mapping and the action's error handling
 * are all exercised together.
 *
 *   bun --no-env-file --conditions=development test e2e/invitations/accept-invitation.e2e.test.ts
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../apps/api/src/__tests__/helpers/channels-test-db'
import { createDomainActions } from '../../packages/domain-stores/src/domain-actions'
import { TRIAL_MAX_SEATS } from '../../apps/api/src/config/usage-plans'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../../apps/api/src/lib/prisma')
// `setupChannelsTestDb()` turns local mode on so `lib/prisma` builds a SQLite
// client against the replayed migration history. Turn it off again *before*
// `billing.service` is imported (it is pulled in by the hooks below), so its
// module-level `isLocalMode` is false and the trial seat guard really runs.
delete process.env.SHOGO_LOCAL_MODE

const { invitationHooks } = await import('../../apps/api/src/generated/invitation.hooks')
const { memberHooks } = await import('../../apps/api/src/generated/member.hooks')
const invitationRoutes = await import('../../apps/api/src/generated/invitation.routes')
const memberRoutes = await import('../../apps/api/src/generated/member.routes')

const db = prisma as any

invitationRoutes.setPrisma(prisma as any)
invitationRoutes.setInvitationHooks(invitationHooks as any)
memberRoutes.setPrisma(prisma as any)
memberRoutes.setMemberHooks(memberHooks as any)

/** The API surface the accept path touches, mounted the way `server.ts` mounts it. */
const app = new Hono()
app.use('/api/*', async (c, next) => {
  const userId = c.req.header('x-user')
  if (userId) c.set('auth' as never, { userId, isAuthenticated: true } as never)
  await next()
})
app.route('/api/invitations', invitationRoutes.createInvitationRoutes())
app.route('/api/members', memberRoutes.createMemberRoutes())

async function call(user: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      'x-user': user,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

/**
 * The slice of the domain store `acceptInvitation` uses, backed by the routes
 * above. Same shape the real MST collections expose, so the action runs
 * unmodified.
 */
function makeStore(userId: string) {
  const loaded = new Map<string, any>()
  return {
    invitationCollection: {
      get: (id: string) => loaded.get(id),
      loadById: async (id: string) => {
        const res = await call(userId, 'GET', `/invitations/${id}`)
        if (res.status === 200 && res.json?.data) loaded.set(id, res.json.data)
        return loaded.get(id)
      },
      update: async (id: string, changes: any) => {
        const res = await call(userId, 'PATCH', `/invitations/${id}`, changes)
        if (res.status !== 200) {
          throw Object.assign(new Error(res.json?.error?.message ?? 'Update failed'), {
            status: res.status,
            details: res.json,
          })
        }
        return res.json.data
      },
    },
    memberCollection: {
      create: async (input: any) => {
        const res = await call(userId, 'POST', '/members', input)
        if (res.status !== 201) {
          throw Object.assign(new Error(res.json?.error?.message ?? 'Create failed'), {
            status: res.status,
            details: res.json,
          })
        }
        return res.json.data
      },
    },
  }
}

const DAY = 24 * 60 * 60 * 1000

interface World {
  workspaceId: string
  projectId: string
  owner: { id: string; email: string }
}

async function seedWorld(opts: { seats?: number; status?: 'trialing' | 'active' } = {}): Promise<World> {
  const suffix = randomUUID().slice(0, 8)
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

  return { workspaceId: workspace.id, projectId: project.id, owner }
}

async function newUser(): Promise<{ id: string; email: string }> {
  const suffix = randomUUID().slice(0, 8)
  return db.user.create({ data: { name: 'invitee', email: `invitee-${suffix}@example.com` } })
}

function invite(
  world: World,
  email: string,
  opts: { projectId?: string; role?: string; expiresAt?: Date } = {},
) {
  return db.invitation.create({
    data: {
      email,
      workspaceId: world.workspaceId,
      projectId: opts.projectId ?? null,
      role: (opts.role ?? 'member') as never,
      status: 'pending' as never,
      invitedBy: world.owner.id,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * DAY),
    },
  })
}

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY
})

afterAll(async () => {
  // Let the fire-and-forget join notifications finish before the DB directory
  // goes away, so teardown does not log a spurious "unable to open database".
  await Bun.sleep(250)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('a fresh user accepts an emailed invitation', () => {
  test('workspace invite: member created with the invite role, invite accepted', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    const invitation = await invite(world, invitee.email, { role: 'admin' })

    const actions = createDomainActions(makeStore(invitee.id) as never)
    await actions.acceptInvitation(invitation.id, invitee.id, {
      workspaceId: world.workspaceId,
      role: 'member',
    })

    const member = await db.member.findFirst({
      where: { userId: invitee.id, workspaceId: world.workspaceId, projectId: null },
    })
    expect(member?.role).toBe('admin')
    const after = await db.invitation.findUnique({ where: { id: invitation.id } })
    expect(after?.status).toBe('accepted')
  })

  test('project invite: project member created with the project role', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    const invitation = await invite(world, invitee.email, {
      projectId: world.projectId,
      role: 'viewer',
    })

    const actions = createDomainActions(makeStore(invitee.id) as never)
    await actions.acceptInvitation(invitation.id, invitee.id, {
      workspaceId: world.workspaceId,
      role: 'viewer',
      projectId: world.projectId,
    })

    const member = await db.member.findFirst({
      where: { userId: invitee.id, projectId: world.projectId },
    })
    expect(member?.role).toBe('viewer')
    const after = await db.invitation.findUnique({ where: { id: invitation.id } })
    expect(after?.status).toBe('accepted')
  })
})

describe('a user who is already a member accepts', () => {
  test('the accept resolves and the invitation is consumed', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    await db.member.create({
      data: { userId: invitee.id, workspaceId: world.workspaceId, role: 'member' },
    })
    const invitation = await invite(world, invitee.email, { role: 'admin' })

    const actions = createDomainActions(makeStore(invitee.id) as never)
    // Used to reject with the raw "User is already a member" hook string.
    await actions.acceptInvitation(invitation.id, invitee.id, {
      workspaceId: world.workspaceId,
      role: 'member',
    })

    const after = await db.invitation.findUnique({ where: { id: invitation.id } })
    expect(after?.status).toBe('accepted')
    // The existing membership is untouched — no second row, no role change.
    const members = await db.member.findMany({
      where: { userId: invitee.id, workspaceId: world.workspaceId, projectId: null },
    })
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe('member')
  })
})

describe('an accept that must still be refused', () => {
  test('a trialing workspace at its seat cap rejects and leaves the invite pending', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS, status: 'trialing' })
    for (let i = 1; i < TRIAL_MAX_SEATS; i++) {
      const u = await newUser()
      await db.member.create({ data: { userId: u.id, workspaceId: world.workspaceId, role: 'member' } })
    }
    const invitee = await newUser()
    const invitation = await invite(world, invitee.email, { role: 'admin' })

    const actions = createDomainActions(makeStore(invitee.id) as never)
    await expect(
      actions.acceptInvitation(invitation.id, invitee.id, {
        workspaceId: world.workspaceId,
        role: 'member',
      }),
    ).rejects.toThrow(/seats/i)

    const after = await db.invitation.findUnique({ where: { id: invitation.id } })
    expect(after?.status).toBe('pending')
    expect(await db.member.count({ where: { userId: invitee.id } })).toBe(0)
  })

  test('an expired invite cannot be accepted', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    const invitation = await invite(world, invitee.email, {
      expiresAt: new Date(Date.now() - DAY),
    })

    const actions = createDomainActions(makeStore(invitee.id) as never)
    await expect(
      actions.acceptInvitation(invitation.id, invitee.id, {
        workspaceId: world.workspaceId,
        role: 'member',
      }),
    ).rejects.toThrow()

    expect(await db.member.count({ where: { userId: invitee.id } })).toBe(0)
  })
})

describe('the invitation routes answer with the codes the client maps on', () => {
  test('an admin accepting someone else\'s invite gets 403 wrong_account', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    const invitation = await invite(world, invitee.email)

    const res = await call(world.owner.id, 'PATCH', `/invitations/${invitation.id}`, {
      status: 'accepted',
    })

    expect(res.status).toBe(403)
    expect(res.json.error?.code).toBe('wrong_account')
    expect(res.json.error?.message).not.toContain('Admins can only cancel')
  })

  test('inviting an existing member is a 409 already_member', async () => {
    const world = await seedWorld()
    const invitee = await newUser()
    await db.member.create({
      data: { userId: invitee.id, workspaceId: world.workspaceId, role: 'member' },
    })

    const res = await call(world.owner.id, 'POST', '/invitations', {
      email: invitee.email,
      workspaceId: world.workspaceId,
      role: 'member',
    })

    expect(res.status).toBe(409)
    expect(res.json.error?.code).toBe('already_member')
  })
})
