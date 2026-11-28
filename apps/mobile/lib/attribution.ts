// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import {
  ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
  META_FBC_COOKIE,
  POSTHOG_DISTINCT_ID_PARAM,
  SHOGO_UTM_COOKIE,
  buildFbcFromFbclid,
  type AttributionCookiePayload,
} from '@shogo/shared-app/conversion-events'
import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

const STORAGE_KEY = 'shogo_attribution'
const LANDING_KEY = 'shogo_landing_page'
const PENDING_KEY = 'shogo_attribution_pending'
/** The `ph_did` already aliased in this browser, so it is aliased only once. */
const PH_ALIAS_KEY = 'shogo_ph_did_aliased'

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
  /** Meta click id, for the Conversions API's `fbc` (SHO-611). */
  fbclid?: string
  /** Google click id, for Google Ads offline conversions later. */
  gclid?: string
  /** The website's PostHog anonymous id, so the two funnels join (SHO-611). */
  phDid?: string
}

function isWeb(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined'
}

/**
 * `.shogo.ai` when the page is on that domain, so the cookie written on the
 * marketing site is the one the studio origin sends and vice versa. Any other
 * host (localhost, a preview URL) gets a host-only cookie.
 */
export function attributionCookieDomain(hostname?: string): string | undefined {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location?.hostname ?? '' : '')
  if (!host) return undefined
  return host === 'shogo.ai' || host.endsWith('.shogo.ai') ? '.shogo.ai' : undefined
}

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) return null
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return part.slice(eq + 1).trim()
    }
  }
  return null
}

function writeCookie(name: string, value: string, maxAgeSeconds: number, domain = attributionCookieDomain()): void {
  if (typeof document === 'undefined') return
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'path=/',
    `max-age=${maxAgeSeconds}`,
    'SameSite=Lax',
  ]
  if (domain) attrs.push(`Domain=${domain}`)
  document.cookie = attrs.join('; ')
}

/**
 * Read `__shogo_utm` — the URL-encoded JSON the website (card 5) and this app
 * write, or a plain `utm_source=…&…` query string, which the server also
 * accepts. Anything unparseable is "no attribution", never an error.
 */
export function parseAttributionCookieValue(value: string | null): Attribution {
  if (!value) return {}
  const out: Attribution = {}
  const trimmed = value.trim()
  if (!trimmed) return out

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const pick = (...keys: string[]): string | undefined => {
        for (const key of keys) {
          const v = parsed[key]
          if (typeof v === 'string' && v.trim()) return v
        }
        return undefined
      }
      const assign = (field: keyof Attribution, ...keys: string[]) => {
        const v = pick(...keys)
        if (v) out[field] = v
      }
      assign('utmSource', 'utmSource', 'utm_source')
      assign('utmMedium', 'utmMedium', 'utm_medium')
      assign('utmCampaign', 'utmCampaign', 'utm_campaign')
      assign('utmContent', 'utmContent', 'utm_content')
      assign('utmTerm', 'utmTerm', 'utm_term')
      assign('referrer', 'referrer', 'referrer_url')
      assign('landingPage', 'landingPage', 'landing_page')
      assign('fbclid', 'fbclid', 'fbc_id')
      assign('gclid', 'gclid')
      assign('phDid', 'phDid', 'ph_did', 'posthogDistinctId', 'posthog_distinct_id')
    } catch {
      return {}
    }
    return out
  }

  for (const pair of trimmed.split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = pair.slice(0, eq).trim()
    let val: string
    try {
      val = decodeURIComponent(pair.slice(eq + 1).trim().replace(/\+/g, ' '))
    } catch {
      continue
    }
    if (!val) continue
    if (key === 'utm_source') out.utmSource = val
    else if (key === 'utm_medium') out.utmMedium = val
    else if (key === 'utm_campaign') out.utmCampaign = val
    else if (key === 'utm_content') out.utmContent = val
    else if (key === 'utm_term') out.utmTerm = val
    else if (key === 'referrer') out.referrer = val
    else if (key === 'landing_page') out.landingPage = val
    else if (key === 'fbclid') out.fbclid = val
    else if (key === 'gclid') out.gclid = val
    else if (key === POSTHOG_DISTINCT_ID_PARAM) out.phDid = val
  }
  return out
}

