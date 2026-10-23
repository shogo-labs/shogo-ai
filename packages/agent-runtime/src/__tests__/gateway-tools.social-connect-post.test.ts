// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `social_media` tool's management actions, against a stubbed API.
 *
 * These cover the two things a tool action can get wrong on its own: calling a
 * route that does not exist, and passing a person's credentials somewhere they
 * must never go. A workspace file that becomes post media is covered too — it
 * has to be minted an upload slot and PUT from here, because the MP4 itself must
 * not travel through the API.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.SHOGO_API_URL = 'http://api.test'

const { createTools } = await import('../gateway-tools')

interface Call {
  method: string
  url: string
  body: any
}

let calls: Call[] = []
let replies: Array<{ match: RegExp; status?: number; body: any }> = []
const realFetch = globalThis.fetch

const workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-social-tool-'))

function route(match: RegExp, body: any, status = 200) {
  replies.push({ match, body, status })
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const method = (init.method ?? 'GET').toUpperCase()
  // A media upload PUTs raw bytes, so only a JSON string body is parsed.
  const raw = init.body
  const body = typeof raw === 'string' ? JSON.parse(raw) : raw
  calls.push({ method, url, body })
  const reply = replies.find((entry) => entry.match.test(`${method} ${url}`))
  const status = reply?.status ?? 200
  const payload = reply?.body ?? {}
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}) as unknown as typeof fetch

afterAll(() => {
  globalThis.fetch = realFetch
  rmSync(workspaceDir, { recursive: true, force: true })
})

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    workspaceDir,
    workspaceId: 'ws_1',
    channels: new Map(),
    config: {
      // Management on, lookups off: the shape a workspace that only wanted to
      // connect and post has.
      socialManagementEnabled: true,
      socialMediaEnabled: false,
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'proj-social',
    ...overrides,
  }
}

async function run(params: Record<string, any>, ctx = makeCtx()) {
  const tool = createTools(ctx).find((entry: any) => entry.name === 'social_media')
  if (!tool) throw new Error('social_media tool is not registered')
  const result = await (tool as any).execute('call-1', params)
  return (result as any).details ?? result
}

beforeEach(() => {
  calls = []
  replies = []
})

describe('connect', () => {
  test('hands back the sign-in link and how to use it', async () => {
    route(/POST .*\/social\/connect$/, { url: 'https://zernio.com/oauth/instagram?state=1', platform: 'instagram' })

    const result = await run({ action: 'connect', platform: 'instagram' })

    expect(result.url).toBe('https://zernio.com/oauth/instagram?state=1')
    expect(result.instructions).toContain('sign in on Instagram')
    expect(result.instructions).toContain('professional (Business or Creator) account')
    expect(result.never).toContain('Never ask for, accept or store a username, password')
    const call = calls.find((entry) => entry.url.endsWith('/social/connect'))!
    expect(call.body).toEqual({ platform: 'instagram' })
  })

  test('a password in the arguments is refused, and nothing is called', async () => {
    const result = await run({ action: 'connect', platform: 'instagram', password: 'hunter2' })

    expect(result.refused).toBe(true)
    expect(result.error).toContain('password')
    expect(calls).toHaveLength(0)
  })

  test('an unknown platform is refused before the route is called', async () => {
    const result = await run({ action: 'connect', platform: 'myspace' })
    expect(result.error).toContain('instagram')
    expect(calls).toHaveLength(0)
  })

  test('reauth and an expected handle ride through to the route', async () => {
    route(/POST .*\/social\/connect$/, { url: 'https://zernio.com/oauth/instagram' })

    await run({
      action: 'connect',
      platform: 'instagram',
      expected_username: '@russell.shogo',
      force_reauth: true,
    })

    expect(calls.find((entry) => entry.url.endsWith('/social/connect'))!.body).toEqual({
      platform: 'instagram',
      expectedUsername: 'russell.shogo',
      forceReauth: true,
    })
  })
})

