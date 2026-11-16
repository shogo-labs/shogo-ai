// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instagram's licensed-music catalog against a fake Zernio: the normalisation,
 * the account scoping, and the one error that matters — an Instagram Login
 * account cannot search at all, and the person has to be told how to fix it.
 *
 * The fixture is the shape docs.zernio.com documents for
 * `GET /v1/accounts/{id}/instagram/audio`.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = {
  accounts: [] as any[],
}

const dbMock = {
  socialAccount: {
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

const { searchInstagramAudio, getInstagramAudio, INSTAGRAM_AUDIO_LICENSING } = await import(
  '../audio.service'
)
const { setSocialClient, SocialError } = await import('../client')

const calls: any[] = []
let providerReply: any = {}

beforeEach(() => {
  calls.length = 0
  providerReply = {}
  store.accounts.length = 0
  store.accounts.push({
    id: 'acct_ig',
    workspaceId: 'ws_1',
    zernioAccountId: 'zernio_ig',
    platform: 'instagram',
    username: 'brand.ig',
    isActive: true,
  })
  store.accounts.push({
    id: 'acct_tt',
    workspaceId: 'ws_1',
    zernioAccountId: 'zernio_tt',
    platform: 'tiktok',
    username: 'brand.tt',
    isActive: true,
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

const TRACK = {
  audioId: '1234567890',
  title: 'Midnight Drive',
  audioType: 'music',
  durationInMs: 30_000,
  displayArtist: 'The Neighbourhood',
  downloadUrl: 'https://cdn.example.com/audio/1234567890.mp3',
}

describe('searching the catalog', () => {
  test('normalises a track and passes the search filters through', async () => {
    providerReply = { '/accounts/zernio_ig/instagram/audio': { audio: [TRACK] } }

    const result = await searchInstagramAudio({
      workspaceId: 'ws_1',
      accountId: 'acct_ig',
      audioType: 'music',
      q: 'midnight',
    })

    expect(result.audio).toEqual([
      {
        audioId: '1234567890',
        title: 'Midnight Drive',
        audioType: 'music',
        durationMs: 30_000,
        artist: 'The Neighbourhood',
        downloadUrl: 'https://cdn.example.com/audio/1234567890.mp3',
      },
    ])
    expect(result.licensing).toBe(INSTAGRAM_AUDIO_LICENSING)

    const call = calls.find((entry) => entry.path === '/accounts/zernio_ig/instagram/audio')
    expect(call.method).toBe('GET')
    expect(call.query).toEqual({ audioType: 'music', q: 'midnight' })
  })

  test('no query means trending, and music is the default type', async () => {
    providerReply = { '/accounts/zernio_ig/instagram/audio': { audio: [] } }
    await searchInstagramAudio({ workspaceId: 'ws_1', accountId: 'acct_ig' })
    expect(calls[0].query).toEqual({ audioType: 'music' })
  })

  test('an original sound reports its owner as the artist', async () => {
    providerReply = {
      '/accounts/zernio_ig/instagram/audio': {
        audio: [{ audioId: '42', title: 'original audio', audioType: 'original_sound', igUsername: 'brand.ig' }],
      },
    }
    const result = await searchInstagramAudio({
      workspaceId: 'ws_1',
      accountId: 'acct_ig',
      audioType: 'original_sound',
    })
    expect(result.audio[0]).toMatchObject({ audioId: '42', artist: 'brand.ig', durationMs: null })
  })

  test('an eligibility flag Zernio sends is passed through, not invented', async () => {
    providerReply = {
      '/accounts/zernio_ig/instagram/audio': { audio: [{ ...TRACK, isAdsEligible: true }] },
    }
    const result = await searchInstagramAudio({ workspaceId: 'ws_1', accountId: 'acct_ig' })
    expect((result.audio[0] as any).isAdsEligible).toBe(true)
  })

  test('a track with no audioId is dropped rather than returned unusable', async () => {
    providerReply = { '/accounts/zernio_ig/instagram/audio': { audio: [{ title: 'nameless' }, TRACK] } }
    const result = await searchInstagramAudio({ workspaceId: 'ws_1', accountId: 'acct_ig' })
    expect(result.audio).toHaveLength(1)
  })
})

describe('the account has to be ours, and Instagram', () => {
  test('another workspace’s account is refused before the provider is called', async () => {
    const error = await searchInstagramAudio({ workspaceId: 'ws_2', accountId: 'acct_ig' }).catch(
      (err) => err,
    )
    expect(error).toBeInstanceOf(SocialError)
    expect(error.code).toBe('unknown_account')
    expect(calls).toHaveLength(0)
  })

  test('a TikTok account is refused with not_instagram', async () => {
    const error = await searchInstagramAudio({ workspaceId: 'ws_1', accountId: 'acct_tt' }).catch(
      (err) => err,
    )
    expect(error.code).toBe('not_instagram')
    expect(calls).toHaveLength(0)
  })

  test('an unknown audioType is refused', async () => {
    const error = await searchInstagramAudio({
      workspaceId: 'ws_1',
      accountId: 'acct_ig',
      audioType: 'podcast',
    }).catch((err) => err)
    expect(error.code).toBe('invalid_audio_type')
  })
})

describe('an Instagram Login account', () => {
  test('keeps Zernio’s code and gets the exact reconnect call', async () => {
    providerReply = {
      '/accounts/zernio_ig/instagram/audio': new SocialError(
        400,
        'instagram_audio_requires_facebook_login',
        'Instagram audio requires Facebook Login',
      ),
    }

    const error = await searchInstagramAudio({ workspaceId: 'ws_1', accountId: 'acct_ig' }).catch(
      (err) => err,
    )

    expect(error).toBeInstanceOf(SocialError)
    expect(error.code).toBe('instagram_audio_requires_facebook_login')
    expect(error.message).toContain('login_method: "facebook_login"')
    expect(error.message).toContain('Facebook Page')
  })
})

describe('re-checking one track', () => {
  test('a single-track answer is normalised, not treated as a list', async () => {
    providerReply = { '/accounts/zernio_ig/instagram/audio/1234567890': TRACK }
    const result = await getInstagramAudio({
      workspaceId: 'ws_1',
      accountId: 'acct_ig',
      audioId: '1234567890',
    })
    expect(result.audio).toHaveLength(1)
    expect(result.audio[0]!.audioId).toBe('1234567890')
    expect(calls[0].path).toBe('/accounts/zernio_ig/instagram/audio/1234567890')
  })

  test('a track that is gone comes back empty rather than throwing', async () => {
    providerReply = { '/accounts/zernio_ig/instagram/audio/999': { audio: [] } }
    const result = await getInstagramAudio({ workspaceId: 'ws_1', accountId: 'acct_ig', audioId: '999' })
    expect(result.audio).toEqual([])
  })

  test('audioId is required', async () => {
    const error = await getInstagramAudio({ workspaceId: 'ws_1', accountId: 'acct_ig' }).catch(
      (err) => err,
    )
    expect(error.code).toBe('invalid_body')
  })
})