/**
 * First touch wins, missing keys are filled in. A cookie the website already
 * set is never overwritten by the app, but a key it left empty (a `fbclid`
 * that arrived later, say) is still recorded.
 */
export function mergeFirstTouch(base: Attribution, next: Attribution): Attribution {
  const merged: Attribution = { ...base }
  for (const [key, value] of Object.entries(next) as Array<[keyof Attribution, string | undefined]>) {
    if (!value) continue
    if (!merged[key]) merged[key] = value
  }
  return merged
}

export function readAttributionCookie(): Attribution {
  if (!isWeb()) return {}
  return parseAttributionCookieValue(readCookie(SHOGO_UTM_COOKIE))
}

/**
 * Write (or fill in) `__shogo_utm` as URL-encoded JSON, the shape
 * `parseUtmCookie` on the server already accepts. Every signup POST then
 * carries this visit's UTMs, click ids and PostHog id without the client
 * having to be signed in yet.
 */
export function writeAttributionCookie(data: Attribution): void {
  if (!isWeb()) return
  const merged = mergeFirstTouch(readAttributionCookie(), data)
  const payload: AttributionCookiePayload = {}
  for (const [key, value] of Object.entries(merged) as Array<[keyof Attribution, string | undefined]>) {
    if (value) payload[key] = value
  }
  if (Object.keys(payload).length === 0) return
  writeCookie(SHOGO_UTM_COOKIE, JSON.stringify(payload), ATTRIBUTION_COOKIE_MAX_AGE_SECONDS)
}

/**
 * Meta's `_fbc` click id. Written only when there is an `fbclid` and no `_fbc`
 * yet, so the pixel's own value (which carries the real click time) wins.
 */
export function ensureFbcCookie(fbclid: string | undefined, now = Date.now()): void {
  if (!isWeb() || !fbclid) return
  if (readCookie(META_FBC_COOKIE)) return
  writeCookie(META_FBC_COOKIE, buildFbcFromFbclid(fbclid, now), ATTRIBUTION_COOKIE_MAX_AGE_SECONDS)
}

/** The `ph_did` query parameter the website appends to studio links (card 5). */
export function readPhDidParam(): string | undefined {
  if (!isWeb()) return undefined
  try {
    const value = new URLSearchParams(window.location.search).get(POSTHOG_DISTINCT_ID_PARAM)
    return value && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/** This browser's website `distinct_id`, from the cookie the studio set or the link. */
export function getWebsitePosthogDistinctId(): string | undefined {
  return readPhDidParam() ?? readAttributionCookie().phDid ?? getStoredAttribution()?.phDid ?? undefined
}

/** True the first time this `distinct_id` is seen in this browser. */
export function markPosthogAliased(distinctId: string): boolean {
  if (safeGetItem(PH_ALIAS_KEY) === distinctId) return false
  safeSetItem(PH_ALIAS_KEY, distinctId)
  return true
}

export function captureAttribution(): void {
  if (!isWeb()) return

  const params = new URLSearchParams(window.location.search)
  const captured: Attribution = {
    utmSource: params.get('utm_source') || undefined,
    utmMedium: params.get('utm_medium') || undefined,
    utmCampaign: params.get('utm_campaign') || undefined,
    utmContent: params.get('utm_content') || undefined,
    utmTerm: params.get('utm_term') || undefined,
    referrer: document.referrer || undefined,
    landingPage: window.location.pathname + window.location.search,
    fbclid: params.get('fbclid') || undefined,
    gclid: params.get('gclid') || undefined,
    phDid: readPhDidParam(),
  }

  // The first page a visitor lands on owns the attribution; a later page only
  // fills in what it left empty (a click id on the second hop, say).
  const stored = getStoredAttribution() ?? {}
  safeSetItem(STORAGE_KEY, JSON.stringify(mergeFirstTouch(stored, captured)))

  // The cookie is what the signup POST actually carries: the server reads it
  // from `user.create.after`, where there is no localStorage.
  writeAttributionCookie(captured)
  ensureFbcCookie(captured.fbclid)
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
