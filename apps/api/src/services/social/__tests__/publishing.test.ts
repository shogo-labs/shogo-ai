// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Publishing fan-out against an in-memory Prisma double and a fake Zernio
 * client: no network, no database, but the real service code — including the
 * per-target partial-failure path the composer depends on.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

interface Row {
  [key: string]: any
}

const store = {
  posts: [] as Row[],
  targets: [] as Row[],
  accounts: [] as Row[],
  profiles: [] as Row[],
}

let idCounter = 0
const nextId = (prefix: string) => `${prefix}_${++idCounter}`

/**
 * Prisma returns only the columns a `select` names. The double has to do the
 * same: a query that forgets `zernioAccountId` must fail here too, or a mocked
 * row carrying the whole account hides a reconcile that never runs.
 */
function projectAccount(account: Row | undefined, select?: Row): Row | null {
  if (!account) return null
  if (!select) return account
  const picked: Row = {}
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) picked[key] = account[key]
  }
  return picked
}

function hydratePost(post: Row, query?: Row): Row {
  const accountSelect = query?.include?.targets?.include?.account?.select
  return {
    ...post,
    targets: store.targets
      .filter((target) => target.postId === post.id)
      .map((target) => ({
        ...target,
        account: projectAccount(
          store.accounts.find((account) => account.id === target.accountId),
          accountSelect,
        ),
      })),
  }
}

/** The calendar window: workspace + status filter + an OR of scheduled/published ranges. */
function inRange(value: any, range: any): boolean {
  if (!value) return false
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (range.gte && time < new Date(range.gte).getTime()) return false
  if (range.lte && time > new Date(range.lte).getTime()) return false
  return true
}

function matchesCalendar(post: Row, where: Row): boolean {
  if (where.workspaceId && post.workspaceId !== where.workspaceId) return false
  if (where.status?.not && post.status === where.status.not) return false
  if (Array.isArray(where.OR)) {
    return where.OR.some((clause: Row) =>
      Object.entries(clause).every(([key, range]) => inRange(post[key], range)),
    )
  }
  return true
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value instanceof Date) {
      return row[key] instanceof Date
        ? row[key].getTime() === value.getTime()
        : new Date(row[key]).getTime() === value.getTime()
    }
    if (value && typeof value === 'object') {
      const clause = value as Row
      if ('in' in clause) return (clause.in as unknown[]).includes(row[key])
      if ('gte' in clause || 'lte' in clause || 'gt' in clause || 'lt' in clause) {
        return inRange(row[key], clause)
      }
    }
    return row[key] === value
  })
}

