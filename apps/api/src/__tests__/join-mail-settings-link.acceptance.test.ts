// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where a join mail actually sends people (SHO-110, QA acceptance).
 *
 * `apps/api/src/__tests__/join-notification-settings-url.test.ts` pins the
 * `settingsPeoplePath()` helper. This spec goes one level out: it drives the
 * production entry point (`onWorkspaceMemberJoined`), records what the mailer is
 * handed, and asserts the `dashboardUrl` on every template. A caller that
 * inlines its own `${frontendUrl()}/settings` string fails here even though the
 * helper's own test stays green.
 *
 * Note this is a pin, not the card's regression proof: the mailed string did not
 * change when SHO-110 landed, only what `/settings` resolves to. That half is
 * red-on-main in `apps/mobile/test/__tests__/settings-route-ownership.acceptance.test.ts`
 * and `e2e/local/settings-route-ownership.test.ts`.
 *
 * `/settings?tab=people` is a real route only because the admin AI console moved
 * to `/admin/settings`; before that, a direct GET of `/settings` resolved to the
 * admin page and bounced to `/projects`. The route half of that proof is
 * `apps/mobile/test/__tests__/settings-route-ownership.acceptance.test.ts`.
 *
 * Run one file per invocation (how CI runs apps/api, via run-tests-isolated):
 *   bun --no-env-file --conditions=development test src/__tests__/join-mail-settings-link.acceptance.test.ts
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb, waitFor } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const sent: Array<{ template: 'invite-accepted' | 'member-joined'; to: string; dashboardUrl?: string }> = []

// Own client instead of `lib/prisma`, which other files in this package mock
// (`mock.module` is process-global).
const { createPrismaClient } = await import('../lib/create-prisma-client')
const db: any = await createPrismaClient()
const { onWorkspaceMemberJoined } = await import('../services/workspace-events')
const { setJoinMailSenders } = await import('../services/join-notifications')

const APP_URL = 'https://app.shogo.test'

setJoinMailSenders({
  inviteAccepted: (async (params: any) => {
    sent.push({ template: 'invite-accepted', to: params.to, dashboardUrl: params.dashboardUrl })
    return { success: true }
  }) as any,
  memberJoined: (async (params: any) => {
    sent.push({ template: 'member-joined', to: params.to, dashboardUrl: params.dashboardUrl })
    return { success: true }
  }) as any,
})

beforeEach(() => {
  sent.length = 0
  process.env.APP_URL = APP_URL
})

afterAll(async () => {
  setJoinMailSenders(null)
  delete process.env.APP_URL
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function seedWorkspace() {
  const suffix = crypto.randomUUID().slice(0, 8)
  const mkUser = (name: string) => db.user.create({ data: { name, email: `${name}-${suffix}@example.com` } })
  const [owner, otherOwner, joiner] = await Promise.all([
    mkUser('owner'),
    mkUser('other-owner'),
    mkUser('joiner'),
  ])
  const workspace = await db.workspace.create({
    data: { name: 'Acme', slug: `acme-${suffix}`, kind: 'team' },
  })
  await db.member.create({ data: { userId: owner.id, workspaceId: workspace.id, role: 'owner' } })
  await db.member.create({ data: { userId: otherOwner.id, workspaceId: workspace.id, role: 'owner' } })
  return { workspace, owner, otherOwner, joiner }
}

async function join(world: Awaited<ReturnType<typeof seedWorkspace>>) {
  const member = await db.member.create({
    data: { userId: world.joiner.id, workspaceId: world.workspace.id, role: 'member' },
  })
  await onWorkspaceMemberJoined({
    workspaceId: world.workspace.id,
    userId: world.joiner.id,
    memberId: member.id,
    role: 'member',
    source: 'invitation',
    prisma: db,
  })
  await waitFor(async () => sent.length > 0)
  await Bun.sleep(150)
}

describe('join mail → Settings → People', () => {
  test('every owner mail links to /settings?tab=people, not the admin console', async () => {
    const world = await seedWorkspace()
    await join(world)

    expect(sent.length).toBeGreaterThan(0)
    for (const mail of sent) {
      expect({ to: mail.to, url: mail.dashboardUrl }).toEqual({
        to: mail.to,
        url: `${APP_URL}/settings?tab=people`,
      })
    }
  })

  test('an invitation-accepted mail uses the same link as a plain member-joined mail', async () => {
    const world = await seedWorkspace()
    await db.invitation.create({
      data: {
        email: world.joiner.email,
        workspaceId: world.workspace.id,
        role: 'member',
        invitedBy: world.owner.id,
        status: 'accepted',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })
    await join(world)

    const templates = sent.map((mail) => mail.template).sort()
    expect(templates).toEqual(['invite-accepted', 'member-joined'])
    expect(new Set(sent.map((mail) => mail.dashboardUrl))).toEqual(new Set([`${APP_URL}/settings?tab=people`]))
  })

  test('no mail points at the admin console or the chat-preferences alias', async () => {
    const world = await seedWorkspace()
    await join(world)

    for (const mail of sent) {
      expect(mail.dashboardUrl).not.toContain('/admin/')
      expect(mail.dashboardUrl).not.toContain('/c/settings')
      expect(mail.dashboardUrl).not.toContain('/projects')
    }
  })
})
