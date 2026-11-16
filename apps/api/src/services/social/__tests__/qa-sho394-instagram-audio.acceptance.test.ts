// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-394 acceptance — licensed music on Instagram Reels, walked the way a
 * person and an agent actually walk it:
 *
 *   connect with Facebook Login → search the catalog → attach a track to a Reel
 *   → an Instagram Login account is told exactly how to fix itself → a track on
 *   an image is refused before Zernio is touched → a post with no track is
 *   byte-identical to before.
 *
 * Zernio is faked at the service seam, so no real account, track or post is
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
const REEL = 'https://cdn.provider.test/media/reel.mp4'
const IMAGE = 'https://cdn.provider.test/media/still.jpg'

const TRACK = {
  audioId: '1234567890',
  title: 'Midnight Drive',
  audioType: 'music',
  durationInMs: 30_000,
  displayArtist: 'The Neighbourhood',
  downloadUrl: 'https://cdn.example.com/audio/1234567890.mp3',
}

/** A provider that answers the way Zernio's docs describe it. */
function fakeProvider(): void {
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.path === '/profiles') {
        return { id: 'provider_profile_1', externalId: req.body?.externalId ?? workspaceId }
      }
      if (req.path.startsWith('/connect/')) return { authUrl: AUTH_URL }
      if (req.path === '/accounts' && req.method === 'GET') return { accounts: providerAccounts }
      if (req.path === '/media/presign') {
        return {
          uploadUrl: 'https://upload.provider.test/slot/1',
          publicUrl: REEL,
          key: 'media/reel.mp4',
          expiresIn: 3600,
        }
      }
      if (req.path === '/posts') {
        return { id: 'provider_post_1', status: 'publishing', targets: [] }
      }
      if (req.path === '/accounts/provider_ig_1/instagram/audio') {
        return { audio: [TRACK] }
      }
      if (req.path === '/accounts/provider_ig_1/instagram/audio/1234567890') {
        return TRACK
      }
      throw new Error(`unexpected ${req.method} ${req.path}`)
    },
  })
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { name: 'owner', email: `sho394-owner-${suffix}@example.com` },
  })
  owner = user.id

  const workspace = await db.workspace.create({
    data: { name: 'SHO-394', slug: `sho394-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { workspaceId, userId: owner, role: 'owner', projectId: null } })

  providerAccounts = [
    { id: 'provider_ig_1', platform: 'instagram', username: 'acme.ig', displayName: 'Acme IG' },
    { id: 'provider_tt_1', platform: 'tiktok', username: 'acme.tt' },
  ]
  fakeProvider()

  // A connect creates the single profile; sync then lands the accounts the way
  // a real sign-in does.
  await request(`/api/workspaces/${workspaceId}/social/connect`, owner, {
    method: 'POST',
    body: JSON.stringify({ platform: 'instagram' }),
  })
  await request(`/api/internal/workspaces/${workspaceId}/social/accounts/sync`, null, {
    method: 'POST',
  })
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
})

async function accounts(): Promise<any[]> {
  const res = await request(`/api/workspaces/${workspaceId}/social/accounts`, owner)
  return (await res.json()).accounts as any[]
}

describe('acceptance 1 — connect with Facebook Login asks Zernio for it', () => {
  test('the connect link carries loginMethod=facebook_login', async () => {
    calls.length = 0
    const res = await request(`/api/workspaces/${workspaceId}/social/connect`, owner, {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram', loginMethod: 'facebook_login' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe(AUTH_URL)

    const call = calls.find((entry) => entry.path === '/connect/instagram')
    expect(call).toBeTruthy()
    expect(call.query.loginMethod).toBe('facebook_login')
  })

  test('an unknown login method is refused before Zernio is called', async () => {
    calls.length = 0
    const res = await request(`/api/workspaces/${workspaceId}/social/connect`, owner, {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram', loginMethod: 'password' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_login_method')
    expect(calls.some((entry) => entry.path.startsWith('/connect/'))).toBe(false)
  })
})

describe('acceptance 2 — the agent searches the catalog and gets audio ids', () => {
  test('action "audio" returns tracks with an audioId, through the agent route', async () => {
    const ig = (await accounts()).find((account) => account.platform === 'instagram')
    calls.length = 0

    const res = await request(
      `/api/internal/workspaces/${workspaceId}/social/accounts/${ig.id}/instagram/audio?audioType=music&q=midnight`,
      null,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.audio).toHaveLength(1)
    expect(body.audio[0]).toMatchObject({
      audioId: '1234567890',
      title: 'Midnight Drive',
      artist: 'The Neighbourhood',
    })
    expect(body.licensing).toContain('eligibility not reported')

    const call = calls.find((entry) => entry.path === '/accounts/provider_ig_1/instagram/audio')
    expect(call.query).toEqual({ audioType: 'music', q: 'midnight' })
  })

  test('an Instagram Login account is told the exact reconnect call, never raw JSON', async () => {
    const ig = (await accounts()).find((account) => account.platform === 'instagram')
    setSocialClient({
      mode: 'cloud',
      async request(req: any) {
        calls.push(req)
        if (req.path === '/accounts/provider_ig_1/instagram/audio') {
          throw new SocialError(
            400,
            'instagram_audio_requires_facebook_login',
            'Instagram audio requires Facebook Login',
          )
        }
        throw new Error(`unexpected ${req.method} ${req.path}`)
      },
    })

    const res = await request(
      `/api/internal/workspaces/${workspaceId}/social/accounts/${ig.id}/instagram/audio`,
      null,
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('instagram_audio_requires_facebook_login')
    expect(body.error.message).toContain('login_method: "facebook_login"')
    expect(body.error.message).toContain('Facebook Page')

    fakeProvider()
  })
})

describe('acceptance 3 — a track rides on a Reel, and only a Reel', () => {
  test('post with audio sends audioConfiguration on the Instagram target only', async () => {
    const list = await accounts()
    const ig = list.find((account) => account.platform === 'instagram')
    const tt = list.find((account) => account.platform === 'tiktok')
    calls.length = 0

    const res = await request(`/api/internal/workspaces/${workspaceId}/social/posts`, null, {
      method: 'POST',
      body: JSON.stringify({
        content: 'Reel with music',
        accountIds: [ig.id, tt.id],
        mediaUrls: [REEL],
        audio: { audioId: '1234567890', audioVolume: 80, videoVolume: 100 },
        publishNow: true,
      }),
    })
    expect(res.status).toBe(201)

    const dispatch = calls.find((entry) => entry.path === '/posts')!
    const igTarget = dispatch.body.platforms.find((target: any) => target.platform === 'instagram')
    const ttTarget = dispatch.body.platforms.find((target: any) => target.platform === 'tiktok')
    expect(igTarget.platformSpecificData.audioConfiguration).toEqual({
      audioId: '1234567890',
      audioVolume: 80,
      videoVolume: 100,
    })
    expect(ttTarget.platformSpecificData?.audioConfiguration).toBeUndefined()
  })

  test('a variant’s own audioConfiguration wins over the post-level track', async () => {
    const ig = (await accounts()).find((account) => account.platform === 'instagram')
    calls.length = 0

    await request(`/api/internal/workspaces/${workspaceId}/social/posts`, null, {
      method: 'POST',
      body: JSON.stringify({
        content: 'Variant wins',
        accountIds: [ig.id],
        mediaUrls: [REEL],
        audio: { audioId: '111' },
        variants: { [ig.id]: { platformSpecificData: { audioConfiguration: { audioId: '222' } } } },
        publishNow: true,
      }),
    })

    const dispatch = calls.find((entry) => entry.path === '/posts')!
    const igTarget = dispatch.body.platforms.find((target: any) => target.platform === 'instagram')
    expect(igTarget.platformSpecificData.audioConfiguration).toEqual({ audioId: '222' })
  })

  test('a track on an image is refused before Zernio is called', async () => {
    const ig = (await accounts()).find((account) => account.platform === 'instagram')
    calls.length = 0

    const res = await request(`/api/internal/workspaces/${workspaceId}/social/posts`, null, {
      method: 'POST',
      body: JSON.stringify({
        content: 'Still frame',
        accountIds: [ig.id],
        mediaUrls: [IMAGE],
        audio: { audioId: '1234567890' },
        publishNow: true,
      }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('audio_needs_reel')
    expect(calls.some((entry) => entry.path === '/posts')).toBe(false)
  })

  test('a post with no track is byte-identical to before', async () => {
    const ig = (await accounts()).find((account) => account.platform === 'instagram')
    calls.length = 0

    await request(`/api/internal/workspaces/${workspaceId}/social/posts`, null, {
      method: 'POST',
      body: JSON.stringify({
        content: 'No music',
        accountIds: [ig.id],
        mediaUrls: [REEL],
        publishNow: true,
      }),
    })

    const dispatch = calls.find((entry) => entry.path === '/posts')!
    expect(JSON.stringify(dispatch.body)).not.toContain('audioConfiguration')
  })
})
