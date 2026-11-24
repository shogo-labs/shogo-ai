// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-543 acceptance — deleting a post whose row still says `scheduled` though
 * it went out days ago.
 *
 * The bug: `deletePost` branched on the row's own `status`, took the "not live"
 * path for a post that was live, and passed Zernio's raw
 * "Published posts cannot be deleted…" back to the agent. The fix reads the post
 * before branching, and treats that refusal — when it still arrives — as proof
 * the post is live, so the caller gets the take-down report instead of the
 * provider's sentence.
 *
 * These run the real service against a real SQLite database with a faked
 * provider: the stale row is exactly what a desktop without its reconcile looks
 * like, and the provider answers the two reads it can (one that works, one that
 * does not).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { SocialError, setSocialClient } = await import('../client')
const { deletePost, listPosts } = await import('../publishing.service')

const db = prisma as any
const suffix = crypto.randomUUID().slice(0, 8)

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

let workspaceId = ''
let profile: any
let ig: any
let tt: any
let threads: any

/** The sentence Russell saw, verbatim from Zernio. */
const PUBLISHED_REFUSAL = new SocialError(
  400,
  'invalid_request_error',
  'Published posts cannot be deleted. Use /v1/posts/6affb805cb373ba90cfece74/unpublish (not supported on Instagram, TikTok or Snapchat).',
  { via: 'relay' },
)

