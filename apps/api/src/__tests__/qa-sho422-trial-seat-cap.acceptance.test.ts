// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-422 — a free trial never holds more than TRIAL_MAX_SEATS seats.
 *
 * These are the acceptance criteria that need a real database rather than a
 * prisma double, because they depend on `countActiveWorkspaceMembers` pooling
 * distinct users across a workspace family (parent + children) and on the
 * member hook's own `projectId` branch:
 *
 *   AC2  a trialing workspace at the cap refuses a workspace member join and
 *        creates no row; a project guest still joins (guests use no seat); a
 *        child workspace's join counts against the parent's trial pool; an
 *        active subscription is unaffected
 *   AC3  `syncSeatsFromMembership` never writes a seat count above the cap for
 *        a trialing subscription
 *
 * Order matters below: `setupChannelsTestDb()` turns local mode on so
 * `lib/prisma` builds a SQLite client against the replayed migration history,
 * then local mode is turned off — before `billing.service` is imported — so the
 * module-level `isLocalMode` in that service is false and the guard really runs.
 *
 * Run one file per invocation (how CI runs apps/api, via run-tests-isolated):
 *   bun --no-env-file --conditions=development test src/__tests__/qa-sho422-trial-seat-cap.acceptance.test.ts
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { TRIAL_MAX_SEATS } from '../config/usage-plans'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma: db } = await import('../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

const billing = await import('../services/billing.service')
const { memberHooks } = await import('../generated/member.hooks')

const DAY = 24 * 60 * 60 * 1000

interface World {
  workspaceId: string
  projectId: string
  ownerId: string
  /** `count` distinct users already seated in the workspace. */
  memberIds: string[]
}

async function seedWorld(opts: {
  /** Seats already taken, including the owner. */
  seats: number
  status?: 'trialing' | 'active' | null
  parentId?: string | null
}): Promise<World> {
  const suffix = crypto.randomUUID().slice(0, 8)
  const mkUser = (name: string) =>
    db.user.create({ data: { name, email: `${name}-${suffix}@example.com` } })

  const owner = await mkUser('owner')
  const workspace = await db.workspace.create({
    data: {
      name: 'Acme',
      slug: `acme-${suffix}`,
      kind: 'team',
      ...(opts.parentId ? { parentWorkspaceId: opts.parentId } : {}),
    },
  })
  const project = await db.project.create({
    data: { name: 'Billing Bot', workspaceId: workspace.id },
  })

  const memberIds: string[] = []
  for (let i = 0; i < Math.max(0, opts.seats - 1); i++) {
    const u = await mkUser(`seat${i}`)
    await db.member.create({ data: { userId: u.id, workspaceId: workspace.id, role: 'member' } })
    memberIds.push(u.id)
  }
  await db.member.create({ data: { userId: owner.id, workspaceId: workspace.id, role: 'owner' } })

  if (opts.status) {
    await db.subscription.create({
      data: {
        workspaceId: workspace.id,
        stripeSubscriptionId: `sub_${suffix}`,
        stripeCustomerId: `cus_${suffix}`,
        planId: 'business',
        seats: opts.seats,
        status: opts.status,
        billingInterval: 'monthly',
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      },
    })
  }

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: owner.id,
    memberIds: [owner.id, ...memberIds],
  }
}

/** A user who is not in the workspace yet. */
async function newUser(): Promise<{ id: string; email: string }> {
  const suffix = crypto.randomUUID().slice(0, 8)
  return db.user.create({ data: { name: 'invitee', email: `invitee-${suffix}@example.com` } })
}

/** How the create hook is invoked: `(input, { prisma, userId })`. */
function hookCtx(userId: string) {
  return { prisma: db, userId } as any
}

async function countMembers(workspaceId: string): Promise<number> {
  return db.member.count({ where: { workspaceId, projectId: null } })
}

