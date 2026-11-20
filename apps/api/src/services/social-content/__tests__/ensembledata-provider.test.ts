// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EnsembleData provider contract tests.
 *
 * Drives the provider with a fake `fetch` returning canned, vendor-shaped
 * payloads and asserts the normalization: TikTok `playCount`/`digg_count`
 * → views/likes, Instagram reels `play_count` → views, error-code
 * mapping (491 → bad_credentials, 473 → not_found, 495 → rate_limited),
 * and that the token never leaks into anything but the query string.
 *
 * Run: bun test apps/api/src/services/social-content/__tests__/ensembledata-provider.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { EnsembleDataProvider } from '../ensembledata-provider'
import { SocialProviderError } from '../provider'

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Records the URLs hit so we can assert on params + token placement. */
function fakeFetch(handler: (url: URL) => Response) {
  const calls: string[] = []
  const fn = (async (input: any) => {
    const url = new URL(String(input))
    calls.push(url.toString())
    return handler(url)
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('EnsembleDataProvider — TikTok', () => {
  test('normalizes posts (playCount → views) and builds a url', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url.pathname).toBe('/apis/tt/user/posts')
      expect(url.searchParams.get('username')).toBe('creator')
      expect(url.searchParams.get('token')).toBe('secret-token')
      return jsonResponse({
        data: [
          {
            aweme_id: '7777',
            desc: 'hello world',
            create_time: 1700000000,
            statistics: { play_count: 12345, digg_count: 100, comment_count: 9, share_count: 4 },
          },
        ],
      })
    })
    const provider = new EnsembleDataProvider({ token: 'secret-token', fetchImpl: fn })
    const posts = await provider.listRecentPosts('tiktok', '@Creator', 10)

    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      providerPostId: '7777',
      views: 12345,
      likes: 100,
      comments: 9,
      shares: 4,
      url: 'https://www.tiktok.com/@creator/video/7777',
    })
    expect(posts[0].postedAt?.getTime()).toBe(1700000000 * 1000)
    // Token only ever in the query string.
    expect(calls.every((c) => c.includes('token=secret-token'))).toBe(true)
  })

  test('getProfile reads the signature as bio', async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({ data: { user: { id: '42', nickname: 'Cool Creator', signature: 'shogo-abcd1234 in bio' } } }),
    )
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const profile = await provider.getProfile('tiktok', 'creator')
    expect(profile.providerUserId).toBe('42')
    expect(profile.bio).toContain('shogo-abcd1234')
    expect(profile.displayName).toBe('Cool Creator')
  })
})

describe('EnsembleDataProvider — Instagram', () => {
  test('getProfile uses detailed-info and reads biography (not the bio-less /user/info)', async () => {
    const { fn, calls } = fakeFetch((url) => {
      // The basic /instagram/user/info endpoint omits `biography`, so calling
      // it would make ownership verification impossible; we must hit
      // detailed-info. Fail loudly if the wrong endpoint is used.
      expect(url.pathname).toBe('/apis/instagram/user/detailed-info')
      expect(url.searchParams.get('username')).toBe('russell.builds')
      return jsonResponse({
        data: { id: '15606412957', fbid: '17841415748710801', biography: 'shogo-44b4b833', full_name: 'Russell LaCour' },
      })
    })
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const profile = await provider.getProfile('instagram', '@Russell.Builds')
    expect(profile.providerUserId).toBe('15606412957')
    expect(profile.bio).toContain('shogo-44b4b833')
    expect(profile.displayName).toBe('Russell LaCour')
    expect(calls).toHaveLength(1)
  })

  test('merges posts + reels, reels win on view counts', async () => {
    const { fn } = fakeFetch((url) => {
      if (url.pathname.endsWith('/instagram/user/detailed-info')) {
        return jsonResponse({ data: { id: '18428658', biography: 'bio here', full_name: 'Kim' } })
      }
      if (url.pathname.endsWith('/instagram/user/posts')) {
        expect(url.searchParams.get('user_id')).toBe('18428658')
        return jsonResponse({
          data: {
            posts: [
              {
                node: {
                  id: '111',
                  shortcode: 'AAA',
                  is_video: true,
                  video_view_count: 500,
                  edge_media_preview_like: { count: 50 },
                  edge_media_to_comment: { count: 5 },
                  taken_at_timestamp: 1700000000,
                  edge_media_to_caption: { edges: [{ node: { text: 'cap' } }] },
                },
              },
            ],
          },
        })
      }
      // reels
      return jsonResponse({
        data: { reels: [{ media: { pk: '111', code: 'AAA', play_count: 9999, like_count: 60, comment_count: 6, taken_at: 1700000001 } }] },
      })
    })
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const posts = await provider.listRecentPosts('instagram', 'kimkardashian', 10)
    const post = posts.find((p) => p.providerPostId === '111')
    expect(post).toBeDefined()
    // Reel view count (9999) overrides the posts-feed value (500).
    expect(post!.views).toBe(9999)
    expect(post!.url).toBe('https://www.instagram.com/reel/AAA/')
  })
})