async function seedPost(input: {
  status: string
  zernioPostId: string | null
  scheduledFor?: Date | null
  content?: string
  targets: Array<{ account: any; status: string; url?: string | null }>
}) {
  return db.socialPost.create({
    data: {
      workspaceId,
      status: input.status,
      content: input.content ?? `SHO-543 ${crypto.randomUUID().slice(0, 6)}`,
      zernioPostId: input.zernioPostId,
      scheduledFor: input.scheduledFor ?? null,
      idempotencyKey: `sho543qa:${crypto.randomUUID()}`,
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

/** The row as a desktop that never reconciled leaves it: out since Sunday, still `scheduled`. */
const stalePost = () =>
  seedPost({
    status: 'scheduled',
    zernioPostId: 'zp_qa_543',
    scheduledFor: new Date(Date.now() - 6 * 3_600_000),
    targets: [
      { account: ig, status: 'pending' },
      { account: tt, status: 'pending' },
    ],
  })

const publishedByProvider = () => ({
  post: {
    _id: 'zp_qa_543',
    status: 'published',
    publishedAt: '2026-11-22T20:31:00.000Z',
    platforms: [
      {
        accountId: ig.zernioAccountId,
        status: 'published',
        platformPostId: 'ig_media_543',
        publishedUrl: 'https://www.instagram.com/reel/DgDqxlLjhXT/',
      },
      {
        accountId: tt.zernioAccountId,
        status: 'published',
        platformPostId: 'tt_video_543',
        platformPostUrl: 'https://www.tiktok.com/@acme/video/543',
      },
    ],
  },
})

const deleteCalls = () => calls.filter((call) => call.method === 'DELETE')

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { name: `SHO-543 QA ${suffix}`, slug: `sho543-qa-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `zp_543_${suffix}`,
      externalId: `ws_${workspaceId}`,
      name: 'SHO-543 QA',
    },
  })
  ig = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `qa543_ig_${suffix}`,
      platform: 'instagram',
      username: 'qa.ig',
      isActive: true,
    },
  })
  tt = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `qa543_tt_${suffix}`,
      platform: 'tiktok',
      username: 'qa.tt',
      isActive: true,
    },
  })
  threads = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `qa543_th_${suffix}`,
      platform: 'threads',
      username: 'qa.threads',
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
  responder = () => ({})
  await db.socialPost.deleteMany({ where: { workspaceId } })
})

describe('AC1 — a stale row is reconciled before anything is deleted', () => {
  test('the read proves it is live, so the row is kept and both links come back', async () => {
    const post = await stalePost()
    expect((await db.socialPost.findUnique({ where: { id: post.id } })).status).toBe('scheduled')
    responder = () => publishedByProvider()

    const result = await deletePost(workspaceId, post.id)

    expect(result.deleted).toBe(false)
    expect(result.kept).toBe(true)
    expect(result.removed).toEqual([])
    expect(result.manual.map((entry) => entry.platform).sort()).toEqual(['instagram', 'tiktok'])
    expect(result.manual.map((entry) => entry.url).sort()).toEqual([
      'https://www.instagram.com/reel/DgDqxlLjhXT/',
      'https://www.tiktok.com/@acme/video/543',
    ])
    expect(result.manual.find((entry) => entry.platform === 'instagram')!.reason).toContain(
      'Instagram has no API to remove a published post',
    )
    expect(result.manual.find((entry) => entry.platform === 'tiktok')!.reason).toContain('remove it in the TikTok app')

    // The row was never asked to be deleted at the provider, and it did not go.
    expect(deleteCalls()).toHaveLength(0)
    const row = await db.socialPost.findUnique({ where: { id: post.id }, include: { targets: true } })
    expect(row.status).toBe('published')
    expect(row.targets.map((target: any) => target.status)).toEqual(['published', 'published'])
  })
})

describe('AC2 — the refusal is proof it is live, not an error for the caller', () => {
  test('a read that fails and a refused delete still report the two links, without Zernio\'s sentence', async () => {
    const post = await stalePost()
    responder = (req) => {
      if (req.method === 'GET') return new SocialError(500, 'zernio_500', 'Zernio request failed (500)')
      if (req.method === 'DELETE') return PUBLISHED_REFUSAL
      return {}
    }

    const result = await deletePost(workspaceId, post.id)

    expect(result.deleted).toBe(false)
    expect(result.kept).toBe(true)
    expect(result.manual.map((entry) => entry.platform).sort()).toEqual(['instagram', 'tiktok'])
    // The delete really was attempted and really was refused — this is the
    // refusal path, not a read that happened to work.
    expect(deleteCalls().map((call) => call.path)).toEqual(['/posts/zp_qa_543'])
    // Nothing was learned about the legs, so the links are honestly null rather
    // than invented.
    expect(result.manual.map((entry) => entry.url)).toEqual([null, null])

    const asText = JSON.stringify(result)
    expect(asText.toLowerCase()).not.toContain('cannot be deleted')
    expect(asText).not.toContain('/unpublish')
    expect(asText).toContain('remove it in the Instagram app')
    expect(asText).toContain('remove it in the TikTok app')

    // Kept, and nothing recorded as taken down: the row stays as it was for the
    // next read to reconcile against the provider.
    const row = await db.socialPost.findUnique({ where: { id: post.id }, include: { targets: true } })
    expect(row).not.toBeNull()
    expect(row.status).not.toBe('cancelled')
    expect(row.targets.map((target: any) => target.status)).toEqual(['pending', 'pending'])
  })

  test('an unpublish refusal on the live path is our wording too', async () => {
    const post = await seedPost({
      status: 'published',
      zernioPostId: 'zp_qa_543_live',
      targets: [{ account: threads, status: 'published', url: 'https://threads.net/p/543' }],
    })
    responder = (req) => {
      if (req.method === 'POST' && req.path.endsWith('/unpublish')) return PUBLISHED_REFUSAL
      return {}
    }

    const result = await deletePost(workspaceId, post.id)

    expect(result.manual).toHaveLength(1)
    expect(result.manual[0].url).toBe('https://threads.net/p/543')
    expect(result.manual[0].reason.toLowerCase()).not.toContain('cannot be deleted')
    expect(result.manual[0].reason).toContain('remove it in the threads app')
    // Still live, so the row keeps saying so.
    expect((await db.socialPost.findUnique({ where: { id: post.id } })).status).toBe('published')
  })
})

describe('AC3 — a post that really is still waiting is still deleted outright', () => {
  test('the provider says scheduled, so the row goes and the provider is told to cancel', async () => {
    const post = await seedPost({
      status: 'scheduled',
      zernioPostId: 'zp_qa_543_future',
      scheduledFor: new Date(Date.now() + 3_600_000),
      targets: [
        { account: ig, status: 'pending' },
        { account: tt, status: 'pending' },
      ],
    })
    responder = (req) => {
      if (req.method === 'GET') {
        return {
          post: {
            _id: 'zp_qa_543_future',
            status: 'scheduled',
            platforms: [
              { accountId: ig.zernioAccountId, status: 'scheduled' },
              { accountId: tt.zernioAccountId, status: 'scheduled' },
            ],
          },
        }
      }
      return {}
    }

    const result = await deletePost(workspaceId, post.id)

    expect(result).toEqual({ deleted: true, removed: [], manual: [] })
    expect(deleteCalls().map((call) => call.path)).toEqual(['/posts/zp_qa_543_future'])
    expect(await db.socialPost.findUnique({ where: { id: post.id } })).toBeNull()
    // No take-down was attempted on a post that had not gone out.
    expect(calls.some((call) => call.path.endsWith('/unpublish'))).toBe(false)
  })
})

describe('AC4 — the status filter tells the truth after the read', () => {
  test('a stale row that reconciles to published is not listed as scheduled', async () => {
    const post = await stalePost()
    responder = () => publishedByProvider()

    const scheduled = await listPosts(workspaceId, { status: 'scheduled' })
    expect(scheduled.map((row: any) => row.id)).not.toContain(post.id)

    // It shows up under the status the same read now gives it.
    const published = await listPosts(workspaceId, { status: 'published' })
    expect(published.map((row: any) => row.id)).toContain(post.id)
  })
})
