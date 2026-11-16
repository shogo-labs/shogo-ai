// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instagram and TikTok accounts are connected through Zernio (`social_media`,
 * `/api/workspaces/:id/social/*`, the Social page), never through Composio.
 *
 * Composio's catalog still contains `instagram` and `tiktok` toolkits, so the
 * generic "connect an integration" paths would otherwise offer both platforms
 * twice and the agent would usually take the Composio one. Every path that
 * lists or connects a toolkit filters through `isZernioSocialToolkit`, so this
 * is the single list.
 */

export const ZERNIO_SOCIAL_TOOLKITS = ['instagram', 'tiktok'] as const

export type ZernioSocialToolkit = (typeof ZERNIO_SOCIAL_TOOLKITS)[number]

/**
 * Normalise a toolkit name the same way `findComposioToolkit` does: lower-case
 * and strip `-`, `_` and whitespace. `"Instagram"`, `"tik-tok"` and
 * `"tik tok"` all collapse to a Zernio slug.
 */
export function normalizeToolkitName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, '')
}

/**
 * Exact match after normalising only. Ad toolkits such as `metaads`,
 * `facebook` and `instagram_ads` must not match.
 */
export function isZernioSocialToolkit(name: string): name is ZernioSocialToolkit {
  const normalized = normalizeToolkitName(name)
  return (ZERNIO_SOCIAL_TOOLKITS as readonly string[]).includes(normalized)
}

/**
 * The Zernio platforms a free-text query is about. Used by
 * `search_integrations` so a query like "instagram posting" or "tik tok"
 * surfaces the Zernio row instead of a Composio toolkit.
 */
export function zernioPlatformsFromQuery(query: string): ZernioSocialToolkit[] {
  const normalized = normalizeToolkitName(query)
  return ZERNIO_SOCIAL_TOOLKITS.filter((platform) => normalized.includes(platform))
}