describe('EnsembleDataProvider — error mapping', () => {
  test('491 → bad_credentials', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ detail: 'token not found' }, 491))
    const provider = new EnsembleDataProvider({ token: 'bad', fetchImpl: fn })
    await expect(provider.getProfile('tiktok', 'x')).rejects.toMatchObject({
      code: 'bad_credentials',
    })
  })

  test('473 → not_found', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ detail: 'user not found' }, 473))
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    await expect(provider.getProfile('tiktok', 'ghost')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  test('495 → rate_limited', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ detail: 'all daily units used' }, 495))
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    await expect(provider.listRecentPosts('tiktok', 'x', 5)).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  test('empty token throws not_configured at construction', () => {
    expect(() => new EnsembleDataProvider({ token: '' })).toThrow(SocialProviderError)
  })
})


// ============================================================
// Search + baseline + units_charged metering (SHO-465)
// ============================================================

describe('EnsembleDataProvider — units_charged metering', () => {
  test('request() increments meter.units from units_charged header', async () => {
    const { fn } = fakeFetch(() => {
      const res = jsonResponse({ data: { user: { id: '1', signature: 'bio', nickname: 'test' } } })
      // Simulate the units_charged header
      return new Response(JSON.stringify({ data: { user: { id: '1', signature: 'bio', nickname: 'test' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'units_charged': '3' },
      })
    })
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const meter = { units: 0 }
    await provider.getProfile('tiktok', 'creator', meter)
    expect(meter.units).toBe(3)
  })

  test('meter is unaffected when units_charged header is absent', async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({ data: { user: { id: '1', signature: '', nickname: 'test' } } }),
    )
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const meter = { units: 0 }
    await provider.getProfile('tiktok', 'creator', meter)
    expect(meter.units).toBe(0)
  })

  test('meter accumulates across multiple requests', async () => {
    const calls: string[] = []
    const fn = (async (input: any) => {
      calls.push(new URL(String(input)).pathname)
      return new Response(
        calls.length === 1
          ? JSON.stringify({ data: { id: '99', biography: 'bio', full_name: 'User' } })
          : JSON.stringify({ data: [] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'units_charged': '5' },
        },
      )
    }) as unknown as typeof fetch

    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const meter = { units: 0 }
    await provider.listRecentPosts('instagram', 'user', 10, meter)
    // Expects: detailed-info (5 units) + user/posts (5 units) + user/reels (5 units) = 15
    expect(meter.units).toBe(15)
  })
})

describe('EnsembleDataProvider — TikTok keyword search', () => {
  test('searches keyword endpoint, normalizes aweme items, includes creator fields', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url.pathname).toBe('/apis/tt/keyword/search')
      expect(url.searchParams.get('name')).toBe('ai agents')
      expect(url.searchParams.get('get_author_stats')).toBe('1')
      return jsonResponse({
        data: [
          {
            aweme_id: 'vid1',
            desc: 'AI agents tutorial',
            create_time: 1700000000,
            statistics: { play_count: 50000, digg_count: 2000, comment_count: 100, share_count: 50 },
            author: { unique_id: 'aiCreator', uid: 'u1', follower_count: 100000 },
            video: { duration: 30 },
          },
        ],
      })
    })
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const { results, queryUsed } = await provider.searchPosts('tiktok', {
      query: 'ai agents',
      kind: 'keyword',
      periodDays: 30,
      limit: 10,
    })

    expect(queryUsed).toBe('ai agents')
    expect(results).toHaveLength(1)
    expect(results[0].views).toBe(50000)
    expect(results[0].creator.handle).toBe('aicreator')
    expect(results[0].creator.followers).toBe(100000)
    expect(results[0].durationSec).toBe(30)
    expect(calls[0]).toContain('/tt/keyword/search')
  })

  test('TikTok hashtag search uses hashtag endpoint', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url.pathname).toBe('/apis/tt/hashtag/posts')
      return jsonResponse({ data: [] })
    })
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const { queryUsed } = await provider.searchPosts('tiktok', {
      query: 'aiagents',
      kind: 'hashtag',
      periodDays: 7,
      limit: 10,
    })
    expect(queryUsed).toBe('#aiagents')
  })

  test('dedupes by providerPostId across pages', async () => {
    let page = 0
    const { fn } = fakeFetch(() => {
      page++
      if (page === 1) {
        return jsonResponse({
          data: [{ aweme_id: 'vid1', desc: 'dup', create_time: 1700000000, statistics: { play_count: 100 }, author: { unique_id: 'h', uid: 'u1' }, video: { duration: 5 } }],
          cursor: 'page2',
        })
      }
      // Second page returns same id
      return jsonResponse({
        data: [{ aweme_id: 'vid1', desc: 'dup', create_time: 1700000000, statistics: { play_count: 100 }, author: { unique_id: 'h', uid: 'u1' }, video: { duration: 5 } }],
      })
    })
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const { results } = await provider.searchPosts('tiktok', {
      query: 'test',
      kind: 'keyword',
      periodDays: 30,
      limit: 10,
    })
    expect(results.filter((r) => r.providerPostId === 'vid1')).toHaveLength(1)
  })

  test('normalizes duration in ms (> 1000) to seconds', async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({
        data: [{ aweme_id: 'v1', desc: '', create_time: 1700000000, statistics: { play_count: 1 }, author: { unique_id: 'h', uid: 'u1' }, video: { duration: 60000 } }],
      }),
    )
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const { results } = await provider.searchPosts('tiktok', { query: 'x', kind: 'keyword', periodDays: 0, limit: 5 })
    expect(results[0].durationSec).toBe(60)
  })
})

