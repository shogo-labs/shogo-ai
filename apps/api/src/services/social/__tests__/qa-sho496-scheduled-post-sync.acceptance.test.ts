// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-496 acceptance — the reads that were not the ones under test in
 * `publishing.test.ts` / `scheduled-post-sync.integration.test.ts`.
 *
 * The bug was that a row only ever moved if somebody read that one post. So the
 * gate here is the *report* and the *calendar* reconciling on their own, the
 * cloud's copy of a relayed desktop post being kept honest by the webhook, and
 * a provider that says "scheduled" never being read as live.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { setSocialClient, SocialError } = await import('../client')
const { calendar, getPost, listPosts } = await import('../publishing.service')
const { socialAnalytics } = await import('../analytics.service')
const { handleZernioWebhook } = await import('../webhooks')

const db = prisma as any
const SECRET = 'whsec_sho496_qa'
const suffix = crypto.randomUUID().slice(0, 8)

const calls: any[] = []
let responder: (req: any) => any = () => ({ status: 404 })

function fakeProvider(): void {
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      const reply = responder(req)
      if (reply instanceof Error) throw reply
      return reply
    },
  })
}

let workspaceId = ''
let profileExternalId = ''
let ig: any
let tt: any

const range = () => ({ from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 3_600_000) })

async function seedPost(input: {
  status: string
  zernioPostId: string | null
  scheduledFor: Date | null
  targets: Array<{ account: any; status: string }>
}) {
  return db.socialPost.create({
    data: {
      workspaceId,
      status: input.status,
      content: `QA 496 ${crypto.randomUUID().slice(0, 6)}`,
      zernioPostId: input.zernioPostId,
      scheduledFor: input.scheduledFor,
      idempotencyKey: `sho496qa:${crypto.randomUUID()}`,
      targets: {
        create: input.targets.map((target) => ({
          accountId: target.account.id,
          platform: target.account.platform,
          status: target.status,
        })),
      },
    },
    include: { targets: true },
  })
}

const duePost = (zernioPostId = 'zp_qa_496') =>
  seedPost({
    status: 'scheduled',
    zernioPostId,
    scheduledFor: new Date(Date.now() - 5 * 3_600_000),
    targets: [
      { account: ig, status: 'pending' },
      { account: tt, status: 'pending' },
    ],
  })

