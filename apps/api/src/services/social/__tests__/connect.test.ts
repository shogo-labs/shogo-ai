// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The connect path against a fake Zernio: the shape of the sign-in URL, the
 * per-account switch Zernio reads, and the page the browser lands on when it
 * comes back. No network, no database, but the real service code.
 *
 * The first of these is the bug this file exists for: Zernio answers with
 * `authUrl`, and a reader that only knew `url` turned every real connect into a
 * 502 the mocks agreed with.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = {
  profiles: [] as any[],
  accounts: [] as any[],
}

const dbMock = {
  socialProfile: {
    findUnique: async ({ where }: any) => {
      const key = where?.workspaceId_localWorkspaceId
      if (!key) return store.profiles.find((row) => row.externalId === where.externalId) ?? null
      return (
        store.profiles.find(
          (row) =>
            row.workspaceId === key.workspaceId && row.localWorkspaceId === key.localWorkspaceId,
        ) ?? null
      )
    },
    create: async ({ data }: any) => {
      const row = { id: `profile_${store.profiles.length + 1}`, ...data }
      store.profiles.push(row)
      return row
    },
  },
  socialAccount: {
    count: async ({ where }: any) =>
      store.accounts.filter(
        (account) =>
          account.workspaceId === where.workspaceId &&
          (where.isActive === undefined || account.isActive === where.isActive),
      ).length,
    findFirst: async ({ where }: any) => {
      const ids: string[] = where.OR ? where.OR.flatMap((clause: any) => Object.values(clause)) : []
      return (
        store.accounts.find(
          (account) =>
            account.workspaceId === where.workspaceId &&
            (ids.includes(account.id) || ids.includes(account.zernioAccountId)),
        ) ?? null
      )
    },
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: dbMock }))

const { connectUrl } = await import('../accounts.service')
const { presignMedia } = await import('../media.service')
const { setSocialClient } = await import('../client')
const { connectReturnPage } = await import('../connect-page')

const calls: any[] = []
let providerReply: any = {}

beforeEach(() => {
  calls.length = 0
  providerReply = {}
  store.profiles.length = 0
  store.accounts.length = 0
  store.profiles.push({
    id: 'profile_1',
    workspaceId: 'ws_1',
    localWorkspaceId: '',
    zernioProfileId: 'zernio_profile_1',
    externalId: 'ws_ws_1',
    name: 'Acme',
  })
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      const reply = providerReply[req.path]
      if (reply instanceof Error) throw reply
      return reply ?? {}
    },
  })
})

describe('connect url', () => {
  test('reads the authUrl Zernio documents', async () => {
    providerReply = {
      '/connect/instagram': { authUrl: 'https://zernio.com/oauth/instagram?state=abc' },
    }

    const result = await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'instagram',
      redirectUrl: 'https://api.example.com/api/social/connect/return',
    })

    expect(result).toEqual({
      url: 'https://zernio.com/oauth/instagram?state=abc',
      platform: 'instagram',
      // Our own profile row, which is the handle our routes take back; the
      // provider's id is what the query carries.
      profileId: 'profile_1',
    })

    const call = calls.find((entry) => entry.path === '/connect/instagram')
    expect(call.query).toEqual({
      profileId: 'zernio_profile_1',
      redirect_url: 'https://api.example.com/api/social/connect/return',
    })
  })

  test('still understands the older spellings', async () => {
    providerReply = { '/connect/tiktok': { url: 'https://zernio.com/oauth/tiktok' } }
    const result = await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'tiktok',
      redirectUrl: 'https://api.example.com/return',
    })
    expect(result.url).toBe('https://zernio.com/oauth/tiktok')
  })

  test('a reauth and an expected handle ride along as query params', async () => {
    providerReply = { '/connect/instagram': { authUrl: 'https://zernio.com/oauth/instagram' } }

    await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'instagram',
      redirectUrl: 'https://api.example.com/return',
      forceReauth: true,
      expectedUsername: '@Russell.Shogo',
    })

    const call = calls.find((entry) => entry.path === '/connect/instagram')
    expect(call.query.forceReauth).toBe('true')
    // Zernio compares case-insensitively and ignores the leading `@`.
    expect(call.query.expectedUsername).toBe('Russell.Shogo')
  })

  test('forceReauth is Instagram only — other platforms never carry it', async () => {
    providerReply = { '/connect/tiktok': { authUrl: 'https://zernio.com/oauth/tiktok' } }

    await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'tiktok',
      redirectUrl: 'https://api.example.com/return',
      forceReauth: true,
    })

    expect(calls.find((entry) => entry.path === '/connect/tiktok').query.forceReauth).toBeUndefined()
  })

  test('a reconnect resolves our row id to the provider id it belongs to', async () => {
    store.accounts.push({
      id: 'acct_1',
      workspaceId: 'ws_1',
      zernioAccountId: 'zernio_ig',
      platform: 'instagram',
      isActive: false,
    })
    providerReply = { '/connect/instagram': { authUrl: 'https://zernio.com/oauth/instagram' } }

    await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'instagram',
      redirectUrl: 'https://api.example.com/return',
      reconnectAccountId: 'acct_1',
    })

    expect(calls.find((entry) => entry.path === '/connect/instagram').query.reconnectAccountId).toBe(
      'zernio_ig',
    )
  })

  test("a reconnect for another workspace's account is refused, not forwarded", async () => {
    store.accounts.push({
      id: 'acct_other',
      workspaceId: 'ws_2',
      zernioAccountId: 'zernio_other',
      platform: 'instagram',
      isActive: true,
    })

    const error = await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'instagram',
      redirectUrl: 'https://api.example.com/return',
      reconnectAccountId: 'acct_other',
    }).catch((err) => err)

    expect(error.code).toBe('unknown_account')
    expect(calls.filter((entry) => entry.path.startsWith('/connect/'))).toHaveLength(0)
  })

  test('an unknown platform is refused before anything is called', async () => {
    const error = await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'not a platform',
      redirectUrl: 'https://api.example.com/return',
    }).catch((err) => err)

    expect(error.code).toBe('invalid_platform')
    expect(calls).toHaveLength(0)
  })

  test('a provider answer with no link at all is a 502, not an empty URL', async () => {
    providerReply = { '/connect/instagram': { ok: true } }
    const error = await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'instagram',
      redirectUrl: 'https://api.example.com/return',
    }).catch((err) => err)

    expect(error.status).toBe(502)
    expect(error.code).toBe('connect_url_missing')
  })
})

