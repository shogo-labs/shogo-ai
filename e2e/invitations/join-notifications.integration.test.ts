// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One join, one email (SHO-51), end to end.
 *
 * A workspace join used to notify the same person twice: the invitation hook
 * mailed the inviter "accepted your invitation" and the member hook mailed every
 * owner "joined". This suite drives the paths the client actually takes, over
 * HTTP, through the real invitation/member CRUD routes, the real invite-link
 * route and the real cloud `afterAccept` handler, and counts the mail each
 * address receives. Every address gets at most one, a replayed accept gets none,
 * and a project-scope join keeps its single "accepted" mail.
 *
 *   bun --no-env-file --conditions=development test e2e/invitations/join-notifications.integration.test.ts
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { setupChannelsTestDb, waitFor } from '../../apps/api/src/__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

type Mail = {
  template: 'invite-accepted' | 'member-joined'
  to: string
  resourceType?: string
  resourceName?: string
}

const sent: Mail[] = []

const actualEmail = await import('../../apps/api/src/services/email.service')
mock.module('../../apps/api/src/services/email.service', () => ({
  ...actualEmail,
  sendInviteAcceptedEmail: async (params: any) => {
    sent.push({
      template: 'invite-accepted',
      to: params.to,
      resourceType: params.resourceType,
      resourceName: params.resourceName,
    })
    return { success: true }
  },
  sendMemberJoinedEmail: async (params: any) => {
    sent.push({ template: 'member-joined', to: params.to })
    return { success: true }
  },
}))

const { prisma } = await import('../../apps/api/src/lib/prisma')
const { invitationHooks } = await import('../../apps/api/src/generated/invitation.hooks')
const { memberHooks } = await import('../../apps/api/src/generated/member.hooks')
const invitationRoutes = await import('../../apps/api/src/generated/invitation.routes')
const memberRoutes = await import('../../apps/api/src/generated/member.routes')
const { inviteLinkAcceptRoutes } = await import('../../apps/api/src/routes/invite-link-accept')
const { createInviteLinkAfterAccept } = await import('../../apps/api/src/routes/invite-link-after-accept')

const db = prisma as any

invitationRoutes.setPrisma(prisma as any)
invitationRoutes.setInvitationHooks(invitationHooks as any)
memberRoutes.setPrisma(prisma as any)
memberRoutes.setMemberHooks(memberHooks as any)

/**
 * The API surface these flows touch, mounted the way `server.ts` mounts it: the
 * acting user arrives on `x-user`, and the invite-link `afterAccept` is the real
 * cloud handler (seat sync stubbed — Stripe is not part of this test).
 */
const app = new Hono()
app.use('/api/*', async (c, next) => {
  const userId = c.req.header('x-user')
  if (userId) c.set('auth' as never, { userId, isAuthenticated: true, email: `${userId}@example.com` } as never)
  await next()
})
app.route('/api/invitations', invitationRoutes.createInvitationRoutes())
app.route('/api/members', memberRoutes.createMemberRoutes())
app.route(
  '/api',
  inviteLinkAcceptRoutes({
    resolveUserId: (c) => (c.get('auth') as any)?.userId ?? null,
    afterAccept: createInviteLinkAfterAccept({ syncSeats: async () => ({}) }),
  }),
)

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

const mailTo = (address: string) => sent.filter((mail) => mail.to === address)

/** No address may receive two mails for one join. */
function expectOnePerAddress() {
  const counts = new Map<string, number>()
  for (const mail of sent) counts.set(mail.to, (counts.get(mail.to) ?? 0) + 1)
  expect([...counts].filter(([, n]) => n > 1)).toEqual([])
}

interface World {
  workspaceId: string
  projectId: string
  projectName: string
  owner: { id: string; email: string }
  otherOwner: { id: string; email: string }
  invitee: { id: string; email: string }
}

async function seedWorld(): Promise<World> {
  const suffix = randomUUID().slice(0, 8)
  const mkUser = (name: string) => db.user.create({ data: { name, email: `${name}-${suffix}@example.com` } })
  const [owner, otherOwner, invitee] = await Promise.all([
    mkUser('owner'),
    mkUser('other-owner'),
    mkUser('invitee'),
  ])
  const workspace = await db.workspace.create({ data: { name: 'Acme', slug: `acme-${suffix}`, kind: 'team' } })
  await db.member.create({ data: { userId: owner.id, workspaceId: workspace.id, role: 'owner' } })
  await db.member.create({ data: { userId: otherOwner.id, workspaceId: workspace.id, role: 'owner' } })
  const project = await db.project.create({ data: { name: 'Billing Bot', workspaceId: workspace.id } })
  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectName: project.name,
    owner,
    otherOwner,
    invitee,
  }
}

/** The client's accept sequence (domain-actions.acceptInvitation): flip the invitation, then create the member. */
async function acceptInvitation(world: World, invitationId: string) {
  const patched = await call(world.invitee.id, 'PATCH', `/invitations/${invitationId}`, { status: 'accepted' })
  expect(patched.status).toBe(200)
  const created = await call(world.invitee.id, 'POST', '/members', {
    userId: world.invitee.id,
    workspaceId: world.workspaceId,
    role: 'member',
  })
  expect(created.status).toBe(201)
  return created.json.data
}