const dbMock = {
  socialAccount: {
    findMany: async ({ where }: any) => store.accounts.filter((account) => matches(account, where)),
    findUnique: async ({ where }: any) => store.accounts.find((account) => matches(account, where)) ?? null,
  },
  socialProfile: {
    findUnique: async ({ where }: any) => store.profiles.find((profile) => matches(profile, where)) ?? null,
    create: async ({ data }: any) => {
      const profile = { id: nextId('profile'), ...data }
      store.profiles.push(profile)
      return profile
    },
  },
  socialPost: {
    findUnique: async ({ where }: any) => store.posts.find((post) => matches(post, where)) ?? null,
    findFirst: async (query: any) => {
      const post = store.posts.find((row) => matches(row, query.where))
      return post ? hydratePost(post, query) : null
    },
    findMany: async (query: any) =>
      store.posts
        .filter((post) =>
          Array.isArray(query.where?.OR) ? matchesCalendar(post, query.where) : matches(post, query.where),
        )
        .map((post) => hydratePost(post, query)),
    create: async ({ data }: any) => {
      const { targets, ...rest } = data
      const post = {
        id: nextId('post'),
        publishedAt: null,
        scheduledFor: null,
        zernioPostId: null,
        createdAt: new Date(),
        ...rest,
      }
      store.posts.push(post)
      for (const target of targets?.create ?? []) {
        store.targets.push({ id: nextId('target'), postId: post.id, status: 'pending', ...target })
      }
      return post
    },
    update: async ({ where, data }: any) => {
      const post = store.posts.find((row) => matches(row, where))
      if (!post) throw new Error('post not found')
      Object.assign(post, data)
      return post
    },
    delete: async ({ where }: any) => {
      const index = store.posts.findIndex((row) => matches(row, where))
      if (index === -1) throw new Error('post not found')
      const [removed] = store.posts.splice(index, 1)
      store.targets = store.targets.filter((target) => target.postId !== removed.id)
      return removed
    },
  },
  socialPostTarget: {
    findFirst: async ({ where }: any) => {
      const target = store.targets.find((row) => matches(row, where))
      if (!target) return null
      const post = store.posts.find((row) => row.id === target.postId)
      return { ...target, post: post ? { id: post.id, content: post.content } : null }
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const target of store.targets) {
        if (matches(target, where)) {
          Object.assign(target, data)
          count++
        }
      }
      return { count }
    },
    update: async ({ where, data }: any) => {
      const target = store.targets.find((row) => matches(row, where))
      if (!target) throw new Error('target not found')
      Object.assign(target, data)
      return target
    },
    findMany: async ({ where }: any) => store.targets.filter((target) => matches(target, where)),
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: dbMock }))

const { createPost, updatePost, deletePost, calendar, postIdempotencyKey, getPost, listPosts } = await import(
  '../publishing.service'
)
const { setSocialClient, CREATE_POST_TIMEOUT_MS } = await import('../client')

const calls: any[] = []
let providerReply: any = {}
/** What `GET /posts` answers — the reconcile read. */
let providerList: any = { posts: [] }
/** Make the next `POST /posts` behave like a provider that never answered. */
let createTimesOut = false

function useFakeClient() {
  calls.length = 0
  providerReply = {}
  providerList = { posts: [] }
  createTimesOut = false
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.path === '/profiles') return { id: 'zernio_profile_1' }
      if (req.method === 'GET' && req.path === '/posts') return providerList
      if (req.path === '/posts') {
        if (createTimesOut) {
          const { SocialError } = await import('../client')
          throw new SocialError(504, 'zernio_timeout', 'Zernio did not answer in time.')
        }
        return providerReply
      }
      if (req.path.startsWith('/posts/')) return {}
      throw new Error(`unexpected ${req.path}`)
    },
  })
}

/**
 * Instagram and TikTok refuse a text-only post, so every test that targets one
 * of them carries media. A single public URL is enough — nothing is fetched.
 */
const IMAGE = 'https://cdn.example.com/launch.jpg'

const createCalls = () => calls.filter((call) => call.method === 'POST' && call.path === '/posts')

function seedAccounts() {
  store.posts.length = 0
  store.targets.length = 0
  store.accounts.length = 0
  store.profiles.length = 0
  store.accounts.push(
    { id: 'acct_ig', workspaceId: 'ws_1', zernioAccountId: 'zernio_ig', platform: 'instagram', username: 'brand.ig', isActive: true },
    { id: 'acct_tt', workspaceId: 'ws_1', zernioAccountId: 'zernio_tt', platform: 'tiktok', username: 'brand.tt', isActive: true },
    { id: 'acct_threads', workspaceId: 'ws_1', zernioAccountId: 'zernio_threads', platform: 'threads', username: 'brand.threads', isActive: true },
    { id: 'acct_x', workspaceId: 'ws_1', zernioAccountId: 'zernio_x', platform: 'x', username: 'brand.x.live', isActive: true },
    { id: 'acct_dead', workspaceId: 'ws_1', zernioAccountId: 'zernio_dead', platform: 'x', username: 'brand.x', isActive: false },
  )
}

beforeEach(() => {
  seedAccounts()
  useFakeClient()
})

