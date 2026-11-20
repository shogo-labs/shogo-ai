// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EnsembleData-backed SocialContentProvider (v1 of the affiliate
 * content-CPM data source).
 *
 * EnsembleData (https://ensembledata.com/apis) is a handle-based
 * public-data API: every request carries a `token` query param and the
 * response is wrapped in `{ "data": ... }`. We normalize the
 * platform-specific shapes here so nothing downstream sees an aweme or a
 * GraphQL media node.
 *
 * Endpoints used:
 *   TikTok    GET /tt/user/info              (profile/bio for verification)
 *             GET /tt/user/posts             (recent posts + playCount)
 *   Instagram GET /instagram/user/detailed-info (profile/bio + numeric user
 *                                              id; the basic /user/info
 *                                              endpoint omits `biography`)
 *             GET /instagram/user/posts      (recent posts, needs user_id)
 *             GET /instagram/user/reels      (reels carry view counts)
 *
 * Instagram's posts/reels endpoints key on the NUMERIC user id, not the
 * handle, so `listRecentPosts` resolves the profile first. View counts
 * only exist for video content (reels / video posts); image posts
 * normalize to 0 views and therefore never accrue CPM.
 *
 * Token + base URL are injected (see `index.ts`) so this class is pure
 * and unit-testable with a fake `fetch`.
 */

import {
  type CreatorBaseline,
  type CreatorBaselineOptions,
  type NormalizedPost,
  type NormalizedProfile,
  type NormalizedSearchResult,
  type SearchPostsOptions,
  type SocialContentProvider,
  type SocialPlatform,
  type UnitMeter,
  SocialProviderError,
} from './provider'
import { median } from './outlier'

const DEFAULT_BASE_URL = 'https://ensembledata.com/apis'

export interface EnsembleDataProviderOptions {
  token: string
  baseUrl?: string
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

type Json = Record<string, any>

function toNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = parseInt(v, 10)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** Unix seconds (number or string) → Date, or null. */
function unixToDate(v: unknown): Date | null {
  const n = toNum(v)
  if (n <= 0) return null
  return new Date(n * 1000)
}

export class EnsembleDataProvider implements SocialContentProvider {
  readonly name = 'ensembledata'
  private readonly token: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: EnsembleDataProviderOptions) {
    if (!opts.token) {
      throw new SocialProviderError('not_configured', 'EnsembleData token is empty')
    }
    this.token = opts.token
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  // --- low-level request --------------------------------------------------

  private async request(endpoint: string, params: Record<string, string | number | undefined>, meter?: UnitMeter): Promise<any> {
    const url = new URL(this.baseUrl + endpoint)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    url.searchParams.set('token', this.token)

    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
      })
    } catch (err: any) {
      throw new SocialProviderError('upstream', `EnsembleData network error: ${err?.message ?? err}`)
    }

    if (!res.ok) {
      // EnsembleData encodes failure modes as HTTP status codes.
      // 491 token not found / 492 email unverified / 493 subscription
      // expired all indicate our credentials/account are broken — surface
      // as bad_credentials so an operator gets paged rather than silently
      // dropping every affiliate's views.
      if (res.status === 491 || res.status === 492 || res.status === 493) {
        throw new SocialProviderError('bad_credentials', `EnsembleData auth/account error (HTTP ${res.status})`)
      }
      if (res.status === 495 || res.status === 429) {
        throw new SocialProviderError('rate_limited', `EnsembleData rate/units exhausted (HTTP ${res.status})`)
      }
      // 471 restricted / 473 not found / 474 etc — the handle is bad.
      if (res.status === 471 || res.status === 473 || res.status === 474 || res.status === 404) {
        throw new SocialProviderError('not_found', `EnsembleData: account not found/restricted (HTTP ${res.status})`)
      }
      throw new SocialProviderError('upstream', `EnsembleData HTTP ${res.status}`)
    }

    if (meter) {
      const charged = Number(res.headers.get('units_charged') ?? res.headers.get('x-units-charged') ?? '0')
      if (Number.isFinite(charged) && charged > 0) {
        meter.units += charged
      }
    }

    let json: Json
    try {
      json = (await res.json()) as Json
    } catch (err: any) {
      throw new SocialProviderError('upstream', `EnsembleData: malformed JSON: ${err?.message ?? err}`)
    }
    return json?.data ?? json
  }

  // --- profile / verification --------------------------------------------

  async getProfile(platform: SocialPlatform, handle: string, meter?: UnitMeter): Promise<NormalizedProfile> {
    const h = normalizeHandle(handle)
    if (platform === 'tiktok') {
      const data = await this.request('/tt/user/info', { username: h }, meter)
      const user = data?.user ?? data ?? {}
      return {
        providerUserId: strOrNull(user.id ?? user.uid ?? user.sec_uid ?? user.secUid),
        bio: String(user.signature ?? user.desc ?? ''),
        displayName: strOrNull(user.nickname ?? user.unique_id ?? user.uniqueId),
      }
    }
    // instagram
    //
    // Use /instagram/user/detailed-info (NOT /instagram/user/info): the basic
    // info endpoint returns a minimal profile WITHOUT `biography`, so bio-code
    // ownership verification could never succeed. detailed-info returns the
    // user object directly under `data` (no `.user` nesting) and includes
    // `biography`, `full_name`, and the numeric `id` that listRecentPosts needs.
    const data = await this.request('/instagram/user/detailed-info', { username: h }, meter)
    const u = data?.user ?? data ?? {}
    return {
      providerUserId: strOrNull(u.id ?? u.pk ?? u.fbid),
      bio: String(u.biography ?? ''),
      displayName: strOrNull(u.full_name ?? u.fullName ?? u.username),
    }
  }

  // --- posts --------------------------------------------------------------

  async listRecentPosts(platform: SocialPlatform, handle: string, limit: number, meter?: UnitMeter): Promise<NormalizedPost[]> {
    const h = normalizeHandle(handle)
    const depth = Math.max(1, Math.ceil(limit / 10))
    if (platform === 'tiktok') {
      const data = await this.request('/tt/user/posts', { username: h, depth }, meter)
      const items = asArray(data)
      return items.slice(0, limit).map((p) => normalizeTikTokPost(p, h))
    }

    // Instagram needs the numeric user id; resolve it first.
    const profile = await this.getProfile('instagram', h, meter)
    const userId = profile.providerUserId
    if (!userId) {
      throw new SocialProviderError('not_found', `Instagram user id not resolvable for @${h}`)
    }
    const [postsData, reelsData] = await Promise.all([
      this.request('/instagram/user/posts', { user_id: userId, depth }, meter).catch(swallowNotFound),
      this.request('/instagram/user/reels', { user_id: userId, depth }, meter).catch(swallowNotFound),
    ])

    const byId = new Map<string, NormalizedPost>()
    for (const node of asArray(postsData)) {
      const post = normalizeInstagramPost(node)
      if (post) byId.set(post.providerPostId, post)
    }
    for (const media of asArray(reelsData)) {
      const post = normalizeInstagramReel(media)
      // Reels carry authoritative view counts; let them win over a
      // posts-feed entry for the same id (which may lack views).
      if (post) byId.set(post.providerPostId, post)
    }
    return Array.from(byId.values()).slice(0, limit)
  }

  // --- search -------------------------------------------------------------

  async searchPosts(
    platform: SocialPlatform,
    opts: SearchPostsOptions,
  ): Promise<{ results: NormalizedSearchResult[]; queryUsed: string }> {
    const { query, kind, periodDays, limit: rawLimit, meter } = opts
    const limit = Math.min(50, Math.max(1, Math.floor(rawLimit)))

    if (platform === 'tiktok') {
      return this._searchTikTok(query, kind, periodDays, limit, meter)
    }
    // Instagram: hashtag-only. Compact a plain keyword to a hashtag.
    return this._searchInstagramHashtag(query, limit, periodDays, meter)
  }

  private async _searchTikTok(
    query: string,
    kind: 'keyword' | 'hashtag',
    periodDays: number,
    limit: number,
    meter?: UnitMeter,
  ): Promise<{ results: NormalizedSearchResult[]; queryUsed: string }> {
    const name = query.replace(/^#+/, '')
    const endpoint = kind === 'hashtag' ? '/tt/hashtag/posts' : '/tt/keyword/search'
    const periodParam = kind === 'hashtag' ? undefined : periodDays  // hashtag has no native period

    const results: NormalizedSearchResult[] = []
    const seen = new Set<string>()
    let cursor: string | undefined

    // EnsembleData pages ~20 posts per call; cap at ceil(limit/20) pages.
    const maxPages = Math.ceil(limit / 20) + 1
    for (let page = 0; page < maxPages && results.length < limit; page++) {
      const params: Record<string, string | number | undefined> = {
        name,
        ...(periodParam !== undefined ? { period: periodParam } : {}),
        ...(cursor ? { cursor } : {}),
        get_author_stats: 1,
        sorting: 1,
      }
      const data = await this.request(endpoint, params, meter)
      const items = asArray(kind === 'hashtag' ? (data?.videos ?? data) : data)
      let hadNew = false
      for (const item of items) {
        const aweme = item?.aweme_info ?? item
        const id = String(aweme?.aweme_id ?? aweme?.video?.id ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        hadNew = true

        const handle = (strOrNull(aweme?.author?.unique_id ?? aweme?.author?.uniqueId) ?? '').toLowerCase()
        const followers = toNum(aweme?.author_stats?.follower_count ?? aweme?.author?.follower_count ?? aweme?.author?.followerCount)
        const userId = strOrNull(aweme?.author?.uid ?? aweme?.author?.id)

        // duration: may be in ms when > 1000
        let durationSec: number | null = null
        const rawDur = toNum(aweme?.video?.duration ?? aweme?.duration ?? 0)
        if (rawDur > 0) {
          durationSec = rawDur > 1000 ? Math.round(rawDur / 1000) : rawDur
        }

        const stats = aweme?.statistics ?? aweme?.stats ?? {}
        const url = strOrNull(aweme?.share_url ?? aweme?.share_info?.share_url) ??
          (id && handle ? `https://www.tiktok.com/@${handle}/video/${id}` : null)

        // If periodDays > 0 and kind === 'hashtag', filter client-side
        if (kind === 'hashtag' && periodDays > 0 && aweme?.create_time) {
          const cutoff = Date.now() / 1000 - periodDays * 86400
          if (toNum(aweme.create_time) < cutoff) continue
        }

        results.push({
          providerPostId: id,
          url,
          caption: strOrNull(aweme?.desc ?? aweme?.content_desc),
          postedAt: unixToDate(aweme?.create_time),
          views: toNum(stats.play_count ?? stats.playCount),
          likes: toNum(stats.digg_count ?? stats.diggCount),
          comments: toNum(stats.comment_count ?? stats.commentCount),
          shares: toNum(stats.share_count ?? stats.shareCount),
          creator: { handle, userId, followers: followers || null },
          durationSec,
        })
        if (results.length >= limit) break
      }
      cursor = strOrNull(data?.cursor ?? data?.extra?.cursor ?? null) ?? undefined
      if (!cursor || !hadNew) break
    }

    const queryUsed = kind === 'hashtag' ? `#${name}` : name
    return { results, queryUsed }
  }

  private async _searchInstagramHashtag(
    query: string,
    limit: number,
    periodDays: number,
    meter?: UnitMeter,
  ): Promise<{ results: NormalizedSearchResult[]; queryUsed: string }> {
    // Compact plain keyword to hashtag: "ai agents" → "aiagents"
    const rawTag = query.replace(/^#+/, '').trim()
    const hashtag = rawTag.replace(/\s+/g, '')
    const queryUsed = `#${hashtag}`

    const results: NormalizedSearchResult[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    const maxPages = Math.ceil(limit / 20) + 1
    const cutoff = periodDays > 0 ? Date.now() / 1000 - periodDays * 86400 : 0

    for (let page = 0; page < maxPages && results.length < limit; page++) {
      const data = await this.request('/instagram/hashtag/posts', {
        name: hashtag,
        ...(cursor ? { cursor } : {}),
      }, meter)
      const items = asArray(data?.medias ?? data?.posts ?? data)
      let hadNew = false
      for (const item of items) {
        const media = item?.node ?? item
        const id = String(media?.id ?? media?.pk ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        hadNew = true

        const isVideo = media?.is_video === true || media?.media_type === 2 || media?.product_type === 'clips'
        if (!isVideo) continue  // non-video posts have no meaningful view count

        // Filter by period client-side
        const takenAt = toNum(media?.taken_at_timestamp ?? media?.taken_at)
        if (cutoff > 0 && takenAt > 0 && takenAt < cutoff) continue

        const shortcode = strOrNull(media?.shortcode ?? media?.code)
        const url = shortcode ? `https://www.instagram.com/reel/${shortcode}/` : null

        const ownerHandle = (strOrNull(media?.owner?.username ?? media?.owner?.handle) ?? '').toLowerCase()
        const ownerId = strOrNull(media?.owner?.id ?? media?.owner?.pk)
        const durationSec = media?.video_duration ? Math.round(toNum(media.video_duration)) : null

        results.push({
          providerPostId: id,
          url,
          caption: strOrNull(media?.edge_media_to_caption?.edges?.[0]?.node?.text ?? media?.caption),
          postedAt: unixToDate(takenAt || null),
          views: toNum(media?.video_view_count ?? media?.video_play_count ?? media?.play_count),
          likes: toNum(media?.edge_media_preview_like?.count ?? media?.like_count),
          comments: toNum(media?.edge_media_to_comment?.count ?? media?.comment_count),
          shares: 0,
          creator: { handle: ownerHandle, userId: ownerId, followers: null },
          durationSec,
        })
        if (results.length >= limit) break
      }
      cursor = strOrNull(data?.end_cursor ?? data?.page_info?.end_cursor ?? null) ?? undefined
      if (!cursor || !hadNew) break
    }

    return { results, queryUsed }
  }

  // --- creator baseline ---------------------------------------------------

  async creatorBaseline(
    platform: SocialPlatform,
    opts: CreatorBaselineOptions,
  ): Promise<CreatorBaseline> {
    const { handle, userId, meter } = opts
    const h = normalizeHandle(handle)

    if (platform === 'tiktok') {
      const data = await this.request('/tt/user/posts', { username: h, depth: 1 }, meter)
      const items = asArray(data).slice(0, 12)
      const viewCounts = items
        .map((p: Json) => toNum((p.statistics ?? p.stats ?? {}).play_count ?? (p.statistics ?? p.stats ?? {}).playCount))
        .filter((v: number) => v > 0)
      return {
        medianViews: viewCounts.length >= 3 ? median(viewCounts) : null,
        sample: viewCounts.length,
      }
    }

    // Instagram: use user id from the search result to avoid the 10-unit detailed-info call.
    const resolvedUserId = userId ?? null
    let reelsData: any
    if (resolvedUserId) {
      reelsData = await this.request('/instagram/user/reels', { user_id: resolvedUserId, depth: 1 }, meter).catch(swallowNotFound)
    } else {
      // Fall back to listRecentPosts (which calls detailed-info + posts + reels)
      const posts = await this.listRecentPosts('instagram', h, 12, meter)
      const viewCounts = posts.map((p) => p.views).filter((v) => v > 0)
      return {
        medianViews: viewCounts.length >= 3 ? median(viewCounts) : null,
        sample: viewCounts.length,
      }
    }
    const items = asArray(reelsData).slice(0, 12)
    const viewCounts = items
      .map((item: Json) => {
        const media = item?.media ?? item
        return toNum(media?.play_count ?? media?.view_count ?? media?.ig_play_count)
      })
      .filter((v: number) => v > 0)
    return {
      medianViews: viewCounts.length >= 3 ? median(viewCounts) : null,
      sample: viewCounts.length,
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s.length ? s : null
}

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase()
}

/** A `not_found` while fetching one of the two IG feeds shouldn't nuke
 *  the whole poll — return an empty payload so the other feed still
 *  contributes. Other errors propagate. */
function swallowNotFound(err: unknown): never[] {
  if (err instanceof SocialProviderError && err.code === 'not_found') return []
  throw err
}

/** EnsembleData payloads come back either as a bare array or wrapped in
 *  `{ data: [...] }` / `{ posts: [...] }` / `{ aweme_list: [...] }` /
 *  `{ reels: [...] }` depending on the endpoint. Flatten to an array. */
function asArray(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  return (
    payload.data ??
    payload.posts ??
    payload.aweme_list ??
    payload.reels ??
    payload.items ??
    []
  )
}

function normalizeTikTokPost(p: Json, handle: string): NormalizedPost {
  const stats = p.statistics ?? p.stats ?? p.itemInfos ?? {}
  const id = String(p.aweme_id ?? p.id ?? p.itemInfos?.id ?? p.aweme_info?.aweme_id ?? '')
  const url =
    strOrNull(p.share_url) ??
    strOrNull(p.share_info?.share_url) ??
    (id ? `https://www.tiktok.com/@${handle}/video/${id}` : null)
  return {
    providerPostId: id,
    url,
    caption: strOrNull(p.desc ?? p.content_desc ?? p.itemInfos?.text),
    postedAt: unixToDate(p.create_time ?? p.createTime ?? p.itemInfos?.createTime),
    views: toNum(stats.play_count ?? stats.playCount ?? p.play_count),
    likes: toNum(stats.digg_count ?? stats.diggCount ?? p.digg_count),
    comments: toNum(stats.comment_count ?? stats.commentCount ?? p.comment_count),
    shares: toNum(stats.share_count ?? stats.shareCount ?? p.share_count),
  }
}

function normalizeInstagramPost(item: Json): NormalizedPost | null {
  const node = item?.node ?? item
  if (!node) return null
  const id = String(node.id ?? node.pk ?? '')
  if (!id) return null
  const shortcode = strOrNull(node.shortcode ?? node.code)
  const isVideo = node.is_video === true || node.product_type === 'clips'
  const url = shortcode
    ? `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${shortcode}/`
    : null
  return {
    providerPostId: id,
    url,
    caption: strOrNull(node.edge_media_to_caption?.edges?.[0]?.node?.text),
    postedAt: unixToDate(node.taken_at_timestamp ?? node.taken_at),
    views: toNum(node.video_view_count ?? node.video_play_count ?? node.play_count),
    likes: toNum(node.edge_media_preview_like?.count ?? node.edge_liked_by?.count),
    comments: toNum(node.edge_media_to_comment?.count),
    shares: 0,
  }
}

function normalizeInstagramReel(item: Json): NormalizedPost | null {
  const media = item?.media ?? item
  if (!media) return null
  const id = String(media.pk ?? media.id ?? '')
  if (!id) return null
  const shortcode = strOrNull(media.code)
  const url = shortcode ? `https://www.instagram.com/reel/${shortcode}/` : null
  return {
    providerPostId: id,
    url,
    caption: strOrNull(media.caption?.text ?? media.caption),
    postedAt: unixToDate(media.taken_at ?? media.device_timestamp),
    views: toNum(media.play_count ?? media.view_count ?? media.ig_play_count),
    likes: toNum(media.like_count),
    comments: toNum(media.comment_count),
    shares: toNum(media.reshare_count ?? media.share_count),
  }
}