const publishedByProvider = () => ({
  post: {
    _id: 'zp_qa_496',
    status: 'published',
    publishedAt: '2026-11-20T20:30:00.000Z',
    platforms: [
      {
        accountId: ig.zernioAccountId,
        status: 'published',
        platformPostId: 'ig_media_qa',
        publishedUrl: 'https://www.instagram.com/reel/qa496/',
      },
      {
        accountId: tt.zernioAccountId,
        status: 'published',
        platformPostId: 'tt_video_qa',
        platformPostUrl: 'https://www.tiktok.com/@acme/video/qa496',
      },
    ],
  },
})

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { name: `SHO-496 QA ${suffix}`, slug: `sho496-qa-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `zp_${suffix}`,
      externalId: `ws_${workspaceId}`,
      name: 'SHO-496 QA',
    },
  })
  profileExternalId = profile.externalId
  ig = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `qa_ig_${suffix}`,
      platform: 'instagram',
      username: 'qa.ig',
      isActive: true,
    },
  })
  tt = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `qa_tt_${suffix}`,
      platform: 'tiktok',
      username: 'qa.tt',
      isActive: true,
    },
  })
  fakeProvider()
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
})

beforeEach(async () => {
  calls.length = 0
  responder = () => new SocialError(404, 'post_not_found', 'No such post')
  await db.socialPost.deleteMany({ where: { workspaceId } })
})

describe('AC3 — the report reconciles for itself', () => {
  test('analytics stops counting a shipped post as scheduled without anyone opening it', async () => {
    const post = await duePost()
    responder = () => publishedByProvider()
    expect((await db.socialPost.findUnique({ where: { id: post.id } })).status).toBe('scheduled')

    // No getPost / listPosts first: the report alone has to fix the row.
    const analytics = await socialAnalytics(workspaceId, range())

    expect(analytics.posts.published).toBe(1)
    expect(analytics.posts.scheduled).toBe(0)
    const row = await db.socialPost.findUnique({ where: { id: post.id }, include: { targets: true } })
    expect(row.status).toBe('published')
    expect(row.targets.map((target: any) => target.status)).toEqual(['published', 'published'])
  })

  test('a post the provider rejected is counted failed, not scheduled', async () => {
    const post = await duePost()
    responder = () => ({
      post: {
        _id: 'zp_qa_496',
        status: 'failed',
        platforms: [
          { accountId: ig.zernioAccountId, status: 'failed', platformError: { message: 'Media rejected' } },
          { accountId: tt.zernioAccountId, status: 'failed', platformError: { message: 'Media rejected' } },
        ],
      },
    })

    const analytics = await socialAnalytics(workspaceId, range())

    expect(analytics.posts.failed).toBe(1)
    expect(analytics.posts.scheduled).toBe(0)
    expect((await db.socialPost.findUnique({ where: { id: post.id } })).status).toBe('failed')
  })

  test('a report survives a provider that cannot be reached', async () => {
    const post = await duePost()
    responder = () => new SocialError(502, 'zernio_unreachable', 'Could not reach Zernio.')

    const analytics = await socialAnalytics(workspaceId, range())

    expect(analytics.posts.scheduled).toBe(1)
    expect((await db.socialPost.findUnique({ where: { id: post.id } })).status).toBe('scheduled')
  })
})

describe('AC7 — a status we do not understand is never read as live', () => {
  test('a due post the provider still calls scheduled does not become published', async () => {
    const post = await duePost()
    responder = () => ({
      post: {
        _id: 'zp_qa_496',
        status: 'scheduled',
        platforms: [
          { accountId: ig.zernioAccountId, status: 'scheduled' },
          { accountId: tt.zernioAccountId, status: 'scheduled' },
        ],
      },
    })

    const read = await getPost(workspaceId, post.id)

    expect(read.status).not.toBe('published')
    expect(read.publishedAt).toBeNull()
    expect(read.targets.map((target: any) => target.status)).not.toContain('published')
  })
})

describe('the calendar read path', () => {
  test('the calendar shows the reconciled status, not the stale row', async () => {
    const post = await duePost()
    responder = () => publishedByProvider()

    const posts = await calendar(workspaceId, new Date(Date.now() - 86_400_000), new Date(Date.now() + 3_600_000))
    const shown = posts.find((row: any) => row.id === post.id)

    expect(shown.status).toBe('published')
    expect(shown.publishedAt?.toISOString()).toBe('2026-11-20T20:30:00.000Z')
  })

  test('a post that is not due yet costs no provider call on the list', async () => {
    await seedPost({
      status: 'scheduled',
      zernioPostId: 'zp_qa_future',
      scheduledFor: new Date(Date.now() + 3_600_000),
      targets: [{ account: ig, status: 'pending' }],
    })

    const posts = await listPosts(workspaceId, {})

    expect(posts.every((row: any) => row.status === 'scheduled')).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('AC6 — the webhook, on the cloud and on a relayed desktop post', () => {
  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex')

  test('the cloud copy of a relayed desktop post is updated by the same webhook', async () => {
    const localWorkspaceId = crypto.randomUUID()
    const profile = await db.socialProfile.create({
      data: {
        workspaceId,
        localWorkspaceId,
        zernioProfileId: `zp_relay_${suffix}`,
        externalId: `lws_${localWorkspaceId}`,
        name: 'SHO-496 relayed',
      },
    })
    // `recordPost` writes this row when the desktop relays its create.
    const copy = await seedPost({
      status: 'scheduled',
      zernioPostId: 'zp_qa_relayed',
      scheduledFor: new Date(Date.now() - 3_600_000),
      targets: [
        { account: ig, status: 'pending' },
        { account: tt, status: 'pending' },
      ],
    })

    const body = JSON.stringify({
      type: 'post.published',
      profiles: [{ externalId: profile.externalId }],
      post: {
        _id: 'zp_qa_relayed',
        status: 'published',
        publishedAt: '2026-11-20T21:00:00.000Z',
        platforms: [
          {
            accountId: ig.zernioAccountId,
            status: 'published',
            platformPostId: 'ig_media_relayed',
            publishedUrl: 'https://www.instagram.com/reel/relayed/',
          },
          {
            accountId: tt.zernioAccountId,
            status: 'published',
            platformPostId: 'tt_video_relayed',
            platformPostUrl: 'https://www.tiktok.com/@acme/video/relayed',
          },
        ],
      },
    })

    const res = await handleZernioWebhook({ rawBody: body, signature: sign(body), eventId: 'evt_qa_496_relay', secret: SECRET })

    expect(res).toMatchObject({ status: 200, body: { ok: true, relayed: localWorkspaceId } })
    const row = await db.socialPost.findUnique({ where: { id: copy.id }, include: { targets: true } })
    expect(row.status).toBe('published')
    expect(row.publishedAt?.toISOString()).toBe('2026-11-20T21:00:00.000Z')
    expect(row.targets.map((target: any) => target.platformPostId).sort()).toEqual(['ig_media_relayed', 'tt_video_relayed'])
    // The webhook is the evidence; nothing had to ask the provider.
    expect(calls).toHaveLength(0)
  })

  test('a per-target failure event lands on that target with the platform error', async () => {
    const post = await duePost('zp_qa_platform')
    const body = JSON.stringify({
      type: 'post.platform.failed',
      profiles: [{ externalId: profileExternalId }],
      post: {
        _id: 'zp_qa_platform',
        status: 'publishing',
        platforms: [
          {
            accountId: tt.zernioAccountId,
            status: 'failed',
            errorCategory: 'policy',
            platformError: { message: 'TikTok refused the video' },
          },
        ],
      },
    })

    const res = await handleZernioWebhook({ rawBody: body, signature: sign(body), eventId: 'evt_qa_496_platform', secret: SECRET })

    expect(res.status).toBe(200)
    const row = await db.socialPost.findUnique({ where: { id: post.id }, include: { targets: true } })
    const tiktok = row.targets.find((target: any) => target.platform === 'tiktok')
    // Covers AC7 for a status of `failed` alongside a provider error.
    expect(tiktok.status).toBe('failed')
    expect(tiktok.error).toContain('TikTok refused the video')
    expect(tiktok.error).toContain('policy')
  })
})
