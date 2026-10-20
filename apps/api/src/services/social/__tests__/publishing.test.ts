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

function hydratePost(post: Row): Row {
  return {
    ...post,
    targets: store.targets
      .filter((target) => target.postId === post.id)
      .map((target) => ({
        ...target,
        account: store.accounts.find((account) => account.id === target.accountId) ?? null,
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
    if (value && typeof value === 'object' && 'in' in (value as any)) {
      return ((value as any).in as unknown[]).includes(row[key])
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
    findFirst: async ({ where }: any) => {
      const post = store.posts.find((row) => matches(row, where))
      return post ? hydratePost(post) : null
    },
    findMany: async ({ where }: any) =>
      store.posts.filter((post) => matchesCalendar(post, where)).map(hydratePost),
    create: async ({ data }: any) => {
      const { targets, ...rest } = data
      const post = { id: nextId('post'), publishedAt: null, scheduledFor: null, zernioPostId: null, ...rest }
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

const { createPost, updatePost, deletePost, calendar, postIdempotencyKey } = await import('../publishing.service')
const { setSocialClient } = await import('../client')

const calls: any[] = []
let providerReply: any = {}

function useFakeClient() {
  calls.length = 0
  providerReply = {}
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.path === '/profiles') return { id: 'zernio_profile_1' }
      if (req.path === '/posts') return providerReply
      if (req.path.startsWith('/posts/')) return {}
      throw new Error(`unexpected ${req.path}`)
    },
  })
}

function seedAccounts() {
  store.posts.length = 0
  store.targets.length = 0
  store.accounts.length = 0
  store.profiles.length = 0
  store.accounts.push(
    { id: 'acct_ig', workspaceId: 'ws_1', zernioAccountId: 'zernio_ig', platform: 'instagram', username: 'brand.ig', isActive: true },
    { id: 'acct_tt', workspaceId: 'ws_1', zernioAccountId: 'zernio_tt', platform: 'tiktok', username: 'brand.tt', isActive: true },
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
    const input = { content: 'Same text', accountIds: ['acct_ig'], scheduledFor: when }

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
    await createPost('ws_1', 'Acme', { content: 'Later', accountIds: ['acct_ig'], scheduledFor: when.toISOString() })
    store.posts.push({ id: 'post_draft', workspaceId: 'ws_1', status: 'draft', content: 'Draft', createdAt: new Date() })

    const rows = await calendar('ws_1', new Date(Date.now() - 86_400_000), new Date(Date.now() + 7 * 86_400_000))
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('Later')
  })
})