describe('accounts', () => {
  test('syncs first, so a connect that just finished shows up', async () => {
    route(/POST .*\/social\/accounts\/sync$/, {
      accounts: [
        { id: 'acct_1', platform: 'instagram', username: 'russell.shogo', isActive: true },
        { id: 'acct_2', platform: 'tiktok', username: 'russell', isActive: false, needsReconnect: true },
      ],
    })

    const result = await run({ action: 'accounts' })

    expect(calls.map((entry) => `${entry.method} ${entry.url.split('/api/internal')[1]}`)).toEqual([
      'POST /workspaces/ws_1/social/accounts/sync',
    ])
    expect(result.count).toBe(2)
    expect(result.accounts[0]).toEqual({
      account_id: 'acct_1',
      platform: 'instagram',
      username: 'russell.shogo',
      active: true,
      needs_reconnect: false,
    })
    expect(result.accounts[1].needs_reconnect).toBe(true)
  })
})

describe('reading posts, the calendar and analytics', () => {
  test('posts passes the status filter and the limit', async () => {
    route(/GET .*\/social\/posts/, { posts: [{ id: 'post_1', status: 'scheduled', content: 'Hi' }] })

    const result = await run({ action: 'posts', status: 'scheduled', limit: 5 })

    expect(calls[0].url).toContain('/social/posts?limit=5&status=scheduled')
    expect(result.count).toBe(1)
    expect(result.posts[0].post_id).toBe('post_1')
  })

  test('calendar passes a date window through', async () => {
    route(/GET .*\/social\/calendar/, { from: '2026-10-01', to: '2026-10-31', posts: [] })

    const result = await run({ action: 'calendar', from: '2026-10-01', to: '2026-10-31' })

    expect(calls[0].url).toContain('from=2026-10-01')
    expect(calls[0].url).toContain('to=2026-10-31')
    expect(result.count).toBe(0)
  })

  test('analytics asks for its own route', async () => {
    route(/GET .*\/social\/analytics/, { publishing: { published: 3 }, engagement: { comments: 9 } })

    const result = await run({ action: 'analytics' })

    expect(calls[0].url).toContain('/social/analytics')
    // The route's own payload is handed back as the tool result.
    expect(result.engagement?.comments).toBe(9)
  })
})

