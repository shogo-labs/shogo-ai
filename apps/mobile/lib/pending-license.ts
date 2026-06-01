// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Stash for a license-key redeem code captured from a deep link
 * (`/billing?redeem=CODE` / `shogo://billing?redeem=CODE`).
 *
 * A brand-new user who opens a redeem link is bounced through
 * sign-up + onboarding, which drops the `redeem` query param. We stash
 * the code at app load (root layout) and consume it once the user is
 * authenticated and has a workspace, routing them to billing with the
 * code prefilled. Mirrors the existing `pending_template_id` pattern.
 *
 * Backed by `safe-storage`: localStorage on web (survives the full
 * signup + email-verification round-trip) and an in-memory fallback on
 * native (survives the app process lifetime).
 */

import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

export const PENDING_LICENSE_KEY = 'pending_license_code'

function normalize(code: string): string {
  return code.trim().toUpperCase()
}

export function setPendingLicenseCode(code: string): void {
  const normalized = normalize(code)
  if (!normalized) return
  safeSetItem(PENDING_LICENSE_KEY, normalized)
}

export function getPendingLicenseCode(): string | null {
  const stored = safeGetItem(PENDING_LICENSE_KEY)
  if (!stored) return null
  const normalized = normalize(stored)
  return normalized || null
}

export function clearPendingLicenseCode(): void {
  safeRemoveItem(PENDING_LICENSE_KEY)
}