describe('post idempotency key', () => {
  const base = { content: 'Launch day', accountIds: ['a', 'b'], mediaUrls: [] }

  test('is stable for the same immediate post', () => {
    const now = new Date('2026-10-19T12:00:10Z')
    expect(postIdempotencyKey('ws_1', { ...base, scheduledFor: null }, now)).toBe(
      postIdempotencyKey('ws_1', { ...base, scheduledFor: null }, new Date('2026-10-19T12:00:50Z')),
    )
  })

  test('changes with the account set and the schedule', () => {
    const now = new Date('2026-10-19T12:00:00Z')
    const key = postIdempotencyKey('ws_1', { ...base, scheduledFor: null }, now)
    expect(postIdempotencyKey('ws_1', { ...base, accountIds: ['a'], scheduledFor: null }, now)).not.toBe(key)
    expect(postIdempotencyKey('ws_1', { ...base, scheduledFor: new Date('2026-10-20T09:00:00Z') }, now)).not.toBe(key)
    expect(postIdempotencyKey('ws_2', { ...base, scheduledFor: null }, now)).not.toBe(key)
  })
})

describe('publishing fan-out', () => {
  test('records a partial failure per target instead of failing the post', async () => {
    providerReply = {
      id: 'zernio_post_1',
      status: 'published',
      targets: [
        { accountId: 'zernio_ig', status: 'published', postId: 'ig_1', url: 'https://instagram.com/p/ig_1' },
        { accountId: 'zernio_tt', status: 'failed', error: 'TikTok rejected the video' },
      ],
    }

    const post = await createPost('ws_1', 'Acme', {
      content: 'Launch day',
      accountIds: ['acct_ig', 'acct_tt'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })

    expect(post.status).toBe('partial')
    const ig = post.targets.find((target: any) => target.accountId === 'acct_ig')
    const tt = post.targets.find((target: any) => target.accountId === 'acct_tt')
    expect(ig.status).toBe('published')
    expect(ig.platformPostUrl).toBe('https://instagram.com/p/ig_1')
    expect(tt.status).toBe('failed')
    expect(tt.error).toBe('TikTok rejected the video')

    const sent = calls.find((call) => call.path === '/posts')
    expect(sent.body.platforms.map((platform: any) => platform.accountId)).toEqual(['zernio_ig', 'zernio_tt'])
    expect(sent.idempotencyKey).toBe(post.idempotencyKey)
  })

  test('a scheduled post stays scheduled and is not marked publishing', async () => {
    providerReply = { id: 'zernio_post_2', status: 'scheduled' }
    const when = new Date(Date.now() + 3_600_000)

    const post = await createPost('ws_1', 'Acme', {
      content: 'Tomorrow',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      scheduledFor: when.toISOString(),
    })

    expect(post.status).toBe('scheduled')
    expect(post.targets[0].status).toBe('pending')
    expect(calls.find((call) => call.path === '/posts').body.scheduledFor).toBe(when.toISOString())
  })

  test('a provider reply with no target detail marks the post published', async () => {
    providerReply = { id: 'zernio_post_3' }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Hello',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })
    expect(post.status).toBe('published')
    expect(post.targets[0].status).toBe('published')
  })

  test('a provider failure fails the post and its targets', async () => {
    setSocialClient({
      mode: 'cloud',
      async request(req: any) {
        if (req.path === '/profiles') return { id: 'zernio_profile_1' }
        const { SocialError } = await import('../client')
        throw new SocialError(400, 'rate_limited', 'Instagram rate limited', { platform: 'instagram' })
      },
    })

    const error = await createPost('ws_1', 'Acme', {
      content: 'Hello',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    }).catch((err) => err)

    expect(error.message).toBe('Instagram rate limited')
    expect(store.posts[0].status).toBe('failed')
    expect(store.targets[0].status).toBe('failed')
    expect(store.targets[0].error).toBe('Instagram rate limited')
  })

  test('a rescheduled submission reuses the first post', async () => {
    providerReply = { id: 'zernio_post_4', status: 'scheduled' }
    const when = new Date(Date.now() + 7_200_000).toISOString()
    const input = {
      content: 'Same text',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      scheduledFor: when,
    }

    const first = await createPost('ws_1', 'Acme', input)
    const second = await createPost('ws_1', 'Acme', input)

    expect(second.id).toBe(first.id)
    expect(store.posts).toHaveLength(1)
    expect(calls.filter((call) => call.path === '/posts')).toHaveLength(1)
  })

  test('refuses an empty post, an unknown account and a disconnected account', async () => {
    await expect(createPost('ws_1', 'Acme', { content: '', accountIds: ['acct_ig'] })).rejects.toThrow(
      'A post needs text or media',
    )
    await expect(
      createPost('ws_1', 'Acme', { content: 'Hi', accountIds: ['acct_missing'], publishNow: true }),
    ).rejects.toThrow('Unknown account')
    await expect(
      createPost('ws_1', 'Acme', { content: 'Hi', accountIds: ['acct_dead'], publishNow: true }),
    ).rejects.toThrow('Reconnect @brand.x')
  })

  test('a draft is stored locally and never sent to Zernio', async () => {
    const post = await createPost('ws_1', 'Acme', { content: 'Idea', accountIds: [], draft: true })
    expect(post.status).toBe('draft')
    expect(calls.filter((call) => call.path === '/posts')).toHaveLength(0)
  })

  test('rescheduling a scheduled post updates it at Zernio, not just locally', async () => {
    providerReply = { id: 'zernio_post_9', status: 'scheduled' }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Later',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    })
    calls.length = 0

    const when = new Date(Date.now() + 7_200_000)
    await updatePost('ws_1', post.id, { scheduledFor: when.toISOString() })

    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch.path).toBe('/posts/zernio_post_9')
    expect(patch.body.scheduledFor).toBe(when.toISOString())
    expect(store.posts[0].scheduledFor).toEqual(when)
  })

  test('deleting a scheduled post cancels it at Zernio before dropping the row', async () => {
    providerReply = { id: 'zernio_post_10', status: 'scheduled' }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Cancel me',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    })
    calls.length = 0

    await deletePost('ws_1', post.id)

    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/posts/zernio_post_10')
    expect(store.posts).toHaveLength(0)
  })

  test('a failed cancel keeps the post so it can be retried', async () => {
    providerReply = { id: 'zernio_post_11', status: 'scheduled' }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Keep me',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    })
    setSocialClient({
      mode: 'cloud',
      async request(req: any) {
        if (req.method === 'DELETE') {
          const { SocialError } = await import('../client')
          throw new SocialError(502, 'zernio_unreachable', 'Could not reach Zernio.')
        }
        return {}
      },
    })

    await expect(deletePost('ws_1', post.id)).rejects.toThrow('Could not reach Zernio')
    expect(store.posts).toHaveLength(1)
  })

  test('calendar returns only scheduled or published posts in the window', async () => {
    providerReply = { id: 'zernio_post_5', status: 'scheduled' }
    const when = new Date(Date.now() + 86_400_000)
    await createPost('ws_1', 'Acme', {
      content: 'Later',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      scheduledFor: when.toISOString(),
    })
    store.posts.push({ id: 'post_draft', workspaceId: 'ws_1', status: 'draft', content: 'Draft', createdAt: new Date() })

    const rows = await calendar('ws_1', new Date(Date.now() - 86_400_000), new Date(Date.now() + 7 * 86_400_000))
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('Later')
  })
})

