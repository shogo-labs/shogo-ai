// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-156 acceptance — the flow a person and an agent actually walk:
 *
 *   connect (provider hands back `authUrl`) → the browser lands on a page that
 *   exists → the account appears → an agent schedules a video post from a
 *   workspace file → it is on the calendar → and on desktop without Shogo Cloud
 *   the refusal is a sentence, not a code.
 *
 * Zernio is faked at the service seam, so no real account, password or post is
 * touched. Everything below goes through the real Hono routers, the real
 * services and a real SQLite database.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { socialRoutes, agentSocialRoutes } = await import('../../../routes/social')
const { SocialError, setSocialClient } = await import('../client')

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

const suffix = crypto.randomUUID().slice(0, 8)
let owner = ''
let workspaceId = ''

const calls: any[] = []
let providerAccounts: any[] = []
const AUTH_URL = 'https://provider.test/connect/instagram?token=abc'
const PUBLIC_MEDIA_URL = 'https://cdn.provider.test/media/launch.mp4'

/** A provider that answers the way Zernio's docs describe it. */
function fakeProvider(): void {
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.path === '/profiles') {
        return { id: 'provider_profile_1', externalId: req.body?.externalId ?? workspaceId }
      }
      // Zernio answers the connect call with `authUrl` — the field the old code
      // never read, which is why every real connect used to end in a 502.
      if (req.path.startsWith('/connect/')) return { authUrl: AUTH_URL }
      if (req.path === '/accounts' && req.method === 'GET') return { accounts: providerAccounts }
      if (req.path === '/media/presign') {
        return {
          uploadUrl: 'https://upload.provider.test/slot/1',
          publicUrl: PUBLIC_MEDIA_URL,
          key: 'media/launch.mp4',
          expiresIn: 3600,
        }
      }
      if (req.path === '/posts') {
        return {
          id: 'provider_post_1',
          status: 'scheduled',
          targets: [
            { accountId: 'provider_ig_1', status: 'scheduled', postId: 'ig_post_1' },
            { accountId: 'provider_tt_1', status: 'scheduled', postId: 'tt_post_1' },
          ],
        }
      }
      throw new Error(`unexpected ${req.method} ${req.path}`)
    },
  })
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { name: 'owner', email: `sho156-owner-${suffix}@example.com` },
  })
  owner = user.id

  const workspace = await db.workspace.create({
    data: { name: 'SHO-156', slug: `sho156-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { workspaceId, userId: owner, role: 'owner', projectId: null } })

  providerAccounts = [
    { id: 'provider_ig_1', platform: 'instagram', username: 'acme.ig', displayName: 'Acme IG' },
    { id: 'provider_tt_1', platform: 'tiktok', username: 'acme.tt' },
  ]
  fakeProvider()
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
})

describe('acceptance 1 — connect opens the sign-in and lands on a page that exists', () => {
  test('the connect call returns the provider’s authUrl, not a 502', async () => {
    calls.length = 0
    const res = await request(`/api/workspaces/${workspaceId}/social/connect`, owner, {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe(AUTH_URL)

    const call = calls.find((entry) => entry.path === '/connect/instagram')
    expect(call).toBeTruthy()
    expect(call.query.profileId).toBe('provider_profile_1')
  })

  test('the redirect Zernio is given is a page this app actually serves, with no session', async () => {
    calls.length = 0
    await request(`/api/workspaces/${workspaceId}/social/connect`, owner, {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram' }),
    })
    const redirect = calls.find((entry) => entry.path === '/connect/instagram')!.query.redirect_url as string
    expect(redirect).toBe('http://localhost/api/social/connect/return')

    const before = await db.socialAccount.count({ where: { workspaceId } })

    // Exactly what the browser arrives with: Zernio's own query, no cookie, no
    // `x-user`. A 404 here is the bug the card describes.
    const landing = await app.request(
      `${new URL(redirect).pathname}?connected=instagram&accountId=provider_ig_1&username=acme.ig`,
    )
    expect(landing.status).toBe(200)
    const html = await landing.text()
    expect(html).toContain('acme.ig')
    expect(html).toContain('Instagram')
    expect(html.toLowerCase()).toContain('connected')

    // Display-only: the landing page never writes the account itself.
    expect(await db.socialAccount.count({ where: { workspaceId } })).toBe(before)
  })

  test('a failed sign-in lands on the same page and says what went wrong in plain words', async () => {
    const landing = await app.request(
      '/api/social/connect/return?error=oauth_denied&error_message=Access%20denied&platform=instagram',
    )
    expect(landing.status).toBe(400)
    const html = await landing.text()
    expect(html).toContain('Access denied')
    expect(html).toContain('did not connect')
    expect(html).not.toContain('<script')
  })

  test('the account appears in the list once the app syncs after the sign-in', async () => {
    const res = await request(`/api/internal/workspaces/${workspaceId}/social/accounts/sync`, null, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    const handles = body.accounts.map((account: any) => `${account.platform}:${account.username}`)
    expect(handles).toEqual(['instagram:acme.ig', 'tiktok:acme.tt'])

    // The person's own screen reads the same rows.
    const mine = await request(`/api/workspaces/${workspaceId}/social/accounts`, owner)
    expect(mine.status).toBe(200)
    expect((await mine.json()).accounts).toHaveLength(2)
  })
})

describe('acceptance 3 — a workspace video becomes a scheduled post in one pass', () => {
  test('presign gives an upload slot and a public URL a post can name', async () => {
    calls.length = 0
    const res = await request(`/api/internal/workspaces/${workspaceId}/social/media/presign`, null, {
      method: 'POST',
      body: JSON.stringify({
        filename: 'renders/launch.mp4',
        contentType: 'video/mp4',
        size: 4 * 1024 * 1024,
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.uploadUrl).toBe('https://upload.provider.test/slot/1')
    expect(body.publicUrl).toBe(PUBLIC_MEDIA_URL)

    const call = calls.find((entry) => entry.path === '/media/presign')
    // The provider is told the name, not a path: a caller cannot steer storage.
    expect(call.body.filename).toBe('launch.mp4')
    expect(call.body.contentType).toBe('video/mp4')
  })

  test('the scheduled post carries mediaItems/customMedia and reaches the calendar', async () => {
    const accountsRes = await request(`/api/workspaces/${workspaceId}/social/accounts`, owner)
    const accounts = (await accountsRes.json()).accounts as any[]
    const ig = accounts.find((account) => account.platform === 'instagram')
    const tt = accounts.find((account) => account.platform === 'tiktok')
    expect(ig?.id && tt?.id).toBeTruthy()

    const scheduledFor = new Date(Date.now() + 2 * 86_400_000).toISOString()
    calls.length = 0
    const created = await request(`/api/internal/workspaces/${workspaceId}/social/posts`, null, {
      method: 'POST',
      body: JSON.stringify({
        content: 'Launch day',
        accountIds: [ig.id, tt.id],
        mediaUrls: [PUBLIC_MEDIA_URL],
        scheduledFor,
      }),
    })
    expect(created.status).toBe(201)
    const post = (await created.json()).post
    expect(post.status).toBe('scheduled')

    const dispatch = calls.find((entry) => entry.path === '/posts')!
    // Zernio reads `mediaItems` at the root and `customMedia` per target; the
    // old `mediaUrls` field was dropped silently and Instagram then refused.
    expect(dispatch.body.mediaItems).toEqual([{ url: PUBLIC_MEDIA_URL, type: 'video' }])
    expect(dispatch.body.mediaUrls).toBeUndefined()
    expect(dispatch.body.scheduledFor).toBe(scheduledFor)

    const tiktokTarget = dispatch.body.platforms.find((target: any) => target.platform === 'tiktok')
    // TikTok defaults to the creator's inbox, never a straight publish.
    expect(tiktokTarget.platformSpecificData.tiktokSettings.draft).toBe(true)

    const calendarRes = await request(
      `/api/workspaces/${workspaceId}/social/calendar?from=${encodeURIComponent(
        new Date(Date.now() - 86_400_000).toISOString(),
      )}&to=${encodeURIComponent(new Date(Date.now() + 7 * 86_400_000).toISOString())}`,
      owner,
    )
    expect(calendarRes.status).toBe(200)
    const calendar = await calendarRes.json()
    expect(calendar.posts.map((entry: any) => entry.id)).toContain(post.id)
  })

  test('a text-only Instagram post is refused before anything is sent', async () => {
    const accounts = (await (await request(`/api/workspaces/${workspaceId}/social/accounts`, owner)).json())
      .accounts as any[]
    const ig = accounts.find((account) => account.platform === 'instagram')

    calls.length = 0
    const res = await request(`/api/internal/workspaces/${workspaceId}/social/posts`, null, {
      method: 'POST',
      body: JSON.stringify({ content: 'no picture', accountIds: [ig.id], publishNow: true }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('media_required')
    expect(calls.some((entry) => entry.path === '/posts')).toBe(false)
  })
})

describe('acceptance 4 — desktop without Shogo Cloud says so in plain words', () => {
  test('the connect route and the agent mirror both answer with the sentence, not a code', async () => {
    setSocialClient({
      mode: 'relay',
      async request() {
        throw new SocialError(
          412,
          'social_relay_unavailable',
          'Social accounts on desktop go through Shogo Cloud. Connect Shogo Cloud in Settings first.',
        )
      },
    })

    const mine = await request(`/api/workspaces/${workspaceId}/social/connect`, owner, {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram' }),
    })
    expect(mine.status).toBe(412)
    const mineBody = await mine.json()
    expect(mineBody.error.message).toContain('Connect Shogo Cloud in Settings first')

    const agent = await request(`/api/internal/workspaces/${workspaceId}/social/connect`, null, {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram' }),
    })
    expect(agent.status).toBe(412)
    expect((await agent.json()).error.message).toContain('Connect Shogo Cloud in Settings first')

    fakeProvider()
  })
})
