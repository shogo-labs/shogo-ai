// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

const STORAGE_KEY = 'shogo_attribution'
const LANDING_KEY = 'shogo_landing_page'
const PENDING_KEY = 'shogo_attribution_pending'

/** How long after signup we will still record attribution once a session exists. */
const EMAIL_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const OAUTH_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000

export interface Attribution {
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  referrer?: string
  landingPage?: string
}

const PENDING_PROMPT_KEY = 'shogo_pending_prompt'
const PENDING_PROMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PENDING_PROMPT_MAX_CHARS = 4000
const UTM_COOKIE = '__shogo_utm'
const UTM_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

/**
 * A funnel page on shogo.ai hands the visitor over with `?prompt=` (e.g. the
 * six hooks the try-it just wrote). Keep it through signup and email
 * verification; the home composer takes it once with {@link takePendingPrompt}.
 */
export function capturePendingPrompt(search: string): void {
  const prompt = new URLSearchParams(search).get('prompt')?.trim()
  if (!prompt) return
  safeSetItem(
    PENDING_PROMPT_KEY,
    JSON.stringify({ text: prompt.slice(0, PENDING_PROMPT_MAX_CHARS), at: Date.now() }),
  )
}

/** The handed-over prompt, once; null when none or older than a day. */
export function takePendingPrompt(now = Date.now()): string | null {
  const raw = safeGetItem(PENDING_PROMPT_KEY)
  if (!raw) return null
  safeRemoveItem(PENDING_PROMPT_KEY)
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; at?: unknown }
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) return null
    if (typeof parsed.at === 'number' && now - parsed.at > PENDING_PROMPT_MAX_AGE_MS) return null
    return parsed.text
  } catch {
    return null
  }
}

/**
 * The signup POST is read server-side from the `__shogo_utm` cookie
 * (`apps/api/src/lib/signup-attribution.ts`). An ad can land straight on the
 * studio, so write it here too — on `.shogo.ai`, and never over a cookie the
 * marketing site already set (first touch wins).
 */
export function writeUtmCookie(data: Attribution & { funnel?: string; fbclid?: string }, hostname: string): boolean {
  if (typeof document === 'undefined') return false
  if (!/(^|\.)shogo\.ai$/.test(hostname)) return false
  if (!data.utmSource && !data.utmCampaign && !data.utmContent && !data.fbclid && !data.funnel) return false
  if (document.cookie.split(';').some((c) => c.trim().startsWith(`${UTM_COOKIE}=`))) return false
  const value = encodeURIComponent(JSON.stringify(data))
  document.cookie = `${UTM_COOKIE}=${value}; Domain=.shogo.ai; Path=/; Max-Age=${UTM_COOKIE_MAX_AGE_S}; SameSite=Lax; Secure`
  return true
}

export function captureAttribution(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return
  capturePendingPrompt(window.location.search)
  if (safeGetItem(STORAGE_KEY)) return

  const params = new URLSearchParams(window.location.search)
  const data: Attribution = {
    utmSource: params.get('utm_source') || undefined,
    utmMedium: params.get('utm_medium') || undefined,
    utmCampaign: params.get('utm_campaign') || undefined,
    utmContent: params.get('utm_content') || undefined,
    utmTerm: params.get('utm_term') || undefined,
    referrer: document.referrer || undefined,
    landingPage: window.location.pathname + window.location.search,
  }

  safeSetItem(STORAGE_KEY, JSON.stringify(data))
  writeUtmCookie(
    {
      ...data,
      funnel: params.get('funnel') || undefined,
      fbclid: params.get('fbclid') || undefined,
    },
    window.location.hostname,
  )
}

export function getStoredAttribution(): Attribution | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  try {
    const raw = safeGetItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Attribution
  } catch {
    return null
  }
}

export function clearStoredAttribution(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return
  safeRemoveItem(STORAGE_KEY)
  safeRemoveItem(LANDING_KEY)
}

export type SignupMethod = 'email' | 'google' | 'apple'

export interface PendingSignupAttribution extends Attribution {
  method: SignupMethod
  /** When this signup was queued, so a later sign-in of a different account is not attributed. */
  queuedAt?: number
}

