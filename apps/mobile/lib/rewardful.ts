// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Legacy Rewardful shim.
 *
 * The native MLM affiliate program (see lib/affiliate-api.ts +
 * apps/api/src/services/affiliate.service.ts) supersedes Rewardful.
 * Attribution is now persisted server-side in AffiliateAttribution at
 * signup and read at Stripe Checkout creation time by
 * `affiliateCheckoutOverrides` in apps/api/src/server.ts — clients no
 * longer need to forward a referralId.
 *
 * Until the SHOGO_AFFILIATES_NATIVE flag is flipped in prod and the
 * Rewardful tracker script is removed from the marketing site, the
 * legacy window.Rewardful object may still exist on web. Returning
 * undefined here when the new program is active deliberately stops the
 * mobile client from forwarding the old query parameter.
 */
import { Platform } from 'react-native'

declare global {
  interface Window {
    Rewardful?: { referral?: string }
    shogoAffiliatesNative?: boolean
  }
}

export function getRewardfulReferral(): string | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined
  // Native MLM flag (exposed by the desktop bridge / public config) suppresses
  // the legacy referral so we don't double-tag a checkout.
  if (window.shogoAffiliatesNative === true) return undefined
  return window.Rewardful?.referral || undefined
}