describe('posting', () => {
  const accountList = {
    accounts: [
      { id: 'acct_ig', platform: 'instagram', username: 'russell.shogo', isActive: true },
    ],
  }

  test('a workspace file becomes an uploaded URL, never bytes through the API', async () => {
    writeFileSync(join(workspaceDir, 'reel.mp4'), Buffer.from('not really a video'))
    route(/GET .*\/social\/accounts$/, accountList)
    route(/POST .*\/social\/media\/presign$/, {
      uploadUrl: 'https://storage.example.com/put/abc',
      publicUrl: 'https://cdn.example.com/abc.mp4',
    })
    route(/PUT https:\/\/storage\.example\.com\/put\/abc/, {})
    route(/POST .*\/social\/posts$/, {
      post: { id: 'post_1', status: 'published', targets: [] },
    })

    const result = await run({
      action: 'post',
      content: 'Launch day',
      account_ids: ['acct_ig'],
      media: ['reel.mp4'],
      publish_now: true,
    })

    const presign = calls.find((entry) => entry.url.endsWith('/social/media/presign'))!
    expect(presign.body).toEqual({ filename: 'reel.mp4', contentType: 'video/mp4', size: 18 })

    const upload = calls.find((entry) => entry.method === 'PUT')!
    expect(upload.url).toBe('https://storage.example.com/put/abc')

    const created = calls.find((entry) => entry.url.endsWith('/social/posts'))!
    expect(created.body.mediaUrls).toEqual(['https://cdn.example.com/abc.mp4'])
    expect(created.body.publishNow).toBe(true)
    expect(result.media_uploaded).toBe(1)
  })

  test('a path outside the workspace is refused before anything is uploaded', async () => {
    route(/GET .*\/social\/accounts$/, accountList)

    const result = await run({
      action: 'post',
      content: 'Nope',
      account_ids: ['acct_ig'],
      media: ['../../etc/passwd.mp4'],
    })

    expect(result.error).toContain('outside the workspace')
    expect(calls.filter((entry) => entry.method === 'PUT')).toHaveLength(0)
    expect(calls.filter((entry) => entry.url.endsWith('/social/posts'))).toHaveLength(0)
  })

  test('a text-only post to Instagram is refused before an upload slot is minted', async () => {
    route(/GET .*\/social\/accounts$/, accountList)

    const result = await run({
      action: 'post',
      content: 'Just words',
      account_ids: ['acct_ig'],
      publish_now: true,
    })

    expect(result.error).toContain('@russell.shogo (instagram)')
    expect(calls.filter((entry) => entry.url.includes('/social/media/presign'))).toHaveLength(0)
    expect(calls.filter((entry) => entry.url.endsWith('/social/posts'))).toHaveLength(0)
  })

  test('an https URL is used as it stands', async () => {
    route(/GET .*\/social\/accounts$/, accountList)
    route(/POST .*\/social\/posts$/, { post: { id: 'post_2', status: 'published', targets: [] } })

    await run({
      action: 'post',
      content: 'Shared picture',
      account_ids: ['acct_ig'],
      media: ['https://cdn.example.com/pic.jpg'],
      publish_now: true,
    })

    expect(calls.filter((entry) => entry.url.includes('/social/media/presign'))).toHaveLength(0)
    expect(calls.find((entry) => entry.url.endsWith('/social/posts'))!.body.mediaUrls).toEqual([
      'https://cdn.example.com/pic.jpg',
    ])
  })

  test('a variant carries its own content, media and TikTok settings', async () => {
    route(/GET .*\/social\/accounts$/, accountList)
    route(/POST .*\/social\/posts$/, { post: { id: 'post_3', status: 'scheduled', targets: [] } })

    await run({
      action: 'post',
      content: 'Same post',
      account_ids: ['acct_ig'],
      scheduled_for: '2026-11-01T09:00:00Z',
      media: ['https://cdn.example.com/pic.jpg'],
      variants: {
        acct_ig: {
          content: 'Instagram caption',
          platform_specific_data: { tiktokSettings: { privacyLevel: 'PUBLIC_TO_EVERYONE' } },
        },
      },
      tiktok: { draft: true },
    })

    const created = calls.find((entry) => entry.url.endsWith('/social/posts'))!
    expect(created.body.scheduledFor).toBe('2026-11-01T09:00:00Z')
    expect(created.body.variants.acct_ig).toEqual({
      content: 'Instagram caption',
      platformSpecificData: { tiktokSettings: { privacyLevel: 'PUBLIC_TO_EVERYONE' } },
    })
    expect(created.body.tiktok).toEqual({ draft: true })
  })

  test('an account id this workspace does not own is refused', async () => {
    route(/GET .*\/social\/accounts$/, accountList)

    const result = await run({
      action: 'post',
      content: 'Hi',
      account_ids: ['acct_someone_else'],
      media: ['https://cdn.example.com/pic.jpg'],
    })

    expect(result.error).toContain('Unknown account id')
    expect(calls.filter((entry) => entry.url.endsWith('/social/posts'))).toHaveLength(0)
  })
})

describe('the capability gate', () => {
  test('management actions are refused when social management is off', async () => {
    const ctx = makeCtx({
      config: { socialMediaEnabled: true, socialManagementEnabled: false, channels: [], model: {} },
    })

    for (const action of ['connect', 'accounts', 'post', 'posts', 'calendar', 'analytics']) {
      const result = await run({ action, platform: 'instagram', account_ids: [] }, ctx)
      expect(result.error).toContain('Social management is off')
    }
    expect(calls).toHaveLength(0)
  })
})
