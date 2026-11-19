// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cometly pixel for the app (SHO-441).
 *
 * The marketing site (shogo.ai) already runs the pixel and reports
 * `custom_event_1`. This is the app's half, on studio.shogo.ai:
 *
 *  - the pixel loads on the web auth pages only (`app/(auth)/_layout.tsx`) —
 *    never on native, and never on an app route, except the one post-signup
 *    page that reports `custom_event_2`;
 *  - a Google sign-up carries `window.cometToken()` to the server in a
 *    first-party cookie, so the server's Create Event can be tied to the click
 *    (`apps/api/src/lib/cometly.ts`).
 *
 * Every function here is web-only and safe to call on iOS/Android: they return
 * without touching `window` or `document`.
 */
import { Platform } from 'react-native'

declare global {
  interface Window {
    comet?: (eventName: string) => void
    cometToken?: () => string | null | undefined
  }
}

/** The Cometly site tag, as issued for shogo.ai + studio.shogo.ai. */
export const COMETLY_SCRIPT_SRC =
  'https://js.comet-serve.com/script.js?uid=4fb936-6755399446000006-d1965d8&domains=shogo.ai,studio.shogo.ai'

/** Marks the tag we injected, so a remount never adds a second one. */
const SCRIPT_ATTR = 'data-cometly'

/**
 * Where the Google sign-in page parks the click's token so it rides along on
 * the OAuth callback — the request the server's signup hook runs on.
 */
export const COMET_TOKEN_COOKIE = '__shogo_comet_token'
const COMET_TOKEN_MAX_AGE_SECONDS = 30 * 60

/** "a new sign-up happened here, report it on the next authenticated page". */
export const NEW_SIGNUP_FLAG_KEY = 'shogo_cometly_new_signup'
const NEW_SIGNUP_FLAG_MAX_AGE_MS = 24 * 60 * 60 * 1000
/**
 * When `custom_event_2` was last reported for this browser. Only has to outlive
 * the 60 s window in which two authenticated layouts can both see the same new
 * account, so it stays short enough that a genuinely separate sign-up in the
 * same browser still reports.
 */
export const NEW_SIGNUP_REPORTED_KEY = 'shogo_cometly_reported_new_signup'
const SIGNUP_REPORT_DEDUPE_MS = 2 * 60 * 1000
const CUSTOM_EVENT_DELAY_MS = 1_000
/**
 * The site tag is ~225 KB, so on a cold cache it can still be downloading when
 * the 1 s delay is up and `window.comet` would not exist yet. Retry a bounded
 * number of times instead of dropping the conversion on the floor.
 */
const CUSTOM_EVENT_RETRY_MS = 500
const CUSTOM_EVENT_MAX_ATTEMPTS = 10

function isWeb(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined'
}

function cookieAttributes(maxAgeSeconds: number): string {
  const secure =
    typeof window !== 'undefined' && window.location?.protocol === 'https:' ? '; Secure' : ''
  return `; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`
}

/**
 * Inject the site tag once per page. Returns whether this call added it;
 * a second call (a remount, a second page in the same tab) is a no-op.
 */
export function loadCometlyPixel(): boolean {
  if (!isWeb()) return false
  if (document.querySelector(`script[${SCRIPT_ATTR}]`)) return false
  const script = document.createElement('script')
  script.src = COMETLY_SCRIPT_SRC
  script.async = true
  script.setAttribute(SCRIPT_ATTR, '')
  document.head.appendChild(script)
  return true
}

/**
 * The pixel's per-click token, if the tag has loaded and minted one yet. A
 * blocked or still-loading tag (and every native platform) yields null.
 */
export function readCometToken(): string | null {
  if (!isWeb()) return null
  try {
    const token = window.cometToken?.()
    return typeof token === 'string' && token.trim() ? token.trim() : null
  } catch {
    return null
  }
}