describe('the body Zernio actually reads', () => {
  test('media goes out as mediaItems and customMedia, never mediaUrls', async () => {
    providerReply = { id: 'zernio_post_20' }
    const clip = 'https://cdn.example.com/reel.mp4'

    await createPost('ws_1', 'Acme', {
      content: 'Launch day',
      accountIds: ['acct_ig', 'acct_tt'],
      mediaUrls: [IMAGE, clip],
      variants: { acct_tt: { mediaUrls: [clip] } },
      publishNow: true,
    })

    const sent = calls.find((call) => call.path === '/posts')
    expect(sent.body.mediaItems).toEqual([
      { url: IMAGE, type: 'image' },
      { url: clip, type: 'video' },
    ])
    expect(sent.body.mediaUrls).toBeUndefined()

    const tiktok = sent.body.platforms.find((platform: any) => platform.accountId === 'zernio_tt')
    expect(tiktok.customMedia).toEqual([{ url: clip, type: 'video' }])
    const instagram = sent.body.platforms.find((platform: any) => platform.accountId === 'zernio_ig')
    expect(instagram.customMedia).toBeUndefined()
  })

  test('an unknown extension is left for Zernio to infer rather than guessed at', async () => {
    providerReply = { id: 'zernio_post_21' }
    await createPost('ws_1', 'Acme', {
      content: 'Odd file',
      accountIds: ['acct_ig'],
      mediaUrls: ['https://cdn.example.com/asset'],
      publishNow: true,
    })

    expect(calls.find((call) => call.path === '/posts').body.mediaItems).toEqual([
      { url: 'https://cdn.example.com/asset' },
    ])
  })

  test('a TikTok target defaults to the creator inbox, not a direct publish', async () => {
    providerReply = { id: 'zernio_post_22' }
    await createPost('ws_1', 'Acme', {
      content: 'Draft on TikTok',
      accountIds: ['acct_tt'],
      mediaUrls: ['https://cdn.example.com/reel.mp4'],
      publishNow: true,
    })

    const tiktok = calls
      .find((call) => call.path === '/posts')
      .body.platforms.find((platform: any) => platform.accountId === 'zernio_tt')
    expect(tiktok.platformSpecificData).toEqual({ tiktokSettings: { draft: true } })
  })

  test('a caller that supplies a privacy level gets a direct publish', async () => {
    providerReply = { id: 'zernio_post_23' }
    await createPost('ws_1', 'Acme', {
      content: 'Straight to TikTok',
      accountIds: ['acct_tt'],
      mediaUrls: ['https://cdn.example.com/reel.mp4'],
      variants: {
        acct_tt: { platformSpecificData: { tiktokSettings: { privacyLevel: 'PUBLIC_TO_EVERYONE' } } },
      },
      publishNow: true,
    })

    const tiktok = calls
      .find((call) => call.path === '/posts')
      .body.platforms.find((platform: any) => platform.accountId === 'zernio_tt')
    expect(tiktok.platformSpecificData.tiktokSettings).toEqual({ privacyLevel: 'PUBLIC_TO_EVERYONE' })
  })

  test('a text-only post to Instagram is refused before Zernio is called', async () => {
    const error = await createPost('ws_1', 'Acme', {
      content: 'No picture',
      accountIds: ['acct_ig'],
      publishNow: true,
    }).catch((err) => err)

    expect(error.code).toBe('media_required')
    expect(error.message).toContain('instagram @brand.ig')
    expect(calls.filter((call) => call.path === '/posts')).toHaveLength(0)
  })

  test('a variant that carries its own media satisfies the rule', async () => {
    providerReply = { id: 'zernio_post_24' }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Per-account picture',
      accountIds: ['acct_ig'],
      variants: { acct_ig: { mediaUrls: [IMAGE] } },
      publishNow: true,
    })
    expect(post.status).toBe('published')
  })
})

