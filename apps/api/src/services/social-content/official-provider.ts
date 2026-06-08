// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Official-API SocialContentProvider — SKELETON for the future
 * consent-based path (Instagram Graph API via Facebook Login +
 * TikTok Display API).
 *
 * It implements the same `SocialContentProvider` interface as the
 * EnsembleData provider so setting the `affiliate.content.provider` DB
 * setting to `official` is the only change required downstream. Unlike the
 * handle-based unofficial path, the official APIs require each affiliate
 * to OAuth-connect a Business/Creator account; that token exchange and
 * storage are intentionally out of scope here and will hang off the
 * `AffiliateSocialAccount` row when implemented.
 *
 * Until then every method throws `not_configured` so accidentally
 * selecting this provider fails loud rather than silently returning no
 * data (which would look like "this affiliate posted nothing").
 */

import {
  type NormalizedPost,
  type NormalizedProfile,
  type SocialContentProvider,
  type SocialPlatform,
  SocialProviderError,
} from './provider'

export class OfficialApiProvider implements SocialContentProvider {
  readonly name = 'official'

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getProfile(_platform: SocialPlatform, _handle: string): Promise<NormalizedProfile> {
    throw new SocialProviderError(
      'not_configured',
      'Official IG Graph / TikTok Display provider is not implemented yet. ' +
        'Set the affiliate.content.provider setting to ensembledata.',
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listRecentPosts(_platform: SocialPlatform, _handle: string, _limit: number): Promise<NormalizedPost[]> {
    throw new SocialProviderError(
      'not_configured',
      'Official IG Graph / TikTok Display provider is not implemented yet. ' +
        'Set the affiliate.content.provider setting to ensembledata.',
    )
  }
}
