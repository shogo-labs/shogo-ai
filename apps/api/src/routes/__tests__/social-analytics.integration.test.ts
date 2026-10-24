// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P6 — `GET /social/analytics` through Hono against a real SQLite
 * database.
 *
 * The route has to answer two kinds of question with one call: *what happened*
 * (posts, comments, inbox — from our own rows, so it can never disagree with the
 * inbox the user is looking at) and *what is this costing* (the meter state,
 * which is what the composer's pre-flight and the usage panel read). It also has
 * to refuse a nonsense range before it walks the row set.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { socialRoutes } = await import('../social')
const { setSocialClient } = await import('../../services/social/client')
const { setSocialUsageWallet } = await import('../../services/social/usage.service')

const db = prisma as any

const app = new Hono()
app.use('*', async (c, next) => {
  const userId = c.req.header('x-user')
  c.set('auth', { userId, isAuthenticated: !!userId } as never)
  await next()
})
app.route('/api', socialRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }))

const request = (path: string, userId: string | null) =>
  app.request(path, { headers: userId ? { 'x-user': userId } : {} })

const suffix = crypto.randomUUID().slice(0, 8)
let owner = ''
let outsider = ''
let workspaceId = ''

beforeAll(async () => {
  const [ownerUser, outsiderUser] = await Promise.all([
    db.user.create({ data: { name: 'owner', email: `analytics-owner-${suffix}@example.com` } }),
    db.user.create({ data: { name: 'outsider', email: `analytics-out-${suffix}@example.com` } }),
  ])
  owner = ownerUser.id
  outsider = outsiderUser.id

  const workspace = await db.workspace.create({
    data: { name: 'Analytics Co', slug: `analytics-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { workspaceId, userId: owner, role: 'member', projectId: null } })

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: 'zp_analytics',
      externalId: `ws_${workspaceId}`,
      name: 'Analytics Co',
    },
  })
  const instagram = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: 'za_ig',
      platform: 'instagram',
      username: 'analytics.ig',
    },
  })
  const x = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: 'za_x',
      platform: 'x',
      username: 'analytics.x',
      needsReconnect: true,
    },
  })

  // One post published to Instagram + X, one leg failed: the shape a partial
  // publish leaves behind.
  const post = await db.socialPost.create({
    data: {
      workspaceId,
      status: 'partial',
      content: 'Launch day https://shogo.one',
      publishedAt: new Date(),
      idempotencyKey: `analytics_post_${suffix}`,
      targets: {
        create: [
          { accountId: instagram.id, platform: 'instagram', status: 'published' },
          { accountId: x.id, platform: 'x', status: 'failed', error: 'rate limited' },
        ],
      },
    },
  })
  await db.socialPost.create({
    data: {
      workspaceId,
      status: 'scheduled',
      content: 'Tomorrow',
      scheduledFor: new Date(Date.now() + 86_400_000),
      idempotencyKey: `analytics_scheduled_${suffix}`,
    },
  })
  await db.socialComment.create({
    data: {
      workspaceId,
      postId: post.id,
      accountId: instagram.id,
      zernioCommentId: 'zc_1',
      zernioPostId: 'zp_post_1',
      platformPostId: 'ig_1',
      platform: 'instagram',
      text: 'How much?',
      status: 'new',
      occurredAt: new Date(),
    },
  })
  await db.socialComment.create({
    data: {
      workspaceId,
      postId: post.id,
      accountId: instagram.id,
      zernioCommentId: 'zc_2',
      zernioPostId: 'zp_post_1',
      platformPostId: 'ig_1',
      platform: 'instagram',
      text: 'Thanks!',
      status: 'replied',
      occurredAt: new Date(),
    },
  })
  const conversation = await db.socialConversation.create({
    data: {
      workspaceId,
      accountId: instagram.id,
      zernioConversationId: 'conv_analytics',
      platform: 'instagram',
      unreadCount: 2,
      lastMessageAt: new Date(),
    },
  })
  await db.socialMessage.createMany({
    data: [
      {
        workspaceId,
        conversationId: conversation.id,
        zernioMessageId: 'am_1',
        direction: 'incoming',
        platform: 'instagram',
        text: 'Do you ship?',
        sentAt: new Date(),
      },
      {
        workspaceId,
        conversationId: conversation.id,
        zernioMessageId: 'am_2',
        direction: 'outgoing',
        platform: 'instagram',
        text: 'We do',
        sentAt: new Date(),
      },
    ],
  })

  setSocialClient({ mode: 'cloud', async request() { return {} } })
  setSocialUsageWallet({
    async consume() { return { success: true } },
    async checkBalance() { return { ok: true } },
  })
})

afterAll(() => {
  setSocialUsageWallet(null)
  setSocialClient(null)
})

describe('GET /social/analytics', () => {
  test('answers what happened and what it costs in one shape', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/analytics`, owner)
    expect(res.status).toBe(200)
    const body: any = await res.json()

    // Publishing, from the legs we wrote (a post to two accounts is two legs).
    expect(body.posts.partial).toBe(1)
    expect(body.posts.scheduled).toBe(1)
    const instagram = body.posts.byPlatform.find((row: any) => row.platform === 'instagram')
    expect(instagram.published).toBe(1)
    const x = body.posts.byPlatform.find((row: any) => row.platform === 'x')
    expect(x.failed).toBe(1)

    // Comments: one waiting on us, one answered.
    expect(body.engagement.comments).toBe(2)
    expect(body.engagement.awaitingReply).toBe(1)
    expect(body.engagement.replied).toBe(1)

    // Inbox: one thread, its unread, and what moved in the window.
    expect(body.inbox.conversations).toBe(1)
    expect(body.inbox.unreadThreads).toBe(1)
    expect(body.inbox.unreadMessages).toBe(2)
    expect(body.inbox.incoming).toBe(1)
    expect(body.inbox.outgoing).toBe(1)

    // Accounts, including the one that needs a reconnect.
    expect(body.accounts.total).toBe(2)
    expect(body.accounts.active).toBe(2)
    expect(body.accounts.needsReconnect).toBe(1)
    expect(body.accounts.byPlatform.map((row: any) => row.platform).sort()).toEqual(['instagram', 'x'])

    // The meter state, so a client can warn before a charge instead of after.
    expect(body.usage.dms.freeUnitsPerMonth).toBe(10_000)
    expect(body.usage.band.perAccountUsd).toBe(6)
    expect(body.usage.estimatedMonthlyRawUsd).toBe(0) // two accounts are inside the credit
    expect(typeof body.from).toBe('string')
    expect(typeof body.to).toBe('string')
  })

  test('a range that cannot be right is a 400, not an empty report', async () => {
    const reversed = await request(
      `/api/workspaces/${workspaceId}/social/analytics?from=2026-10-20T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`,
      owner,
    )
    expect(reversed.status).toBe(400)
    const body: any = await reversed.json()
    expect(body.error.code).toBe('invalid_range')

    const tooWide = await request(
      `/api/workspaces/${workspaceId}/social/analytics?from=2020-01-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`,
      owner,
    )
    expect(tooWide.status).toBe(400)
  })

  test('tenancy: a non-member gets a 404, never another workspace’s numbers', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/analytics`, outsider)
    expect(res.status).toBe(404)
  })

  test('a signed-out caller is refused', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/analytics`, null)
    expect(res.status).toBe(401)
  })
})
