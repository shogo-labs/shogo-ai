// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SocialContentProvider — the pluggable seam between the affiliate
 * content-CPM engine and whatever upstream actually reads Instagram /
 * TikTok data.
 *
 * v1 is backed by EnsembleData (handle-based public-data API; see
 * `ensembledata-provider.ts`). The official OAuth path (IG Graph +
 * TikTok Display API) implements the SAME interface later
 * (`official-provider.ts`) so swapping providers is a one-line factory
 * change in `index.ts` — the service, cron, routes, and dashboard never
 * learn which provider is live.
 *
 * Everything here is normalized: view/like/comment/share counts as
 * plain numbers, platform as our own `SocialPlatform` union, post ids as
 * the provider's stable per-video id. No provider-specific shapes leak
 * past this module.
 */

/** Mirrors the Prisma `SocialPlatform` enum (kept as a string union so
 *  this module doesn't import the generated client). */
export type SocialPlatform = 'instagram' | 'tiktok'

/** A single post/video with its current cumulative metrics. */
export interface NormalizedPost {
  /** Provider's stable per-video id (TikTok aweme id / IG media pk). */
  providerPostId: string
  /** Canonical public URL, when the provider supplies one. */
  url: string | null
  caption: string | null
  postedAt: Date | null
  /** Cumulative view/play count. 0 when the provider omits it (e.g. a
   *  non-video IG image post). */
  views: number
  likes: number
  comments: number
  shares: number
}

/** A search result post — NormalizedPost plus creator context. */
export interface NormalizedSearchResult extends NormalizedPost {
  creator: {
    handle: string
    /** Provider-stable user id, when available (e.g. IG numeric pk). */
    userId: string | null
    /** Follower count, when available (TikTok `get_author_stats=true`). */
    followers: number | null
  }
  /** Video duration in seconds. null when the provider omits it. */
  durationSec: number | null
}

/**
 * Accumulates EnsembleData `units_charged` headers across a request.
 * Passed into provider methods so callers can bill real units rather
 * than estimates. The `units` field starts at 0 and is incremented by
 * each upstream call.
 */
export interface UnitMeter {
  units: number
}

/** Parameters for `searchPosts`. */
export interface SearchPostsOptions {
  query: string
  /** 'keyword' (TikTok only) or 'hashtag' (both platforms). */
  kind: 'keyword' | 'hashtag'
  /** Period in days (0 = all time). Instagram hashtag has no native period — filter client-side. */
  periodDays: number
  limit: number
  meter?: UnitMeter
}

/** Parameters for `creatorBaseline`. */
export interface CreatorBaselineOptions {
  handle: string
  /** Provider-stable user id (skips the 10-unit detailed-info call when present). */
  userId?: string | null
  meter?: UnitMeter
}

/** Baseline stats for a creator's normal view count. */
export interface CreatorBaseline {
  /** Median views across the sample. null when fewer than 3 posts with views > 0. */
  medianViews: number | null
  /** Number of posts in the sample. */
  sample: number
}

/** Public profile fields used for ownership verification. */
export interface NormalizedProfile {
  /** Provider's stable user id (survives a handle rename). */
  providerUserId: string | null
  /** Bio / signature text, used to find the verification code. */
  bio: string
  /** Display name, also searched for the verification code. */
  displayName: string | null
}

/**
 * Stable error surface so callers can branch on cause without parsing
 * vendor strings. `bad_credentials` should page an operator (the API
 * token is wrong/expired); `not_found` is an affiliate-supplied bad
 * handle; `rate_limited` / `upstream` are transient and the poll just
 * retries next tick.
 */
export type SocialProviderErrorCode =
  | 'bad_credentials'
  | 'not_found'
  | 'rate_limited'
  | 'upstream'
  | 'not_configured'

export class SocialProviderError extends Error {
  constructor(
    public code: SocialProviderErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SocialProviderError'
  }
}

export interface SocialContentProvider {
  /** Stable identifier for logs/metrics (e.g. `ensembledata`). */
  readonly name: string

  /**
   * Fetch the public profile for `handle` on `platform`. Used by the
   * ownership-verification flow (look for the bio code) and to capture a
   * stable `providerUserId`.
   */
  getProfile(platform: SocialPlatform, handle: string, meter?: UnitMeter): Promise<NormalizedProfile>

  /**
   * List the account's most-recent posts (newest first), capped at
   * roughly `limit`. The poller upserts these and snapshots their view
   * counts; older posts age out of the window naturally.
   */
  listRecentPosts(
    platform: SocialPlatform,
    handle: string,
    limit: number,
    meter?: UnitMeter,
  ): Promise<NormalizedPost[]>

  /**
   * Search for posts/reels by keyword or hashtag. TikTok supports both
   * keyword and hashtag; Instagram supports hashtag only (a plain keyword
   * is compacted to a hashtag and `query_used` reflects what was sent).
   */
  searchPosts(platform: SocialPlatform, opts: SearchPostsOptions): Promise<{
    results: NormalizedSearchResult[]
    queryUsed: string
  }>

  /**
   * Compute a creator's baseline (median views) from their recent posts.
   * TikTok: 1 unit via /tt/user/posts. Instagram: /instagram/user/reels by
   * userId when present (skips the 10-unit detailed-info call), falling back
   * to listRecentPosts. Returns null medianViews when fewer than 3 valid posts.
   */
  creatorBaseline(
    platform: SocialPlatform,
    opts: CreatorBaselineOptions,
  ): Promise<CreatorBaseline>
}
