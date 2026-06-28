// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Customer.io Service
 *
 * Server-side integration with Customer.io for lifecycle marketing automation.
 * Uses the Track API (identify users, fire behavioral events) and the App API
 * (suppress users on upgrade, campaign management).
 *
 * All calls are fire-and-forget and never throw into the caller — a failed
 * analytics call must never break a product flow.
 *
 * Env vars required (gracefully disabled if absent):
 *   CUSTOMERIO_SITE_ID          — Track API site ID
 *   CUSTOMERIO_TRACKING_API_KEY — Track API key (Basic auth credential)
 *   CUSTOMERIO_APP_API_KEY      — App API key (Bearer token)
 */

const SITE_ID = process.env.CUSTOMERIO_SITE_ID
const TRACKING_API_KEY = process.env.CUSTOMERIO_TRACKING_API_KEY
const APP_API_KEY = process.env.CUSTOMERIO_APP_API_KEY

const TRACK_BASE = 'https://track.customer.io/api/v1'
const APP_BASE = 'https://api.customer.io/v1'

function isConfigured(): boolean {
  return !!(SITE_ID && TRACKING_API_KEY)
}

function trackingAuthHeader(): string {
  return `Basic ${Buffer.from(`${SITE_ID}:${TRACKING_API_KEY}`).toString('base64')}`
}

async function trackingPost(path: string, body: unknown): Promise<void> {
  if (!isConfigured()) return
  try {
    const res = await fetch(`${TRACK_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: trackingAuthHeader(),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[CustomerIO] POST ${path} → ${res.status}: ${text}`)
    }
  } catch (err: any) {
    console.warn(`[CustomerIO] POST ${path} failed: ${err?.message ?? err}`)
  }
}

async function trackingPut(path: string, body: unknown): Promise<void> {
  if (!isConfigured()) return
  try {
    const res = await fetch(`${TRACK_BASE}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: trackingAuthHeader(),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[CustomerIO] PUT ${path} → ${res.status}: ${text}`)
    }
  } catch (err: any) {
    console.warn(`[CustomerIO] PUT ${path} failed: ${err?.message ?? err}`)
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Identify a user in Customer.io. Call on signup and whenever user traits
 * change (e.g. plan upgrade). Customer.io merges traits — missing keys are
 * left unchanged.
 *
 * https://customer.io/docs/api/track/#operation/identify
 */
export async function identifyUser(
  userId: string,
  traits: {
    email: string
    name?: string
    plan?: string
    created_at?: number
  },
): Promise<void> {
  await trackingPut(`/customers/${encodeURIComponent(userId)}`, traits)
}

/**
 * Track a behavioral event for a user. Triggers campaign automation in
 * Customer.io (drip sequences, conversion emails, etc.).
 *
 * https://customer.io/docs/api/track/#operation/track
 */
export async function trackEvent(
  userId: string,
  eventName: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await trackingPost(`/customers/${encodeURIComponent(userId)}/events`, {
    name: eventName,
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
  })
}

/**
 * Suppress a user — removes them from all active campaign sequences.
 * Call when a free user upgrades to a paid plan.
 *
 * Uses the App API (requires CUSTOMERIO_APP_API_KEY).
 * https://customer.io/docs/api/app/#operation/suppress
 */
export async function suppressUser(userId: string): Promise<void> {
  if (!APP_API_KEY) {
    console.warn('[CustomerIO] suppressUser called but CUSTOMERIO_APP_API_KEY not set')
    return
  }
  try {
    const res = await fetch(`${APP_BASE}/customers/${encodeURIComponent(userId)}/suppress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${APP_API_KEY}`,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[CustomerIO] suppressUser ${userId} → ${res.status}: ${text}`)
    }
  } catch (err: any) {
    console.warn(`[CustomerIO] suppressUser ${userId} failed: ${err?.message ?? err}`)
  }
}

/**
 * Unsuppress a user — re-enables campaign sequences after suppression.
 * Exposed for completeness; not currently called in product flows.
 */
export async function unsuppressUser(userId: string): Promise<void> {
  if (!APP_API_KEY) return
  try {
    const res = await fetch(`${APP_BASE}/customers/${encodeURIComponent(userId)}/unsuppress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${APP_API_KEY}`,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[CustomerIO] unsuppressUser ${userId} → ${res.status}: ${text}`)
    }
  } catch (err: any) {
    console.warn(`[CustomerIO] unsuppressUser ${userId} failed: ${err?.message ?? err}`)
  }
}
