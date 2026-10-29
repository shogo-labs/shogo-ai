// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 — the social management routes through Hono against a real SQLite
 * database (desktop migrations replayed), with a fake Zernio client injected
 * at the service seam. Covers connect → sync → publish (partial) → calendar →
 * disconnect, which is the P1/P2 slice of the card.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { socialRoutes } = await import('../social')
const { setSocialClient } = await import('../../services/social/client')

const db = prisma as any

const app = new Hono()
app.use('*', async (c, next) => {
  const userId = c.req.header('x-user')
  c.set('auth', { userId, isAuthenticated: !!userId } as never)
  await next()
})
app.route('/api', socialRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }))

const request = (path: string, userId: string | null, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...(userId ? { 'x-user': userId } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

const suffix = crypto.randomUUID().slice(0, 8)
let owner = ''
let viewer = ''
let workspaceId = ''

const calls: any[] = []

beforeAll(async () => {
  const [ownerUser, viewerUser] = await Promise.all([
    db.user.create({ data: { name: 'owner', email: `social-owner-${suffix}@example.com` } }),
    db.user.create({ data: { name: 'viewer', email: `social-viewer-${suffix}@example.com` } }),
  ])
  owner = ownerUser.id
  viewer = viewerUser.id

  const workspace = await db.workspace.create({
    data: { name: 'Acme', slug: `acme-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { workspaceId, userId: owner, role: 'owner', projectId: null } })
  await db.member.create({ data: { workspaceId, userId: viewer, role: 'viewer', projectId: null } })

  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      // Zernio echoes the routing id we created the profile with.
      if (req.path === '/profiles') return { id: 'zernio_profile_1', externalId: req.body?.externalId ?? workspaceId }
      if (req.path === '/connect/instagram') return { url: 'https://zernio.com/connect/ig?state=abc' }
      if (req.path === '/accounts' && req.method === 'GET') {
        return {
          accounts: [
            { id: 'zernio_ig', platform: 'instagram', username: 'acme.ig', displayName: 'Acme IG' },
            { id: 'zernio_tt', platform: 'tiktok', username: 'acme.tt' },
          ],
        }
      }
      if (req.path === '/posts') {
        return {
          id: 'zernio_post_1',
          status: 'published',
          targets: [
            { accountId: 'zernio_ig', status: 'published', postId: 'ig_1', url: 'https://instagram.com/p/ig_1' },
            { accountId: 'zernio_tt', status: 'failed', error: 'TikTok rejected the video' },
          ],
        }
      }
      if (req.method === 'POST' && req.path.endsWith('/unpublish')) return { success: true }
      if (req.method === 'DELETE' && req.path.startsWith('/accounts/')) return {}
      throw new Error(`unexpected ${req.method} ${req.path}`)
    },
  })
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
})

describe('social routes', () => {
  test('status reports the mode before anything is connected', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/status`, owner)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('cloud')
    expect(body.connected).toBe(false)
    expect(body.accounts).toBe(0)
  })

  test('an outsider cannot read the workspace', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/status`, 'nobody')
    expect(res.status).toBe(404)
  })

  test('a viewer can read but cannot connect an account', async () => {
    const read = await request(`/api/workspaces/${workspaceId}/social/accounts`, viewer)
    expect(read.status).toBe(200)

    const connect = await request(`/api/workspaces/${workspaceId}/social/connect`, viewer, {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram' }),
    })
    expect(connect.status).toBe(403)
  })

  test('connect returns the provider URL and creates the single profile', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/connect`, owner, {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram', redirectUrl: 'https://app.shogo.ai/settings/social' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe('https://zernio.com/connect/ig?state=abc')

    const profile = await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: { workspaceId, localWorkspaceId: '' } } })
    expect(profile.externalId).toBe(`ws_${workspaceId}`)
    expect(calls.find((call) => call.path === '/profiles').body.externalId).toBe(`ws_${workspaceId}`)
  })

  test('sync stores the accounts and an unknown platform is refused', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/accounts/sync`, owner, { method: 'POST' })
    expect(res.status).toBe(200)
    const { accounts } = await res.json()
    expect(accounts.map((account: any) => account.username).sort()).toEqual(['acme.ig', 'acme.tt'])

    const bad = await request(`/api/workspaces/${workspaceId}/social/connect`, owner, {
      method: 'POST',
      body: JSON.stringify({ platform: 'Not A Platform' }),
    })
    expect(bad.status).toBe(400)
  })

  test('completing the redirect adds the account without another provider call', async () => {
    const before = calls.length
    const res = await request(`/api/workspaces/${workspaceId}/social/connect/complete`, owner, {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram', accountId: 'zernio_ig2', username: 'acme.second' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).account.username).toBe('acme.second')
    expect(calls.length).toBe(before)
  })

  test('one publish fans out to every account and records the partial failure', async () => {
    const accounts = await db.socialAccount.findMany({ where: { workspaceId, isActive: true } })
    const ig = accounts.find((account: any) => account.platform === 'instagram')
    const tt = accounts.find((account: any) => account.platform === 'tiktok')

    const res = await request(`/api/workspaces/${workspaceId}/social/posts`, owner, {
      method: 'POST',
      body: JSON.stringify({
        content: 'Launch day',
        accountIds: [ig.id, tt.id],
        // Instagram and TikTok refuse a text-only post, so the request carries
        // one picture; it goes out as `mediaItems` on the provider body.
        mediaUrls: ['https://cdn.example.com/launch.jpg'],
        publishNow: true,
        variants: { [tt.id]: { content: 'Launch day — TikTok cut' } },
      }),
    })

    expect(res.status).toBe(201)
    const { post } = await res.json()
    expect(post.status).toBe('partial')
    const byPlatform = Object.fromEntries(post.targets.map((target: any) => [target.platform, target]))
    expect(byPlatform.instagram.status).toBe('published')
    expect(byPlatform.tiktok.status).toBe('failed')
    expect(byPlatform.tiktok.error).toBe('TikTok rejected the video')

    const sent = calls.find((call) => call.path === '/posts')
    expect(sent.body.platforms.find((platform: any) => platform.platform === 'tiktok').customContent).toBe(
      'Launch day — TikTok cut',
    )
  })

  test('the calendar lists the post in its window', async () => {
    const now = Date.now()
    const res = await request(
      `/api/workspaces/${workspaceId}/social/calendar?from=${new Date(now - 86_400_000).toISOString()}&to=${new Date(now + 86_400_000).toISOString()}`,
      owner,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.posts).toHaveLength(1)
    expect(body.posts[0].content).toBe('Launch day')
  })

  test('a bad calendar date is a 400 in the API error shape', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/calendar?from=not-a-date`, owner)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_range')
    expect(typeof body.error.message).toBe('string')
  })

  test('a validation failure uses the API error shape', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/posts`, owner, {
      method: 'POST',
      body: JSON.stringify({ content: 'No targets', accountIds: [] }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toEqual({ code: 'no_targets', message: 'Pick at least one account to publish to' })
  })

  test('a published post cannot be edited, and taking it down says who must do it', async () => {
    const post = await db.socialPost.findFirst({ where: { workspaceId } })
    const patch = await request(`/api/workspaces/${workspaceId}/social/posts/${post.id}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ content: 'edited' }),
    })
    expect(patch.status).toBe(409)

    const del = await request(`/api/workspaces/${workspaceId}/social/posts/${post.id}`, owner, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const body = await del.json()
    // Instagram has no removal API, so its live leg comes back to the person; the
    // TikTok leg failed and was never live, so there is nothing to take down.
    expect(body.deleted).toBe(false)
    expect(body.kept).toBe(true)
    expect(body.removed).toEqual([])
    expect(body.manual.map((entry: any) => entry.platform)).toEqual(['instagram'])
    expect(body.manual[0].url).toBe('https://instagram.com/p/ig_1')
    expect(calls.some((call) => call.path.endsWith('/unpublish'))).toBe(false)
  })

  test('disconnecting removes the account at the provider and retires the row', async () => {
    const account = await db.socialAccount.findFirst({ where: { workspaceId, zernioAccountId: 'zernio_tt' } })
    const res = await request(`/api/workspaces/${workspaceId}/social/accounts/${account.id}`, owner, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.account.isActive).toBe(false)
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/accounts/zernio_tt')).toBe(true)
  })
})
