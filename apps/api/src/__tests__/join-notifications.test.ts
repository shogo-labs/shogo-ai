// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One join, one email (SHO-51).
 *
 * A workspace join used to notify the same person twice: the invitation hook
 * mailed the inviter "accepted your invitation" and the member hook mailed every
 * owner "joined". An inviter who is also an owner got both. These tests accept an
 * invitation and an invite link the way the client does and count the mail per
 * address — every address gets at most one, and a replayed accept gets none.
 *
 * Mail is recorded through `setJoinMailSenders`, the service's own seam: no
 * `mock.module` here, because that registry is process-global and leaks into
 * whatever file `bun test` loads next.
 *
 * Run one file per invocation (how CI runs apps/api, via run-tests-isolated):
 *   bun --no-env-file --conditions=development test src/__tests__/join-notifications.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb, waitFor } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const sent: Array<{ template: 'invite-accepted' | 'member-joined'; to: string; resourceType?: string; resourceName?: string }> = []

// Build our own handle instead of importing `../lib/prisma`: that module is what
// other test files `mock.module(...)`, and the mock registry is process-global.
const { createPrismaClient } = await import('../lib/create-prisma-client')
const db: any = await createPrismaClient()
const { memberHooks } = await import('../generated/member.hooks')
const { invitationHooks } = await import('../generated/invitation.hooks')
const { inviteLinkAcceptRoutes } = await import('../routes/invite-link-accept')
const { createInviteLinkAfterAccept } = await import('../routes/invite-link-after-accept')
const { onWorkspaceMemberJoined } = await import('../services/workspace-events')
const { setJoinMailSenders } = await import('../services/join-notifications')

beforeAll(() => {
  setJoinMailSenders({
    inviteAccepted: (async (params: any) => {
      sent.push({
        template: 'invite-accepted',
        to: params.to,
        resourceType: params.resourceType,
        resourceName: params.resourceName,
      })
      return { success: true }
    }) as any,
    memberJoined: (async (params: any) => {
      sent.push({ template: 'member-joined', to: params.to })
      return { success: true }
    }) as any,
  })
})

interface JoinWorld {
  workspace: { id: string; name: string }
  project: { id: string; name: string }
  owner: { id: string; email: string; name: string }
  otherOwner: { id: string; email: string; name: string }
  invitee: { id: string; email: string; name: string }
}

async function seedJoinWorld(): Promise<JoinWorld> {
  const suffix = crypto.randomUUID().slice(0, 8)
  const mkUser = (name: string) =>
    db.user.create({ data: { name, email: `${name}-${suffix}@example.com` } })
  const [owner, otherOwner, invitee] = await Promise.all([
    mkUser('owner'),
    mkUser('other-owner'),
    mkUser('invitee'),
  ])
  const workspace = await db.workspace.create({
    data: { name: 'Acme', slug: `acme-${suffix}`, kind: 'team' },
  })
  await db.member.create({ data: { userId: owner.id, workspaceId: workspace.id, role: 'owner' } })
  await db.member.create({ data: { userId: otherOwner.id, workspaceId: workspace.id, role: 'owner' } })
  const project = await db.project.create({ data: { name: 'Billing Bot', workspaceId: workspace.id } })
  return {
    workspace: { id: workspace.id, name: workspace.name },
    project: { id: project.id, name: project.name },
    owner,
    otherOwner,
    invitee,
  }
}

const to = (address: string) => sent.filter((mail) => mail.to === address)

beforeEach(() => {
  sent.length = 0
})