beforeEach(() => {
  // The clamp's "Stripe unconfigured" branch writes local seats only; a real
  // key here would try to call Stripe.
  delete process.env.STRIPE_SECRET_KEY
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('AC2: a trialing workspace refuses a seat at the cap', () => {
  test('the member hook refuses the join and creates no row', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS, status: 'trialing' })
    const invitee = await newUser()
    const before = await countMembers(world.workspaceId)

    const result: any = await memberHooks.beforeCreate?.(
      { userId: invitee.id, workspaceId: world.workspaceId, role: 'member' },
      hookCtx(world.ownerId),
    )

    expect(result?.ok).toBe(false)
    expect(result?.error?.code).toBe('trial_seat_limit')
    expect(result?.error?.message).toContain(`up to ${TRIAL_MAX_SEATS} seats`)
    // The hook refused, so nothing was inserted.
    expect(await countMembers(world.workspaceId)).toBe(before)
  })

  test('the guard itself agrees with the hook', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS, status: 'trialing' })
    expect(await billing.assertTrialSeatRoom(world.workspaceId)).toEqual({
      ok: false,
      code: 'trial_seat_limit',
      maxSeats: TRIAL_MAX_SEATS,
    })
  })

  test('a join below the cap is allowed', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS - 1, status: 'trialing' })
    const invitee = await newUser()

    const result: any = await memberHooks.beforeCreate?.(
      { userId: invitee.id, workspaceId: world.workspaceId, role: 'member' },
      hookCtx(world.ownerId),
    )

    // No rejection: `beforeCreate` either returns undefined or `{ ok: true }`.
    expect(result?.ok).not.toBe(false)
    expect(await billing.assertTrialSeatRoom(world.workspaceId)).toEqual({ ok: true })
  })

  test('a project guest still joins at the cap — guests use no seat', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS, status: 'trialing' })
    const invitee = await newUser()

    const result: any = await memberHooks.beforeCreate?.(
      { userId: invitee.id, projectId: world.projectId, role: 'viewer' },
      hookCtx(world.ownerId),
    )

    expect(result?.ok).not.toBe(false)
    // A guest row is project-scoped, so the seat count is unchanged.
    expect(await countMembers(world.workspaceId)).toBe(TRIAL_MAX_SEATS)
  })

  test('an active (paid) subscription is unaffected at any seat count', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS + 5, status: 'active' })
    const invitee = await newUser()

    const result: any = await memberHooks.beforeCreate?.(
      { userId: invitee.id, workspaceId: world.workspaceId, role: 'member' },
      hookCtx(world.ownerId),
    )

    expect(result?.ok).not.toBe(false)
    expect(await billing.assertTrialSeatRoom(world.workspaceId)).toEqual({ ok: true })
  })

  test('a child workspace join counts against the parent trial', async () => {
    const parent = await seedWorld({ seats: TRIAL_MAX_SEATS, status: 'trialing' })
    const child = await seedWorld({ seats: 0, status: null, parentId: parent.workspaceId })
    const invitee = await newUser()

    const result: any = await memberHooks.beforeCreate?.(
      { userId: invitee.id, workspaceId: child.workspaceId, role: 'member' },
      hookCtx(parent.ownerId),
    )

    expect(result?.ok).toBe(false)
    expect(result?.error?.code).toBe('trial_seat_limit')
    expect(await billing.assertTrialSeatRoom(child.workspaceId)).toMatchObject({ ok: false })
  })

  test('no subscription at all means no cap', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS + 5, status: null })
    expect(await billing.assertTrialSeatRoom(world.workspaceId)).toEqual({ ok: true })
  })
})

describe('AC3: the seat sync never bills a trial above the cap', () => {
  test('a trialing subscription is clamped to the cap', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS + 3, status: 'trialing' })

    const result = await billing.syncSeatsFromMembership(world.workspaceId)

    expect(result.ok).toBe(true)
    expect(result.seats).toBe(TRIAL_MAX_SEATS)
    const sub = await db.subscription.findFirst({ where: { workspaceId: world.workspaceId } })
    expect(sub?.seats).toBe(TRIAL_MAX_SEATS)
  })

  test('an active subscription is not clamped', async () => {
    const world = await seedWorld({ seats: TRIAL_MAX_SEATS + 3, status: 'active' })

    const result = await billing.syncSeatsFromMembership(world.workspaceId)

    expect(result.seats).toBe(TRIAL_MAX_SEATS + 3)
  })
})
