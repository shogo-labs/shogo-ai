// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-496 — a scheduled post must stop reading `scheduled` once Zernio has put
 * it out.
 *
 * A real SQLite database and a faked provider: the read path, the webhook and
 * the analytics report all have to land on the same row, through the same
 * writer, so the person sees what is really live instead of a row that never
 * moves.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { setSocialClient, SocialError } = await import('../client')
const { getPost, listPosts } = await import('../publishing.service')
const { socialAnalytics } = await import('../analytics.service')
const { applySocialEvent, handleZernioWebhook } = await import('../webhooks')

const db = prisma as any
const SECRET = 'whsec_sho496'

const calls: any[] = []
let responder: (req: any) => any = () => ({})

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

const suffix = crypto.randomUUID().slice(0, 8)
const workspaces: string[] = []

let workspaceId = ''
let profileExternalId = ''
let ig: any
let tt: any

async function newWorkspace(): Promise<string> {
  const workspace = await db.workspace.create({
    data: { name: `SHO-496 ${suffix}`, slug: `sho496-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
  })
  workspaces.push(workspace.id)
  return workspace.id
}

async function connectAccount(accountWorkspaceId: string, profileId: string, platform: string, handle: string, providerId: string) {
  return db.socialAccount.create({
    data: {
      workspaceId: accountWorkspaceId,
      profileId,
      zernioAccountId: providerId,
      platform,
      username: handle,
      isActive: true,
    },
  })
}

/** A post in whatever state the case needs, without going through a publish. */
async function seedPost(input: {
  status: string
  zernioPostId?: string | null
  scheduledFor?: Date | null
  targets: Array<{ account: any; status: string }>
}) {
  return db.socialPost.create({
    data: {
      workspaceId,
      status: input.status,
      content: `Reel ${crypto.randomUUID().slice(0, 6)}`,
      zernioPostId: input.zernioPostId ?? null,
      scheduledFor: input.scheduledFor ?? null,
      idempotencyKey: `sho496:${crypto.randomUUID()}`,
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

/** A due post as `social_media post` leaves it: scheduled, two legs pending. */
const duePost = () =>
  seedPost({
    status: 'scheduled',
    zernioPostId: 'zp_496',
    scheduledFor: new Date(Date.now() - 4 * 3_600_000),
    targets: [
      { account: ig, status: 'pending' },
      { account: tt, status: 'pending' },
    ],
  })

const providerPost = (over: Record<string, any> = {}) => ({
  post: {
    _id: 'zp_496',
    status: 'published',
    publishedAt: '2026-11-20T20:30:00.000Z',
    platforms: [
      {
        accountId: ig.zernioAccountId,
        status: 'published',
        platformPostId: 'ig_media_496',
        publishedUrl: 'https://www.instagram.com/reel/ig496/',
      },
      {
        accountId: tt.zernioAccountId,
        status: 'published',
        platformPostId: 'tt_video_496',
        platformPostUrl: 'https://www.tiktok.com/@acme/video/496',
      },
    ],
    ...over,
  },
})

beforeAll(async () => {
  workspaceId = await newWorkspace()
  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `zp_${suffix}`,
      externalId: `ws_${workspaceId}`,
      name: 'SHO-496',
    },
  })
  profileExternalId = profile.externalId
  ig = await connectAccount(workspaceId, profile.id, 'instagram', 'acme.ig', `provider_ig_${suffix}`)
  tt = await connectAccount(workspaceId, profile.id, 'tiktok', 'acme.tt', `provider_tt_${suffix}`)
  fakeProvider()
})

afterAll(async () => {
  setSocialClient(null)
  for (const id of workspaces) await db.workspace.delete({ where: { id } }).catch(() => {})
})

beforeEach(async () => {
  calls.length = 0
  responder = () => ({})
  // Each case starts from a clean slate: the analytics count is per workspace.
  await db.socialPost.deleteMany({ where: { workspaceId } })
})

describe('the read path', () => {
  test('a past-due scheduled post is read from the provider and becomes published', async () => {
    const post = await duePost()
    responder = (req) => {
      if (req.method === 'GET' && req.path === '/posts/zp_496') return providerPost()
      throw new Error(`unexpected ${req.method} ${req.path}`)
    }

    const read = await getPost(workspaceId, post.id)

    expect(read.status).toBe('published')
    const byPlatform = new Map(read.targets.map((target: any) => [target.platform, target]))
    expect(byPlatform.get('instagram')).toMatchObject({
      status: 'published',
      platformPostId: 'ig_media_496',
      platformPostUrl: 'https://www.instagram.com/reel/ig496/',
    })
    expect(byPlatform.get('tiktok')).toMatchObject({
      status: 'published',
      platformPostId: 'tt_video_496',
      platformPostUrl: 'https://www.tiktok.com/@acme/video/496',
    })
    // The provider's own publish time, not the moment we happened to read it.
    expect(read.publishedAt?.toISOString()).toBe('2026-11-20T20:30:00.000Z')
    expect(calls.filter((call) => call.method === 'GET' && call.path === '/posts/zp_496')).toHaveLength(1)
  })

  test('a partial result is one published leg and one failed leg with the platform error', async () => {
    const post = await duePost()
    responder = () => ({
      post: {
        _id: 'zp_496',
        status: 'partial',
        platforms: [
          {
            accountId: ig.zernioAccountId,
            status: 'published',
            platformPostId: 'ig_media_496',
            publishedUrl: 'https://www.instagram.com/reel/ig496/',
          },
          {
            accountId: tt.zernioAccountId,
            status: 'failed',
            errorCategory: 'auth_expired',
            platformError: { message: 'TikTok token expired; reconnect the account' },
          },
        ],
      },
    })

    const read = await getPost(workspaceId, post.id)

    expect(read.status).toBe('partial')
    const byPlatform = new Map(read.targets.map((target: any) => [target.platform, target]))
    expect(byPlatform.get('instagram').status).toBe('published')
    expect(byPlatform.get('instagram').platformPostUrl).toBe('https://www.instagram.com/reel/ig496/')
    expect(byPlatform.get('tiktok').status).toBe('failed')
    expect(byPlatform.get('tiktok').error).toContain('TikTok token expired')
    expect(byPlatform.get('tiktok').error).toContain('auth_expired')
    expect(read.publishedAt).toBeInstanceOf(Date)
  })

  test('a failed post is counted by analytics as failed, not scheduled', async () => {
    const post = await duePost()
    responder = () => ({
      post: {
        _id: 'zp_496',
        status: 'failed',
        platforms: [
          { accountId: ig.zernioAccountId, status: 'failed', platformError: { message: 'Media rejected' } },
          { accountId: tt.zernioAccountId, status: 'failed', platformError: { message: 'Media rejected' } },
        ],
      },
    })

    const read = await getPost(workspaceId, post.id)
    expect(read.status).toBe('failed')
    expect(read.targets.map((target: any) => target.status)).toEqual(['failed', 'failed'])
    expect(read.publishedAt).toBeNull()

    const analytics = await socialAnalytics(workspaceId, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 3_600_000),
    })
    expect(analytics.posts.failed).toBe(1)
    expect(analytics.posts.scheduled).toBe(0)
  })

  test('a TikTok leg still uploading keeps the post publishing and is asked again next read', async () => {
    const post = await duePost()
    responder = () => ({
      post: {
        _id: 'zp_496',
        status: 'publishing',
        platforms: [
          {
            accountId: ig.zernioAccountId,
            status: 'published',
            platformPostId: 'ig_media_496',
            publishedUrl: 'https://www.instagram.com/reel/ig496/',
          },
          { accountId: tt.zernioAccountId, status: 'uploading' },
        ],
      },
    })

    const read = await getPost(workspaceId, post.id)
    // The Instagram leg is out, so the post is not failed — but TikTok is still
    // uploading, which is `publishing` on that target, not a failure.
    expect(read.status).not.toBe('failed')
    const tiktok = read.targets.find((target: any) => target.platform === 'tiktok')
    expect(tiktok.status).toBe('publishing')

    await getPost(workspaceId, post.id)
    expect(calls.filter((call) => call.path === '/posts/zp_496')).toHaveLength(2)
  })

  test('a scheduled post that is not due yet makes no provider call', async () => {
    const post = await seedPost({
      status: 'scheduled',
      zernioPostId: 'zp_future',
      scheduledFor: new Date(Date.now() + 3_600_000),
      targets: [{ account: ig, status: 'pending' }],
    })

    const read = await getPost(workspaceId, post.id)
    expect(read.status).toBe('scheduled')
    expect(calls).toHaveLength(0)
  })

  test('a provider read that fails leaves the row exactly as it was', async () => {
    const post = await duePost()
    responder = () => new SocialError(502, 'zernio_unreachable', 'Could not reach Zernio.')

    const read = await getPost(workspaceId, post.id)
    expect(read.status).toBe('scheduled')
    expect(read.targets.map((target: any) => target.status)).toEqual(['pending', 'pending'])
    expect(read.publishedAt).toBeNull()
  })

  test('a 404 for a due post is not proof it published', async () => {
    const post = await duePost()
    responder = () => new SocialError(404, 'post_not_found', 'No such post')

    const read = await getPost(workspaceId, post.id)
    expect(read.status).toBe('scheduled')
    expect(read.publishedAt).toBeNull()
  })

  test('the list reconciles the same way, so the calendar shows what is live', async () => {
    const post = await duePost()
    responder = () => providerPost()

    const posts = await listPosts(workspaceId, {})
    const listed = posts.find((row: any) => row.id === post.id)
    expect(listed.status).toBe('published')
    expect(listed.publishedAt?.toISOString()).toBe('2026-11-20T20:30:00.000Z')
  })
})

describe('the webhook', () => {
  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex')

  test('a signed post.published updates the row exactly as the read path does', async () => {
    const post = await duePost()
    const body = JSON.stringify({
      type: 'post.published',
      profiles: [{ externalId: profileExternalId }],
      post: providerPost().post,
    })

    const res = await handleZernioWebhook({ rawBody: body, signature: sign(body), eventId: 'evt_496_1', secret: SECRET })

    expect(res.status).toBe(200)
    const row = await db.socialPost.findUnique({ where: { id: post.id }, include: { targets: true } })
    expect(row.status).toBe('published')
    expect(row.publishedAt?.toISOString()).toBe('2026-11-20T20:30:00.000Z')
    expect(row.targets.every((target: any) => target.status === 'published')).toBe(true)
    // No provider read: the webhook already carries the answer.
    expect(calls).toHaveLength(0)
  })

  test('a redelivered webhook changes nothing', async () => {
    const post = await duePost()
    const body = JSON.stringify({
      type: 'post.published',
      profiles: [{ externalId: profileExternalId }],
      post: providerPost().post,
    })
    await handleZernioWebhook({ rawBody: body, signature: sign(body), eventId: 'evt_496_2', secret: SECRET })
    const first = await db.socialPost.findUnique({ where: { id: post.id } })

    const again = await handleZernioWebhook({ rawBody: body, signature: sign(body), eventId: 'evt_496_2', secret: SECRET })

    expect(again.status).toBe(200)
    const second = await db.socialPost.findUnique({ where: { id: post.id } })
    expect(second.publishedAt?.toISOString()).toBe(first.publishedAt?.toISOString())
    expect(second.status).toBe('published')
  })

  test('a post we do not have is accepted and dropped, not retried', async () => {
    const body = JSON.stringify({
      type: 'post.published',
      profiles: [{ externalId: profileExternalId }],
      post: { _id: 'zp_never_seen', status: 'published' },
    })

    const res = await handleZernioWebhook({ rawBody: body, signature: sign(body), eventId: 'evt_496_3', secret: SECRET })

    expect(res).toEqual({ status: 200, body: { ok: true, ignored: 'unknown_post' } })
  })

  test('the desktop relay applies the same event with the same handler', async () => {
    const post = await duePost()
    const result = await applySocialEvent({
      workspaceId,
      externalId: profileExternalId,
      localWorkspaceId: 'local-a',
      eventId: 'evt_496_4',
      type: 'post.partial',
      detail: {
        _id: 'zp_496',
        status: 'partial',
        platforms: [
          {
            accountId: ig.zernioAccountId,
            status: 'published',
            platformPostId: 'ig_media_496',
            publishedUrl: 'https://www.instagram.com/reel/ig496/',
          },
          {
            accountId: tt.zernioAccountId,
            status: 'failed',
            platformError: { message: 'TikTok refused the video' },
          },
        ],
      },
      payload: {},
    })

    expect(result.status).toBe(200)
    const row = await db.socialPost.findUnique({ where: { id: post.id }, include: { targets: true } })
    expect(row.status).toBe('partial')
    const tiktok = row.targets.find((target: any) => target.platform === 'tiktok')
    expect(tiktok.status).toBe('failed')
    expect(tiktok.error).toContain('TikTok refused the video')
  })
})