/** Account creation and the queue are the same signup; allow a few minutes of clock skew. */
const QUEUE_MATCH_SKEW_MS = 5 * 60 * 1000

let flushInFlight: Promise<boolean> | null = null

/**
 * Remember how this visit signed up, plus any UTMs captured on the landing
 * page, until an authenticated session can POST them.
 *
 * Email verification and the Google redirect both leave the browser without
 * a session at the moment of signup. Posting immediately 401s, the error is
 * swallowed, and `signup_attributions` stays empty. The pending payload
 * survives those round trips; `flushSignupAttribution` writes it once the
 * account exists.
 */
export function queueSignupAttribution(method: SignupMethod): void {
  const captured = getStoredAttribution()
  const pending: PendingSignupAttribution = { ...(captured ?? {}), method, queuedAt: Date.now() }
  safeSetItem(PENDING_KEY, JSON.stringify(pending))
}

export function getPendingSignupAttribution(): PendingSignupAttribution | null {
  try {
    const raw = safeGetItem(PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingSignupAttribution
    if (parsed.method !== 'email' && parsed.method !== 'google' && parsed.method !== 'apple') {
      return null
    }
    if (typeof parsed.queuedAt === 'number' && Number.isFinite(parsed.queuedAt)) {
      const maxAge = parsed.method === 'email' ? EMAIL_ATTRIBUTION_WINDOW_MS : OAUTH_ATTRIBUTION_WINDOW_MS
      if (Date.now() - parsed.queuedAt > maxAge) {
        discardPendingSignupAttribution()
        return null
      }
    }
    return parsed
  } catch {
    return null
  }
}

/** Drop a queued signup without posting. Used when the signed-in account is not new. */
export function discardPendingSignupAttribution(): void {
  safeRemoveItem(PENDING_KEY)
}

/**
 * True when this account is still inside the window where a queued signup
 * should be recorded. Email waits out verification. Google and Apple only
 * cover the redirect, so a later sign-in does not attribute an old account.
 */
export function shouldRecordSignupAttribution(
  pending: PendingSignupAttribution,
  accountCreatedAt: string | Date | null | undefined,
  now = Date.now(),
): boolean {
  if (!accountCreatedAt) return false
  const created = accountCreatedAt instanceof Date ? accountCreatedAt.getTime() : new Date(accountCreatedAt).getTime()
  if (Number.isNaN(created)) return false
  const maxAge = pending.method === 'email' ? EMAIL_ATTRIBUTION_WINDOW_MS : OAUTH_ATTRIBUTION_WINDOW_MS
  if (now - created > maxAge) return false
  // Without a queue timestamp, fall back to the age window (payloads queued
  // before this field existed).
  if (typeof pending.queuedAt !== 'number' || !Number.isFinite(pending.queuedAt)) return true
  if (now - pending.queuedAt > maxAge) return false
  // The account has to be the one this queue was for. Email verification can
  // take days, but the account is created at queue time. OAuth creates the
  // account during the redirect, shortly after the queue.
  const latest = pending.queuedAt + (pending.method === 'email' ? QUEUE_MATCH_SKEW_MS : OAUTH_ATTRIBUTION_WINDOW_MS)
  return created >= pending.queuedAt - QUEUE_MATCH_SKEW_MS && created <= latest
}

/**
 * POST the queued signup attribution. Clears the queue and the captured UTMs
 * only after the write succeeds, so a 401 during verification can be retried
 * once the session exists. Returns false when nothing is queued.
 */
async function flushSignupAttributionOnce(
  post: (body: PendingSignupAttribution) => Promise<void>,
): Promise<boolean> {
  const pending = getPendingSignupAttribution()
  if (!pending) return false
  await post(pending)
  discardPendingSignupAttribution()
  clearStoredAttribution()
  return true
}

export async function flushSignupAttribution(
  post: (body: PendingSignupAttribution) => Promise<void>,
): Promise<boolean> {
  // The email screen and the signed-in shell can both flush the same queue.
  // Share one in-flight write so that overlap posts once.
  if (flushInFlight) return flushInFlight
  const run = flushSignupAttributionOnce(post).finally(() => {
    if (flushInFlight === run) flushInFlight = null
  })
  flushInFlight = run
  return run
}