describe('deleting a post that never went live', () => {
  test('a draft is dropped here and never sent to the provider', async () => {
    const post = await createPost('ws_1', 'Acme', { content: 'Idea', accountIds: [], draft: true })
    calls.length = 0

    const result = await deletePost('ws_1', post.id)

    expect(result).toEqual({ deleted: true, removed: [], manual: [] })
    expect(store.posts).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('a failed post is removed', async () => {
    const post = await createPost('ws_1', 'Acme', {
      content: 'Never made it',
      accountIds: ['acct_x'],
      publishNow: true,
    })
    store.posts[0].status = 'failed'
    calls.length = 0

    const result = await deletePost('ws_1', post.id)

    expect(result.deleted).toBe(true)
    expect(store.posts).toHaveLength(0)
  })
})

describe('deleting a post that went live', () => {
  test('each target the provider can unpublish is taken down with its own platform and account', async () => {
    providerReply = {
      id: 'zernio_post_30',
      targets: [
        { accountId: 'zernio_threads', status: 'published', postId: 'th_1', url: 'https://threads.net/p/th_1' },
        { accountId: 'zernio_x', status: 'published', postId: 'x_1', url: 'https://x.com/brand/status/x_1' },
      ],
    }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Live post',
      accountIds: ['acct_threads', 'acct_x'],
      publishNow: true,
    })
    expect(post.status).toBe('published')
    calls.length = 0

    const result = await deletePost('ws_1', post.id)

    const unpublish = calls.filter((call) => call.path.endsWith('/unpublish'))
    expect(unpublish).toHaveLength(2)
    expect(unpublish[0].path).toBe('/posts/zernio_post_30/unpublish')
    expect(unpublish[0].method).toBe('POST')
    // Zernio names X `twitter` in its own platform list.
    expect(unpublish.map((call) => call.body)).toEqual([
      { platform: 'threads', accountId: 'zernio_threads' },
      { platform: 'twitter', accountId: 'zernio_x' },
    ])

    expect(result.deleted).toBe(false)
    expect(result.kept).toBe(true)
    expect(result.removed.map((entry) => entry.platform)).toEqual(['threads', 'x'])
    expect(result.removed[0].url).toBe('https://threads.net/p/th_1')
    expect(result.manual).toEqual([])
    // Nothing is live any more, so the record says so instead of staying published.
    expect(store.posts[0].status).toBe('cancelled')
    expect(store.targets.every((target) => target.status === 'cancelled')).toBe(true)
  })

  test('an Instagram or TikTok target makes no unpublish call and comes back to remove by hand', async () => {
    providerReply = {
      id: 'zernio_post_31',
      targets: [
        { accountId: 'zernio_ig', status: 'published', url: 'https://instagram.com/p/ig_2' },
        { accountId: 'zernio_tt', status: 'published', url: 'https://tiktok.com/@brand/video/2' },
      ],
    }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Reel',
      accountIds: ['acct_ig', 'acct_tt'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })
    calls.length = 0

    const result = await deletePost('ws_1', post.id)

    expect(calls.filter((call) => call.path.endsWith('/unpublish'))).toHaveLength(0)
    expect(result.removed).toEqual([])
    expect(result.manual.map((entry) => entry.platform)).toEqual(['instagram', 'tiktok'])
    expect(result.manual[0].url).toBe('https://instagram.com/p/ig_2')
    expect(result.manual[0].account).toBe('brand.ig')
    expect(result.manual[0].reason).toContain('Instagram')
    expect(result.manual[0].reason).toContain('remove it in the Instagram app')
    // Still live on both platforms: the row keeps saying so.
    expect(store.posts[0].status).toBe('published')
  })

  test('a mixed post reports both what came down and what did not', async () => {
    providerReply = {
      id: 'zernio_post_32',
      targets: [
        { accountId: 'zernio_ig', status: 'published', url: 'https://instagram.com/p/ig_3' },
        { accountId: 'zernio_threads', status: 'published', url: 'https://threads.net/p/th_3' },
      ],
    }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Cross-posted',
      accountIds: ['acct_ig', 'acct_threads'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })
    calls.length = 0

    const result = await deletePost('ws_1', post.id)

    expect(calls.filter((call) => call.path.endsWith('/unpublish'))).toHaveLength(1)
    expect(result.removed.map((entry) => entry.platform)).toEqual(['threads'])
    expect(result.manual.map((entry) => entry.platform)).toEqual(['instagram'])
    expect(store.posts[0].status).toBe('published')
  })

  test('a target still in flight is left alone and reported, not silently dropped', async () => {
    providerReply = {
      id: 'zernio_post_33',
      targets: [
        { accountId: 'zernio_threads', status: 'published', url: 'https://threads.net/p/th_4' },
        { accountId: 'zernio_ig', status: 'pending' },
      ],
    }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Half out',
      accountIds: ['acct_threads', 'acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })
    calls.length = 0

    const result = await deletePost('ws_1', post.id)

    expect(result.removed.map((entry) => entry.platform)).toEqual(['threads'])
    expect(result.manual.map((entry) => entry.platform)).toEqual(['instagram'])
    expect(result.manual[0].reason).toContain('Still being published')
  })

  test('a publish with no provider id yet is refused rather than deleted', async () => {
    createTimesOut = true
    const post = await createPost('ws_1', 'Acme', {
      content: 'In flight',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })
    expect(post.status).toBe('publishing')
    calls.length = 0

    const error = await deletePost('ws_1', post.id).catch((err) => err)

    expect(error.status).toBe(409)
    expect(error.code).toBe('post_in_flight')
    expect(error.message).toContain('again in a minute')
    expect(store.posts).toHaveLength(1)
    expect(calls).toHaveLength(0)
  })

  test('a live target with no provider post id is handed to the person, never `/posts/null/unpublish`', async () => {
    providerReply = { id: 'zernio_post_50' }
    const post = await createPost('ws_1', 'Acme', {
      content: 'Reconciled from a relay',
      accountIds: ['acct_x'],
      publishNow: true,
    })
    // A row written by the relay path can be live with no id to unpublish against.
    store.posts.find((row: any) => row.id === post.id)!.zernioPostId = null
    calls.length = 0

    const result = await deletePost('ws_1', post.id)

    expect(result.deleted).toBe(false)
    expect(result.removed).toEqual([])
    expect(result.manual.map((entry) => entry.platform)).toEqual(['x'])
    expect(result.manual[0].reason).toContain('No provider post id')
    expect(calls.some((call) => call.path.includes('unpublish'))).toBe(false)
    expect(calls.some((call) => call.path.includes('null'))).toBe(false)
  })
})

