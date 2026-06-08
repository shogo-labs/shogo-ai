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
  getProfile(platform: SocialPlatform, handle: string): Promise<NormalizedProfile>

  /**
   * List the account's most-recent posts (newest first), capped at
   * roughly `limit`. The poller upserts these and snapshots their view
   * counts; older posts age out of the window naturally.
   */
  listRecentPosts(
    platform: SocialPlatform,
    handle: string,
    limit: number,
  ): Promise<NormalizedPost[]>
}