/** Park the token for the OAuth round trip. */
export function storeCometToken(token: string): void {
  if (!isWeb() || !token) return
  document.cookie = `${COMET_TOKEN_COOKIE}=${encodeURIComponent(token)}${cookieAttributes(
    COMET_TOKEN_MAX_AGE_SECONDS,
  )}`
}

/** Drop it once the app is authenticated — it has done its job by then. */
export function clearCometTokenCookie(): void {
  if (!isWeb()) return
  if (!document.cookie.includes(`${COMET_TOKEN_COOKIE}=`)) return
  document.cookie = `${COMET_TOKEN_COOKIE}=${cookieAttributes(0)}`
}

/**
 * Remember that this browser just created an account. localStorage, not
 * sessionStorage, because verifying the email can land in another tab.
 *
 * No-ops while a report is still fresh (see `consumeNewSignupEvent`): a Google
 * sign-up can mount two authenticated layouts in a row — the onboarding gate,
 * then `(app)` once it finishes — and `oauth_pending` is still in sessionStorage
 * for the second one, so without this guard a sign-up completed inside the
 * 60 s new-account window would report `custom_event_2` twice.
 */
export function markNewSignup(now: number = Date.now()): boolean {
  if (!isWeb()) return false
  try {
    if (hasRecentSignupReport(now)) return false
    window.localStorage.setItem(NEW_SIGNUP_FLAG_KEY, String(now))
    return true
  } catch {
    return false
  }
}

/** Whether `custom_event_2` was reported for this browser moments ago. */
export function hasRecentSignupReport(now: number = Date.now()): boolean {
  if (!isWeb()) return false
  try {
    const reportedAt = Number(window.localStorage.getItem(NEW_SIGNUP_REPORTED_KEY))
    return Number.isFinite(reportedAt) && reportedAt > 0 && now - reportedAt < SIGNUP_REPORT_DEDUPE_MS
  } catch {
    return false
  }
}

/**
 * Fire `custom_event_2` as soon as the tag is actually on the page. The first
 * attempt is the 1 s delay; if `window.comet` is still missing (cold cache,
 * blocked request) it retries every `retryMs` for a few seconds and then gives
 * up silently rather than throwing into a React effect.
 */
function fireCustomEvent(attempt: number, retryMs: number): void {
  if (!isWeb()) return
  if (typeof window.comet === 'function') {
    try {
      window.comet('custom_event_2')
    } catch {}
    return
  }
  if (retryMs <= 0 || attempt + 1 >= CUSTOM_EVENT_MAX_ATTEMPTS) return
  setTimeout(() => fireCustomEvent(attempt + 1, retryMs), retryMs)
}

/**
 * Report `custom_event_2` on the first authenticated page of a new sign-up,
 * then forget the flag. A flag older than a day is dropped silently, and a
 * normal login never sets one, so this cannot fire on a login or twice.
 */
export function consumeNewSignupEvent(
  now: number = Date.now(),
  delayMs: number = CUSTOM_EVENT_DELAY_MS,
  retryMs: number = CUSTOM_EVENT_RETRY_MS,
): boolean {
  if (!isWeb()) return false
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(NEW_SIGNUP_FLAG_KEY)
  } catch {
    return false
  }
  if (!raw) return false
  try {
    window.localStorage.removeItem(NEW_SIGNUP_FLAG_KEY)
  } catch {}

  const markedAt = Number(raw)
  if (!Number.isFinite(markedAt) || now - markedAt > NEW_SIGNUP_FLAG_MAX_AGE_MS) return false

  // Stamp the report before firing so the next authenticated layout (or a
  // remount of this one) cannot mark and report the same sign-up again.
  try {
    window.localStorage.setItem(NEW_SIGNUP_REPORTED_KEY, String(now))
  } catch {}

  // `window.comet` only exists once the tag has loaded, and the tag is not on
  // the app routes — so load it here, on the one post-signup page.
  loadCometlyPixel()
  setTimeout(() => fireCustomEvent(0, retryMs), delayMs)
  return true
}