describe('a publish that outruns the clock', () => {
  test('the create-post call gets the publish budget, not the 15 s read default', async () => {
    providerReply = { id: 'zernio_post_40' }
    await createPost('ws_1', 'Acme', {
      content: 'Big reel',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })

    expect(CREATE_POST_TIMEOUT_MS).toBeGreaterThan(15_000)
    expect(createCalls()[0].timeoutMs).toBe(CREATE_POST_TIMEOUT_MS)
  })

  test('a publish that still times out comes back unconfirmed instead of failing', async () => {
    createTimesOut = true

    const post = await createPost('ws_1', 'Acme', {
      content: 'Big reel',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })

    expect(post.outcome).toBe('unconfirmed')
    expect(post.status).toBe('publishing')
    expect(post.zernioPostId).toBeNull()
    // Not failed: it may well be live, and the next read finds out.
    expect(store.posts[0].status).toBe('publishing')
    expect(store.targets[0].status).toBe('publishing')
  })

  test('retrying an unconfirmed publish returns the same post and posts nothing again', async () => {
    createTimesOut = true
    const first = await createPost('ws_1', 'Acme', {
      content: 'Big reel',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })
    expect(createCalls()).toHaveLength(1)

    // A retry a minute later carries a new idempotency key, which is exactly how
    // the duplicates happened; the 15-minute window has to catch it anyway.
    store.posts[0].idempotencyKey = 'the-key-a-retry-would-not-reuse'
    createTimesOut = false
    providerReply = { id: 'zernio_post_41' }

    const second = await createPost('ws_1', 'Acme', {
      content: 'Big reel',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })

    expect(second.id).toBe(first.id)
    expect(second.deduped).toBe(true)
    expect(store.posts).toHaveLength(1)
    expect(createCalls()).toHaveLength(1)
  })

  test('a deliberate repost goes through when allowDuplicate says so', async () => {
    providerReply = { id: 'zernio_post_42' }
    const first = await createPost('ws_1', 'Acme', {
      content: 'Big reel',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })
    store.posts[0].idempotencyKey = 'the-key-a-retry-would-not-reuse'

    const second = await createPost('ws_1', 'Acme', {
      content: 'Big reel',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
      allowDuplicate: true,
    })

    expect(second.id).not.toBe(first.id)
    expect(store.posts).toHaveLength(2)
    expect(createCalls()).toHaveLength(2)
  })

  test('the next read reconciles it against the provider instead of publishing again', async () => {
    createTimesOut = true
    const post = await createPost('ws_1', 'Acme', {
      content: 'Big reel',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })

    // It sat in flight long enough that the provider has an answer by now.
    store.posts[0].createdAt = new Date(Date.now() - 5 * 60_000)
    createTimesOut = false
    providerList = {
      posts: [
        {
          _id: 'zernio_post_43',
          content: 'Big reel',
          platforms: [
            {
              platform: 'instagram',
              accountId: { _id: 'zernio_ig', username: 'brand.ig' },
              status: 'published',
              platformPostUrl: 'https://instagram.com/p/ig_43',
            },
          ],
        },
      ],
    }

    const reconciled = await getPost('ws_1', post.id)

    expect(reconciled.status).toBe('published')
    expect(reconciled.zernioPostId).toBe('zernio_post_43')
    expect(reconciled.targets[0].status).toBe('published')
    expect(reconciled.targets[0].platformPostUrl).toBe('https://instagram.com/p/ig_43')
    // One publish, one read: nothing was posted a second time.
    expect(createCalls()).toHaveLength(1)
    const read = calls.find((call) => call.method === 'GET' && call.path === '/posts')
    expect(read.query).toMatchObject({ limit: 50, sortBy: 'created-desc' })
  })

  test('the list reconciles a stuck publish too', async () => {
    createTimesOut = true
    await createPost('ws_1', 'Acme', {
      content: 'Big reel',
      accountIds: ['acct_x'],
      publishNow: true,
    })
    store.posts[0].createdAt = new Date(Date.now() - 5 * 60_000)
    createTimesOut = false
    providerList = {
      posts: [
        {
          _id: 'zernio_post_44',
          content: 'Big reel',
          platforms: [{ platform: 'x', accountId: 'zernio_x', status: 'published', platformPostUrl: 'https://x.com/i/44' }],
        },
      ],
    }

    const posts = await listPosts('ws_1', {})

    expect(posts[0].status).toBe('published')
    expect(posts[0].targets[0].platformPostUrl).toBe('https://x.com/i/44')
  })

  test('a provider that cannot be reached leaves the post publishing, not published', async () => {
    createTimesOut = true
    const post = await createPost('ws_1', 'Acme', {
      content: 'Big reel',
      accountIds: ['acct_ig'],
      mediaUrls: [IMAGE],
      publishNow: true,
    })
    store.posts[0].createdAt = new Date(Date.now() - 5 * 60_000)
    setSocialClient({
      mode: 'cloud',
      async request() {
        const { SocialError } = await import('../client')
        throw new SocialError(502, 'zernio_unreachable', 'Could not reach Zernio.')
      },
    })

    const read = await getPost('ws_1', post.id)

    expect(read.status).toBe('publishing')
    expect(store.posts[0].status).toBe('publishing')
  })
})
