// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * When to offer the browser-notification permission banner.
 *
 * “Not now” used to be stored as the literal `'true'`, permanently: it was
 * never cleared, so dismissing once retired the only in-app affordance for
 * granting permission. Permission then stayed `'default'` forever and every
 * web alert was dropped with no visible cause. The dismissal is a timestamp
 * now, honoured for a cooldown and then offered again.
 */

export const BANNER_DISMISSED_KEY = 'shogo:notification-banner-dismissed'

/** How long “Not now” is honoured before the banner offers again. */
export const BANNER_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * `stored` is the raw AsyncStorage value. A legacy `'true'` (written before
 * the cooldown existed) counts as elapsed rather than permanent, so anyone
 * already stuck in the dismissed-forever state is offered the prompt again.
 * Unparseable values are treated the same way.
 */
export function isBannerDismissed(stored: string | null, now: number = Date.now()): boolean {
  if (stored === null || stored === '' || stored === 'true') return false
  const dismissedAt = Number(stored)
  if (!Number.isFinite(dismissedAt)) return false
  return now - dismissedAt < BANNER_DISMISS_COOLDOWN_MS
}
