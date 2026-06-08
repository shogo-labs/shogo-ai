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
  test('merges posts + reels, reels win on view counts', async () => {
    const { fn } = fakeFetch((url) => {
      if (url.pathname.endsWith('/instagram/user/info')) {
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
