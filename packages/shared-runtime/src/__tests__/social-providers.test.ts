// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect } from 'bun:test'
import {
  ZERNIO_SOCIAL_TOOLKITS,
  isZernioSocialToolkit,
  normalizeToolkitName,
  zernioPlatformsFromQuery,
} from '../social-providers'

describe('ZERNIO_SOCIAL_TOOLKITS', () => {
  it('is exactly instagram and tiktok', () => {
    expect([...ZERNIO_SOCIAL_TOOLKITS]).toEqual(['instagram', 'tiktok'])
  })
})

describe('isZernioSocialToolkit', () => {
  it('matches the slugs and their normalised spellings', () => {
    for (const name of ['instagram', 'Instagram', 'INSTAGRAM', 'tik-tok', 'tik tok', 'TikTok', 'tiktok']) {
      expect(isZernioSocialToolkit(name)).toBe(true)
    }
  })

  it('does not match ad toolkits or unrelated names', () => {
    for (const name of ['metaads', 'meta-ads', 'facebook', 'instagram_ads', 'instagramads', 'slack', '']) {
      expect(isZernioSocialToolkit(name)).toBe(false)
    }
  })
})

describe('normalizeToolkitName', () => {
  it('lower-cases and strips separators', () => {
    expect(normalizeToolkitName('Google_Calendar')).toBe('googlecalendar')
    expect(normalizeToolkitName('tik tok')).toBe('tiktok')
  })
})

describe('zernioPlatformsFromQuery', () => {
  it('detects the platform a free-text query is about', () => {
    expect(zernioPlatformsFromQuery('instagram posting')).toEqual(['instagram'])
    expect(zernioPlatformsFromQuery('tik tok')).toEqual(['tiktok'])
    expect(zernioPlatformsFromQuery('TikTok comments')).toEqual(['tiktok'])
  })

  it('returns every platform a query mentions', () => {
    expect(zernioPlatformsFromQuery('instagram and tiktok')).toEqual(['instagram', 'tiktok'])
  })

  it('returns an empty list for unrelated queries', () => {
    expect(zernioPlatformsFromQuery('meta ads')).toEqual([])
    expect(zernioPlatformsFromQuery('google calendar')).toEqual([])
  })
})