afterAll(async () => {
  setJoinMailSenders(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('accepting a workspace invitation', () => {
  test('mails the inviter-owner once, and never the member-joined variant', async () => {
    const world = await seedJoinWorld()
    const invitation = await db.invitation.create({
      data: {
        email: world.invitee.email,
        workspaceId: world.workspace.id,
        role: 'member',
        invitedBy: world.owner.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    // The client accepts like this (domain-actions.acceptInvitation): the
    // invitation flips to accepted first, then the member row is created.
    const accepted = await db.invitation.update({
      where: { id: invitation.id },
      data: { status: 'accepted' },
    })
    const ctx = { prisma: db, userId: world.invitee.id } as any
    await invitationHooks.afterUpdate?.(accepted, ctx)
    const member = await db.member.create({
      data: { userId: world.invitee.id, workspaceId: world.workspace.id, role: 'member' },
    })
    await memberHooks.afterCreate?.(member, ctx)

    // The member hook hands the notification to a detached import, so wait for
    // it to land instead of assuming it ran inline.
    await waitFor(async () => to(world.owner.email).length > 0)
    await Bun.sleep(150)

    const toInviter = to(world.owner.email)
    expect(toInviter.map((mail) => mail.template)).toEqual(['invite-accepted'])
    expect(to(world.otherOwner.email).map((mail) => mail.template)).toEqual(['member-joined'])
    expect(to(world.invitee.email)).toHaveLength(0)
  })

  test('a replayed accept sends nothing', async () => {
    const world = await seedJoinWorld()
    const member = await db.member.create({
      data: { userId: world.invitee.id, workspaceId: world.workspace.id, role: 'member' },
    })
    await onWorkspaceMemberJoined({
      workspaceId: world.workspace.id,
      userId: world.invitee.id,
      memberId: member.id,
      role: 'member',
      source: 'invitation',
      prisma: db,
    })
    expect(to(world.owner.email)).toHaveLength(1)

    sent.length = 0
    // Offline-queue replay / retried hook: same member, second emit.
    await onWorkspaceMemberJoined({
      workspaceId: world.workspace.id,
      userId: world.invitee.id,
      memberId: member.id,
      role: 'member',
      source: 'invitation',
      prisma: db,
    })
    await Bun.sleep(150)
    expect(sent).toHaveLength(0)
  })
})

describe('accepting an invite link', () => {
  function buildApp(inviteeId: string): Hono {
    const app = new Hono()
    app.route('/api', inviteLinkAcceptRoutes({ resolveUserId: () => inviteeId, prisma: db }))
    return app
  }

  test('the creator gets one accepted mail and other owners one joined mail', async () => {
    const world = await seedJoinWorld()
    const link = await db.inviteLink.create({
      data: { workspaceId: world.workspace.id, role: 'member', createdBy: world.owner.id },
    })

    const res = await buildApp(world.invitee.id).request(`/api/invite-links/${link.token}/accept`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    expect(to(world.owner.email).map((mail) => mail.template)).toEqual(['invite-accepted'])
    expect(to(world.otherOwner.email).map((mail) => mail.template)).toEqual(['member-joined'])
    expect(to(world.invitee.email)).toHaveLength(0)
  })

  test('a second POST for the same member sends nothing', async () => {
    const world = await seedJoinWorld()
    const link = await db.inviteLink.create({
      data: { workspaceId: world.workspace.id, role: 'member', createdBy: world.owner.id },
    })
    const app = buildApp(world.invitee.id)
    await app.request(`/api/invite-links/${link.token}/accept`, { method: 'POST' })
    expect(to(world.owner.email)).toHaveLength(1)

    sent.length = 0
    const again = await app.request(`/api/invite-links/${link.token}/accept`, { method: 'POST' })
    expect(again.status).toBe(200)
    await Bun.sleep(150)
    expect(sent).toHaveLength(0)
  })
})

describe('accepting a project invite link', () => {
  // The production handler from apps/api/src/routes/invite-link-after-accept.ts,
  // not a copy: round 1's regression lived in exactly this block.
  function buildProjectApp(inviteeId: string): Hono {
    const app = new Hono()
    app.route(
      '/api',
      inviteLinkAcceptRoutes({
        resolveUserId: () => inviteeId,
        prisma: db,
        afterAccept: createInviteLinkAfterAccept({ syncSeats: async () => ({}), prisma: db }),
      }),
    )
    return app
  }

  test('creator who owns the workspace gets one project accepted mail, no owner mail', async () => {
    const world = await seedJoinWorld()
    const link = await db.inviteLink.create({
      data: { projectId: world.project.id, role: 'viewer', createdBy: world.owner.id },
    })

    const res = await buildProjectApp(world.invitee.id).request(`/api/invite-links/${link.token}/accept`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const mail = to(world.owner.email)
    expect(mail).toHaveLength(1)
    expect(mail[0].template).toBe('invite-accepted')
    expect(mail[0].resourceType).toBe('project')
    expect(mail[0].resourceName).toBe(world.project.name)
    expect(sent.filter((m) => m.template === 'member-joined')).toHaveLength(0)
    expect(sent.map((m) => m.to)).not.toContain(world.otherOwner.email)
  })

  test('creator who is not an owner still gets their one accepted mail', async () => {
    const world = await seedJoinWorld()
    const nonOwner = await db.user.create({
      data: { name: 'admin', email: `admin-${crypto.randomUUID().slice(0, 8)}@example.com` },
    })
    await db.member.create({
      data: { userId: nonOwner.id, workspaceId: world.workspace.id, role: 'admin' },
    })
    const link = await db.inviteLink.create({
      data: { projectId: world.project.id, role: 'viewer', createdBy: nonOwner.id },
    })

    const res = await buildProjectApp(world.invitee.id).request(`/api/invite-links/${link.token}/accept`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    expect(to(nonOwner.email).map((m) => m.template)).toEqual(['invite-accepted'])
    expect(sent.filter((m) => m.template === 'member-joined')).toHaveLength(0)
  })
})

describe('a project invitation keeps its single accepted mail', () => {
  test('the inviter gets exactly one invite-accepted and nobody gets member-joined', async () => {
    const world = await seedJoinWorld()
    const ctx = { prisma: db, userId: world.invitee.id } as any
    await invitationHooks.afterUpdate?.(
      {
        id: 'inv-project-1',
        email: world.invitee.email,
        role: 'member',
        workspaceId: world.workspace.id,
        projectId: world.project.id,
        status: 'accepted',
        invitedBy: world.owner.id,
      },
      ctx,
    )

    expect(to(world.owner.email).map((mail) => mail.template)).toEqual(['invite-accepted'])
    expect(sent.filter((mail) => mail.template === 'member-joined')).toHaveLength(0)
  })
})
