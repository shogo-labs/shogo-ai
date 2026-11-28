// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The conversion contract shared by the browser and the server (SHO-611).
 *
 * Meta only dedupes a Conversions API event against a pixel event when both
 * carry the same `event_name` + `event_id` on the same pixel. The ids and the
 * first-party cookie names therefore live here, imported by
 * `apps/mobile/lib/tracking.ts` and by `apps/api/src/lib/meta-capi.ts`, so the
 * two sides cannot drift apart.
 *
 * Also the one cookie contract the marketing site follows (card 5): write
 * `__shogo_utm` on `Domain=.shogo.ai` as URL-encoded JSON in the
 * `AttributionCookiePayload` shape, and append the visitor's PostHog
 * `distinct_id` to studio links as `ph_did`.
 */

/** First-party cookie the website (or the studio app) stores attribution in. */
export const SHOGO_UTM_COOKIE = '__shogo_utm'
/** Meta's click id cookie. */
export const META_FBC_COOKIE = '_fbc'
/** Meta's browser id cookie. */
export const META_FBP_COOKIE = '_fbp'
/** Query parameter, and the key inside `__shogo_utm`, carrying PostHog's id. */
export const POSTHOG_DISTINCT_ID_PARAM = 'ph_did'

/** How long the attribution cookie lives: 90 days, in seconds. */
export const ATTRIBUTION_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

/** The JSON blob `__shogo_utm` carries. Every field is optional. */
export interface AttributionCookiePayload {
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  referrer?: string
  landingPage?: string
  fbclid?: string
  gclid?: string
  phDid?: string
}

/** `signup_<userId>` — the id both `trackSignUp` and `CompleteRegistration` use. */
export function signupEventId(userId: string): string {
  return `signup_${userId}`
}

/** A purchase's id is the Stripe checkout session id itself. */
export function purchaseEventId(checkoutSessionId: string): string {
  return checkoutSessionId
}

/** The subscription event shares the session id with a `_sub` suffix. */
export function subscribeEventId(checkoutSessionId: string): string {
  return `${checkoutSessionId}_sub`
}

/**
 * Meta's documented `_fbc` value: `fb.1.<click time in ms>.<fbclid>`.
 *
 * The subdomain index is always 1: Shogo's pixel is on the root domain and has
 * no subdomain-indexed variants.
 */
export function buildFbcFromFbclid(fbclid: string, clickedAt: number = Date.now()): string {
  return `fb.1.${clickedAt}.${fbclid}`
}