describe('EnsembleDataProvider — Instagram hashtag search', () => {
  test('hits /instagram/hashtag/posts, compacts keyword to hashtag', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url.pathname).toBe('/apis/instagram/hashtag/posts')
      expect(url.searchParams.get('name')).toBe('aiagents')
      return jsonResponse({
        medias: [
          {
            id: 'igpost1',
            is_video: true,
            shortcode: 'abc123',
            taken_at_timestamp: 1700000000,
            video_view_count: 25000,
            like_count: 1200,
            video_duration: 15,
            owner: { username: 'igCreator', id: 'ig_uid1' },
          },
        ],
      })
    })
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const { results, queryUsed } = await provider.searchPosts('instagram', {
      query: 'ai agents',
      kind: 'hashtag',
      periodDays: 0,
      limit: 10,
    })
    expect(queryUsed).toBe('#aiagents')
    expect(results).toHaveLength(1)
    expect(results[0].views).toBe(25000)
    expect(results[0].creator.handle).toBe('igcreator')
    expect(results[0].durationSec).toBe(15)
    expect(calls[0]).toContain('/instagram/hashtag/posts')
  })

  test('skips non-video IG posts', async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({
        medias: [
          { id: 'img1', is_video: false, taken_at_timestamp: 1700000000, owner: { username: 'h', id: 'u1' } },
          { id: 'vid1', is_video: true, shortcode: 'vc1', taken_at_timestamp: 1700000000, video_view_count: 5000, owner: { username: 'h', id: 'u1' } },
        ],
      }),
    )
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const { results } = await provider.searchPosts('instagram', { query: 'test', kind: 'hashtag', periodDays: 0, limit: 10 })
    expect(results).toHaveLength(1)
    expect(results[0].providerPostId).toBe('vid1')
  })
})

describe('EnsembleDataProvider — creatorBaseline', () => {
  test('TikTok: returns median of post view counts (depth=1)', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url.pathname).toBe('/apis/tt/user/posts')
      return jsonResponse({
        data: [
          { aweme_id: 'a', statistics: { play_count: 10000 } },
          { aweme_id: 'b', statistics: { play_count: 20000 } },
          { aweme_id: 'c', statistics: { play_count: 30000 } },
        ],
      })
    })
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const baseline = await provider.creatorBaseline('tiktok', { handle: 'creator' })
    expect(baseline.medianViews).toBe(20000)
    expect(baseline.sample).toBe(3)
    // Should be depth=1
    expect(calls[0]).toContain('depth=1')
  })

  test('TikTok: null medianViews when fewer than 3 posts have views', async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({ data: [{ aweme_id: 'a', statistics: { play_count: 10000 } }, { aweme_id: 'b', statistics: { play_count: 0 } }] }),
    )
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const baseline = await provider.creatorBaseline('tiktok', { handle: 'creator' })
    expect(baseline.medianViews).toBeNull()
    expect(baseline.sample).toBe(1)
  })

  test('Instagram: uses user reels by userId (skips detailed-info)', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url.pathname).toBe('/apis/instagram/user/reels')
      expect(url.searchParams.get('user_id')).toBe('12345')
      return jsonResponse({
        data: [
          { media: { pk: 'r1', play_count: 5000 } },
          { media: { pk: 'r2', play_count: 8000 } },
          { media: { pk: 'r3', play_count: 11000 } },
        ],
      })
    })
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const baseline = await provider.creatorBaseline('instagram', { handle: 'ig_user', userId: '12345' })
    expect(baseline.medianViews).toBe(8000)
    expect(baseline.sample).toBe(3)
    expect(calls[0]).toContain('/instagram/user/reels')
    // Must NOT hit detailed-info
    expect(calls.every((c: string) => !c.includes('detailed-info'))).toBe(true)
  })

  test('baseline meter is incremented', async () => {
    const fn = (async (input: any) => {
      return new Response(
        JSON.stringify({ data: [
          { aweme_id: 'a', statistics: { play_count: 10000 } },
          { aweme_id: 'b', statistics: { play_count: 20000 } },
          { aweme_id: 'c', statistics: { play_count: 30000 } },
        ] }),
        { status: 200, headers: { 'content-type': 'application/json', 'units_charged': '1' } },
      )
    }) as unknown as typeof fetch
    const provider = new EnsembleDataProvider({ token: 't', fetchImpl: fn })
    const meter = { units: 0 }
    await provider.creatorBaseline('tiktok', { handle: 'creator', meter })
    expect(meter.units).toBe(1)
  })
})
