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
const CUSTOM_EVENT_DELAY_MS = 1_000

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
 */
export function markNewSignup(now: number = Date.now()): void {
  if (!isWeb()) return
  try {
    window.localStorage.setItem(NEW_SIGNUP_FLAG_KEY, String(now))
  } catch {}
}

/**
 * Report `custom_event_2` on the first authenticated page of a new sign-up,
 * then forget the flag. A flag older than a day is dropped silently, and a
 * normal login never sets one, so this cannot fire on a login or twice.
 */
export function consumeNewSignupEvent(
  now: number = Date.now(),
  delayMs: number = CUSTOM_EVENT_DELAY_MS,
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

  // `window.comet` only exists once the tag has loaded, and the tag is not on
  // the app routes — so load it here, on the one post-signup page.
  loadCometlyPixel()
  setTimeout(() => {
    try {
      window.comet?.('custom_event_2')
    } catch {}
  }, delayMs)
  return true
}