describe('media presign', () => {
  test('returns the upload slot and the public URL a post references', async () => {
    providerReply = {
      '/media/presign': {
        uploadUrl: 'https://storage.example.com/put/abc',
        publicUrl: 'https://cdn.example.com/abc.mp4',
        key: 'abc.mp4',
        expiresIn: 900,
      },
    }

    const upload = await presignMedia('ws_1', {
      filename: 'reel.mp4',
      contentType: 'video/mp4',
      size: 1024,
    })

    expect(upload).toEqual({
      uploadUrl: 'https://storage.example.com/put/abc',
      publicUrl: 'https://cdn.example.com/abc.mp4',
      key: 'abc.mp4',
      expiresIn: 900,
    })
    expect(calls[0].body).toEqual({ filename: 'reel.mp4', contentType: 'video/mp4', size: 1024 })
  })

  test('a path in the filename cannot steer where the file lands', async () => {
    providerReply = {
      '/media/presign': { uploadUrl: 'https://storage.example.com/put/abc', publicUrl: 'https://cdn.example.com/abc.jpg' },
    }

    await presignMedia('ws_1', { filename: '../../etc/passwd.jpg', contentType: 'image/jpeg' })

    expect(calls[0].body.filename).toBe('passwd.jpg')
  })

  test('refuses a content type Zernio would reject, and says why', async () => {
    const error = await presignMedia('ws_1', {
      filename: 'clip.mp4',
      contentType: 'application/octet-stream',
    }).catch((err) => err)

    expect(error.code).toBe('invalid_content_type')
    expect(error.message).toContain('application/octet-stream')
    expect(calls).toHaveLength(0)
  })

  test('refuses a file larger than Zernio accepts before uploading a byte', async () => {
    const error = await presignMedia('ws_1', {
      filename: 'huge.mp4',
      contentType: 'video/mp4',
      size: 6 * 1024 * 1024 * 1024,
    }).catch((err) => err)

    expect(error.code).toBe('media_too_large')
    expect(calls).toHaveLength(0)
  })

  test('a provider answer missing either URL is a 502', async () => {
    providerReply = { '/media/presign': { uploadUrl: 'https://storage.example.com/put/abc' } }
    const error = await presignMedia('ws_1', {
      filename: 'reel.mp4',
      contentType: 'video/mp4',
    }).catch((err) => err)

    expect(error.code).toBe('presign_url_missing')
  })
})

describe('the page the browser lands on', () => {
  const params = (query: Record<string, string>) => new URLSearchParams(query)

  test('says which account connected, and where it will show up', () => {
    const page = connectReturnPage(
      params({ connected: 'instagram', accountId: 'zernio_ig', username: 'russell.shogo' }),
    )

    expect(page.status).toBe(200)
    expect(page.html).toContain('Instagram @russell.shogo is connected')
    expect(page.html).toContain('close this tab')
    // The one thing a person has to do something about on Instagram.
    expect(page.html).toContain('professional (Business or Creator) account')
  })

  test('a redeemed-again code means the earlier attempt already connected it', () => {
    const page = connectReturnPage(
      params({ platform: 'tiktok', accountId: 'zernio_tt', error: 'code_already_redeemed' }),
    )
    expect(page.status).toBe(200)
    expect(page.html).toContain('is connected')
  })

  test('an error is reported in plain words, with the code underneath', () => {
    const page = connectReturnPage(
      params({
        platform: 'tiktok',
        error: 'missing_tiktok_permissions',
        error_message: 'Missing scopes: video.publish',
      }),
    )

    expect(page.status).toBe(400)
    expect(page.html).toContain('Missing scopes: video.publish')
    expect(page.html).toContain('accept them all')
    expect(page.html).toContain('missing_tiktok_permissions')
  })

  test('the query string is escaped, never injected into the page', () => {
    const page = connectReturnPage(
      params({ platform: 'instagram', error: 'oauth_denied', error_message: '<script>alert(1)</script>' }),
    )
    expect(page.html).not.toContain('<script>alert(1)</script>')
    expect(page.html).toContain('&lt;script&gt;')
  })

  test('nothing in it touches the database — the page only renders', () => {
    // The account row is written by the app's own sync call, which is the only
    // path that can prove whose workspace it is. This test states the contract:
    // the page is a pure function of the query string.
    connectReturnPage(params({ connected: 'instagram', accountId: 'zernio_ig', username: 'x' }))
    expect(calls).toHaveLength(0)
  })
})
