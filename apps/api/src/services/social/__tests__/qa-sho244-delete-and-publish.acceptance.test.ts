// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-244 acceptance — the two things the incident actually needed.
 *
 * CON-19: one reel went out to Instagram and TikTok with "publish now", the
 * provider took longer than our 15 s client budget, `social_media` reported a
 * failure for a publish that had landed, the agent retried, and every account
 * got a second copy. Shogo Engage then told the person it could not remove the
 * duplicates because "social_media exposes no delete".
 *
 * So this file walks the real Hono routers against a real SQLite database and
 * a faked provider: an agent can delete anything it published (per target,
 * honestly, on the platforms the provider can take down), and a slow or
 * repeated publish can no longer produce a second copy.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { socialRoutes, agentSocialRoutes } = await import('../../../routes/social')
const { CREATE_POST_TIMEOUT_MS, SocialError, setSocialClient } = await import('../client')

const db = prisma as any

const app = new Hono()
app.use('*', async (c, next) => {
  const userId = c.req.header('x-user')
  c.set('auth', { userId, isAuthenticated: !!userId } as never)
  await next()
})
app.route('/api', socialRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }))
app.route(
  '/api/internal',
  agentSocialRoutes({ authorize: async (c: any) => ({ workspaceId: c.req.param('workspaceId') }) }),
)

