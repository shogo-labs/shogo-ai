// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the permission-banner dismissal window.
 *
 * `'true'` used to mean "never show the banner again", which permanently
 * retired the only in-app way to grant notification permission.
 *
 * Run: bun test apps/mobile/lib/notifications/__tests__/notification-banner.test.ts
 */

import { describe, expect, test } from 'bun:test'

import { BANNER_DISMISS_COOLDOWN_MS, isBannerDismissed } from '../notification-banner'

const NOW = 1_800_000_000_000

describe('isBannerDismissed', () => {
  test('nothing stored means offer the banner', () => {
    expect(isBannerDismissed(null, NOW)).toBe(false)
    expect(isBannerDismissed('', NOW)).toBe(false)
  })

  test('a fresh dismissal is honoured', () => {
    expect(isBannerDismissed(String(NOW - 1000), NOW)).toBe(true)
  })

  test('a dismissal past the cooldown offers the banner again', () => {
    expect(isBannerDismissed(String(NOW - BANNER_DISMISS_COOLDOWN_MS - 1), NOW)).toBe(false)
  })

  test('exactly at the cooldown boundary it offers again', () => {
    expect(isBannerDismissed(String(NOW - BANNER_DISMISS_COOLDOWN_MS), NOW)).toBe(false)
  })

  test('a legacy permanent "true" is treated as elapsed, not permanent', () => {
    expect(isBannerDismissed('true', NOW)).toBe(false)
  })

  test('unparseable values offer the banner rather than hiding it', () => {
    expect(isBannerDismissed('not-a-timestamp', NOW)).toBe(false)
  })

  test('a future timestamp still counts as dismissed', () => {
    // Clock skew shouldn't force the banner onto someone repeatedly.
    expect(isBannerDismissed(String(NOW + 60_000), NOW)).toBe(true)
  })

  test('the cooldown is a bounded window, not an eternity', () => {
    expect(BANNER_DISMISS_COOLDOWN_MS).toBeGreaterThan(0)
    expect(BANNER_DISMISS_COOLDOWN_MS).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000)
  })
})