beforeEach(() => {
  sent.length = 0
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('accepting a workspace invitation over HTTP', () => {
  test('the inviter-owner gets one accepted mail, the other owner one joined mail', async () => {
    const world = await seedWorld()
    const invitation = await db.invitation.create({
      data: {
        email: world.invitee.email,
        workspaceId: world.workspaceId,
        role: 'member',
        invitedBy: world.owner.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    await acceptInvitation(world, invitation.id)
    await waitFor(() => mailTo(world.owner.email).length > 0)
    await Bun.sleep(200)

    expect(mailTo(world.owner.email).map((mail) => mail.template)).toEqual(['invite-accepted'])
    expect(mailTo(world.otherOwner.email).map((mail) => mail.template)).toEqual(['member-joined'])
    expect(mailTo(world.invitee.email)).toHaveLength(0)
    expectOnePerAddress()
  })

  test('replaying the accept sends no further mail', async () => {
    const world = await seedWorld()
    const invitation = await db.invitation.create({
      data: {
        email: world.invitee.email,
        workspaceId: world.workspaceId,
        role: 'member',
        invitedBy: world.owner.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    await acceptInvitation(world, invitation.id)
    await waitFor(() => mailTo(world.owner.email).length > 0)
    expect(mailTo(world.owner.email)).toHaveLength(1)

    sent.length = 0
    // Offline-queue replay: the API refuses a second accept, and a retried member
    // create hits already_member, so neither can produce a second email.
    const patchedAgain = await call(world.invitee.id, 'PATCH', `/invitations/${invitation.id}`, {
      status: 'accepted',
    })
    expect(patchedAgain.status).toBe(400)
    expect(patchedAgain.json.error.code).toBe('bad_request')

    const createdAgain = await call(world.invitee.id, 'POST', '/members', {
      userId: world.invitee.id,
      workspaceId: world.workspaceId,
      role: 'member',
    })
    expect(createdAgain.status).toBe(409)
    expect(createdAgain.json.error.code).toBe('already_member')
    await Bun.sleep(250)

    expect(sent).toEqual([])
  })
})

describe('accepting a workspace invite link over HTTP', () => {
  test('creator and other owner each get exactly one mail', async () => {
    const world = await seedWorld()
    const link = await db.inviteLink.create({
      data: { workspaceId: world.workspaceId, role: 'member', createdBy: world.owner.id },
    })

    const res = await call(world.invitee.id, 'POST', `/invite-links/${link.token}/accept`)
    expect(res.status).toBe(200)
    await waitFor(() => mailTo(world.owner.email).length > 0)
    await Bun.sleep(200)

    expect(mailTo(world.owner.email).map((mail) => mail.template)).toEqual(['invite-accepted'])
    expect(mailTo(world.otherOwner.email).map((mail) => mail.template)).toEqual(['member-joined'])
    expect(mailTo(world.invitee.email)).toHaveLength(0)
    expectOnePerAddress()

    sent.length = 0
    const again = await call(world.invitee.id, 'POST', `/invite-links/${link.token}/accept`)
    expect(again.status).toBe(200)
    await Bun.sleep(200)
    expect(sent).toEqual([])
  })
})

describe('accepting a project invite link over HTTP', () => {
  test('a creator who owns the workspace gets one project accepted mail and no owner mail', async () => {
    const world = await seedWorld()
    const link = await db.inviteLink.create({
      data: { projectId: world.projectId, role: 'viewer', createdBy: world.owner.id },
    })

    const res = await call(world.invitee.id, 'POST', `/invite-links/${link.token}/accept`)
    expect(res.status).toBe(200)
    await waitFor(() => mailTo(world.owner.email).length > 0)
    await Bun.sleep(200)

    const creatorMail = mailTo(world.owner.email)
    expect(creatorMail).toHaveLength(1)
    expect(creatorMail[0].template).toBe('invite-accepted')
    expect(creatorMail[0].resourceType).toBe('project')
    expect(creatorMail[0].resourceName).toBe(world.projectName)
    expect(sent.filter((mail) => mail.template === 'member-joined')).toEqual([])
    expect(mailTo(world.otherOwner.email)).toEqual([])
    expectOnePerAddress()
  })

  test('a creator who is only an admin still gets their one accepted mail', async () => {
    const world = await seedWorld()
    const admin = await db.user.create({
      data: { name: 'admin', email: `admin-${randomUUID().slice(0, 8)}@example.com` },
    })
    await db.member.create({ data: { userId: admin.id, workspaceId: world.workspaceId, role: 'admin' } })
    const link = await db.inviteLink.create({
      data: { projectId: world.projectId, role: 'viewer', createdBy: admin.id },
    })

    const res = await call(world.invitee.id, 'POST', `/invite-links/${link.token}/accept`)
    expect(res.status).toBe(200)
    await waitFor(() => mailTo(admin.email).length > 0)
    await Bun.sleep(200)

    expect(mailTo(admin.email).map((mail) => mail.template)).toEqual(['invite-accepted'])
    expect(sent.filter((mail) => mail.template === 'member-joined')).toEqual([])
    expectOnePerAddress()
  })
})

describe('accepting a project invitation over HTTP', () => {
  test('the inviter gets exactly one accepted mail and nobody gets a joined mail', async () => {
    const world = await seedWorld()
    const invitation = await db.invitation.create({
      data: {
        email: world.invitee.email,
        workspaceId: world.workspaceId,
        projectId: world.projectId,
        role: 'viewer',
        invitedBy: world.owner.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    const patched = await call(world.invitee.id, 'PATCH', `/invitations/${invitation.id}`, { status: 'accepted' })
    expect(patched.status).toBe(200)
    await waitFor(() => mailTo(world.owner.email).length > 0)
    await Bun.sleep(200)

    expect(mailTo(world.owner.email).map((mail) => mail.template)).toEqual(['invite-accepted'])
    expect(sent.filter((mail) => mail.template === 'member-joined')).toEqual([])
    expect(mailTo(world.otherOwner.email)).toEqual([])
    expectOnePerAddress()
  })
})