const request = (path: string, userId: string | null, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...(userId ? { 'x-user': userId } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

/** The agent surface `social_media` calls — no user session, runtime authorises. */
const agent = (path: string, init: RequestInit = {}) => request(`/api/internal/workspaces/${workspaceId}${path}`, null, init)

const suffix = crypto.randomUUID().slice(0, 8)
let owner = ''
let workspaceId = ''
let profileId = ''

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

/** A connected account the way a real connect leaves it. */
async function connectAccount(platform: string, handle: string, providerId: string) {
  return db.socialAccount.create({
    data: {
      workspaceId,
      profileId,
      zernioAccountId: providerId,
      platform,
      username: handle,
      isActive: true,
    },
  })
}

let ig: any
let tt: any
let threads: any
let linkedin: any

beforeAll(async () => {
  const user = await db.user.create({ data: { name: 'owner', email: `sho244-owner-${suffix}@example.com` } })
  owner = user.id
  const workspace = await db.workspace.create({
    data: { name: 'SHO-244', slug: `sho244-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { workspaceId, userId: owner, role: 'owner', projectId: null } })

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `provider_profile_${suffix}`,
      externalId: `ext_${suffix}`,
      name: 'SHO-244',
    },
  })
  profileId = profile.id

  ig = await connectAccount('instagram', 'acme.ig', `provider_ig_${suffix}`)
  tt = await connectAccount('tiktok', 'acme.tt', `provider_tt_${suffix}`)
  threads = await connectAccount('threads', 'acme.threads', `provider_th_${suffix}`)
  linkedin = await connectAccount('linkedin', 'acme.li', `provider_li_${suffix}`)

  fakeProvider()
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
})

beforeEach(() => {
  calls.length = 0
  responder = () => ({})
})

/** A post row in whatever state the case needs, without going through a publish. */
async function seedPost(input: {
  status: string
  zernioPostId?: string | null
  content?: string
  mediaUrls?: string[]
  targets: Array<{ account: any; status: string; url?: string | null }>
}) {
  return db.socialPost.create({
    data: {
      workspaceId,
      status: input.status,
      content: input.content ?? 'Big reel',
      mediaJson: input.mediaUrls ?? ['https://cdn.provider.test/reel.mp4'],
      zernioPostId: input.zernioPostId === undefined ? `provider_post_${crypto.randomUUID().slice(0, 8)}` : input.zernioPostId,
      idempotencyKey: `sho244:${crypto.randomUUID()}`,
      publishedAt: input.status === 'published' || input.status === 'partial' ? new Date() : null,
      targets: {
        create: input.targets.map((target) => ({
          accountId: target.account.id,
          platform: target.account.platform,
          status: target.status,
          platformPostUrl: target.url ?? null,
        })),
      },
    },
    include: { targets: true },
  })
}

describe('AC1 — an agent can delete a draft, a scheduled post and a failed post', () => {
  test('a draft is dropped here and the provider is never called', async () => {
    const post = await seedPost({ status: 'draft', zernioPostId: null, targets: [{ account: ig, status: 'pending' }] })

    const res = await agent(`/social/posts/${post.id}`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect((await res.json()).deleted).toBe(true)
    expect(await db.socialPost.findUnique({ where: { id: post.id } })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('a scheduled post is cancelled at the provider before the row is dropped', async () => {
    const post = await seedPost({
      status: 'scheduled',
      zernioPostId: 'provider_sched_1',
      targets: [{ account: ig, status: 'pending' }],
    })
    responder = () => ({})

    const res = await agent(`/social/posts/${post.id}`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    // A row deleted locally but still queued at Zernio would ship anyway.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['DELETE /posts/provider_sched_1'])
    expect(await db.socialPost.findUnique({ where: { id: post.id } })).toBeNull()
  })

  test('a failed post is removed', async () => {
    const post = await seedPost({ status: 'failed', targets: [{ account: ig, status: 'failed' }] })

    const res = await agent(`/social/posts/${post.id}`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(await db.socialPost.findUnique({ where: { id: post.id } })).toBeNull()
  })

  test('a publish still in flight is refused with the reason, never deleted', async () => {
    const post = await seedPost({ status: 'publishing', zernioPostId: null, targets: [{ account: ig, status: 'publishing' }] })

    const res = await agent(`/social/posts/${post.id}`, { method: 'DELETE' })

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('post_in_flight')
    expect(await db.socialPost.findUnique({ where: { id: post.id } })).not.toBeNull()
  })
})

describe('AC2 — a published post is unpublished once per target', () => {
  test('Threads and LinkedIn each get their own platform and provider account', async () => {
    const post = await seedPost({
      status: 'published',
      zernioPostId: 'provider_live_1',
      targets: [
        { account: threads, status: 'published', url: 'https://threads.net/p/1' },
        { account: linkedin, status: 'published', url: 'https://linkedin.com/p/2' },
      ],
    })

    const res = await agent(`/social/posts/${post.id}`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deleted).toBe(false)
    expect(body.kept).toBe(true)
    expect(body.manual).toEqual([])
    expect(body.removed.map((entry: any) => entry.platform).sort()).toEqual(['linkedin', 'threads'])

    const unpublish = calls.filter((call) => call.path.endsWith('/unpublish'))
    expect(unpublish).toHaveLength(2)
    expect(unpublish.map((call) => `${call.path} ${call.body.platform} ${call.body.accountId}`).sort()).toEqual(
      [
        `/posts/provider_live_1/unpublish linkedin ${linkedin.zernioAccountId}`,
        `/posts/provider_live_1/unpublish threads ${threads.zernioAccountId}`,
      ].sort(),
    )

    const targets = await db.socialPostTarget.findMany({ where: { postId: post.id } })
    expect(targets.map((target: any) => target.status)).toEqual(['cancelled', 'cancelled'])
    // Nothing is live any more, so the row records that rather than staying `published`.
    expect((await db.socialPost.findUnique({ where: { id: post.id } })).status).toBe('cancelled')
  })
})

describe('AC3 — Instagram and TikTok come back to the person, with their links', () => {
  test('neither target makes an unpublish call and both carry a URL and a reason', async () => {
    const post = await seedPost({
      status: 'published',
      zernioPostId: 'provider_live_2',
      targets: [
        { account: ig, status: 'published', url: 'https://instagram.com/p/1' },
        { account: tt, status: 'published', url: 'https://tiktok.com/@acme.tt/video/2' },
      ],
    })

    const res = await agent(`/social/posts/${post.id}`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(calls.filter((call) => call.path.endsWith('/unpublish'))).toHaveLength(0)
    expect(body.removed).toEqual([])
    expect(body.manual.map((entry: any) => entry.platform).sort()).toEqual(['instagram', 'tiktok'])
    expect(body.manual.map((entry: any) => entry.url).sort()).toEqual([
      'https://instagram.com/p/1',
      'https://tiktok.com/@acme.tt/video/2',
    ])
    // The sentence Russell saw was "no delete exists"; the replacement names the app.
    expect(body.manual.find((entry: any) => entry.platform === 'tiktok').reason).toContain('TikTok app')

    // Something is still live, so the row stays as the record of it.
    expect((await db.socialPost.findUnique({ where: { id: post.id } })).status).toBe('published')
  })

  test('a mixed post reports both what came down and what did not', async () => {
    const post = await seedPost({
      status: 'published',
      zernioPostId: 'provider_live_3',
      targets: [
        { account: threads, status: 'published', url: 'https://threads.net/p/9' },
        { account: ig, status: 'published', url: 'https://instagram.com/p/9' },
      ],
    })

    const body = await (await agent(`/social/posts/${post.id}`, { method: 'DELETE' })).json()

    expect(body.removed.map((entry: any) => entry.platform)).toEqual(['threads'])
    expect(body.manual.map((entry: any) => entry.platform)).toEqual(['instagram'])
  })

  test('the person’s own screen sees the same report the agent does', async () => {
    const post = await seedPost({
      status: 'published',
      zernioPostId: 'provider_live_4',
      targets: [{ account: ig, status: 'published', url: 'https://instagram.com/p/4' }],
    })

    const res = await request(`/api/workspaces/${workspaceId}/social/posts/${post.id}`, owner, { method: 'DELETE' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.manual).toHaveLength(1)
    expect(body.manual[0].url).toBe('https://instagram.com/p/4')
  })

  test('a live target with no provider post id is handed over instead of calling /posts/null', async () => {
    const post = await seedPost({
      status: 'published',
      zernioPostId: null,
      targets: [{ account: threads, status: 'published', url: 'https://threads.net/p/7' }],
    })

    const body = await (await agent(`/social/posts/${post.id}`, { method: 'DELETE' })).json()

    expect(calls).toHaveLength(0)
    expect(body.manual).toHaveLength(1)
    expect(body.manual[0].reason).toContain('No provider post id')
  })
})

describe('AC4 — a slow publish is not a failed publish', () => {
  test('the create carries the publish budget, not the 15 s read default', async () => {
    responder = (req) =>
      req.path === '/posts' && req.method === 'POST'
        ? {
            post: { _id: 'provider_slow_1' },
            platforms: [{ accountId: ig.zernioAccountId, platform: 'instagram', url: 'https://instagram.com/p/slow' }],
          }
        : {}

    const res = await agent('/social/posts', {
      method: 'POST',
      body: JSON.stringify({
        content: 'Slow reel',
        accountIds: [ig.id],
        mediaUrls: ['https://cdn.provider.test/slow.mp4'],
        publishNow: true,
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.post.outcome).toBe('confirmed')
    expect(body.post.status).toBe('published')

    const create = calls.find((call) => call.method === 'POST' && call.path === '/posts')!
    // The whole point of the card: a 34 MB reel is not a 15 s request.
    expect(create.timeoutMs).toBe(CREATE_POST_TIMEOUT_MS)
    expect(create.idempotencyKey).toBeTruthy()
  })

  test('a publish that outruns even that budget comes back unconfirmed, not as an error', async () => {
    responder = (req) => {
      if (req.path === '/posts' && req.method === 'POST') {
        return new SocialError(504, 'zernio_timeout', 'Zernio did not answer in time.')
      }
      return {}
    }

    const res = await agent('/social/posts', {
      method: 'POST',
      body: JSON.stringify({
        content: 'Timed out reel',
        accountIds: [ig.id],
        mediaUrls: ['https://cdn.provider.test/timeout.mp4'],
        publishNow: true,
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    // Not a throw: an error is what told the agent to retry, and that is what
    // published the second copy.
    expect(body.post.outcome).toBe('unconfirmed')
    expect(body.post.status).toBe('publishing')
  })

  test('the next read reconciles it to published, with the target URL', async () => {
    responder = (req) => {
      if (req.path === '/posts' && req.method === 'POST') {
        return new SocialError(504, 'zernio_timeout', 'Zernio did not answer in time.')
      }
      if (req.path === '/posts' && req.method === 'GET') {
        return {
          posts: [
            {
              _id: 'provider_late_1',
              content: 'Reconciled reel',
              platforms: [
                {
                  accountId: ig.zernioAccountId,
                  platform: 'instagram',
                  status: 'published',
                  url: 'https://instagram.com/p/late',
                },
              ],
            },
          ],
        }
      }
      return {}
    }

    const created = await (
      await agent('/social/posts', {
        method: 'POST',
        body: JSON.stringify({
          content: 'Reconciled reel',
          accountIds: [ig.id],
          mediaUrls: ['https://cdn.provider.test/late.mp4'],
          publishNow: true,
        }),
      })
    ).json()
    expect(created.post.outcome).toBe('unconfirmed')

    // A minute later: past the reconcile grace, which exists so a publish that
    // is still in flight is not declared lost.
    await db.socialPost.update({
      where: { id: created.post.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    })

    const listed = await (await agent('/social/posts')).json()
    const post = listed.posts.find((entry: any) => entry.id === created.post.id)
    expect(post.status).toBe('published')
    expect(post.zernioPostId).toBe('provider_late_1')
    expect(post.targets[0].platformPostUrl).toBe('https://instagram.com/p/late')
  })
})

describe('AC5 — the retry that made the duplicate returns the first post', () => {
  // Each case gets its own content: the dedupe window is 15 minutes wide, so a
  // shared reel would make case two answer case one's post.
  let reelNumber = 0
  const reel = () => {
    reelNumber += 1
    return {
      content: `Launch reel ${reelNumber}`,
      mediaUrls: [`https://cdn.provider.test/launch-${reelNumber}.mp4`],
    }
  }

  beforeEach(() => {
    responder = (req) =>
      req.path === '/posts' && req.method === 'POST'
        ? {
            post: { _id: `provider_${crypto.randomUUID().slice(0, 8)}` },
            platforms: [{ accountId: ig.zernioAccountId, platform: 'instagram', url: 'https://instagram.com/p/launch' }],
          }
        : {}
  })

  test('posting the same reel again publishes nothing and says so', async () => {
    const post = reel()
    const first = await (
      await agent('/social/posts', {
        method: 'POST',
        body: JSON.stringify({ ...post, accountIds: [ig.id, tt.id], publishNow: true }),
      })
    ).json()
    expect(first.post.deduped).toBeUndefined()

    const second = await (
      await agent('/social/posts', {
        method: 'POST',
        body: JSON.stringify({ ...post, accountIds: [ig.id, tt.id], publishNow: true }),
      })
    ).json()

    expect(second.post.id).toBe(first.post.id)
    expect(second.post.deduped).toBe(true)
    // Exactly one create reached the provider — this is the duplicate CON-19 got.
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/posts')).toHaveLength(1)
    expect(await db.socialPost.count({ where: { workspaceId, content: post.content } })).toBe(1)
  })

  test('a deliberate repost goes through when allowDuplicate says so', async () => {
    const post = reel()
    const first = await (
      await agent('/social/posts', {
        method: 'POST',
        body: JSON.stringify({ ...post, accountIds: [ig.id, tt.id], publishNow: true }),
      })
    ).json()

    const again = await (
      await agent('/social/posts', {
        method: 'POST',
        body: JSON.stringify({ ...post, accountIds: [ig.id, tt.id], publishNow: true, allowDuplicate: true }),
      })
    ).json()

    expect(again.post.id).not.toBe(first.post.id)
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/posts')).toHaveLength(2)
    expect(await db.socialPost.count({ where: { workspaceId, content: post.content } })).toBe(2)
  })
})
