// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Catching what the marketing site sent the visitor here to build (SHO-614).
 *
 * `studio.shogo.ai/sign-up?prompt=…&intent=hero_prompt` (and the pricing
 * links `?plan=basic&trial=1`) carry the intent in the URL. Two things lose
 * it if nobody is careful:
 *
 *  1. `app/(auth)/sign-up.tsx` redirects to `/sign-in`, and a redirect that
 *     rebuilds the href drops the query string.
 *  2. Verifying the email can happen in another browser, where there is no
 *     localStorage at all.
 *
 * So the capture happens synchronously on the root layout's first render,
 * writes localStorage (same browser, and the freshest copy) **and** a
 * first-party `__shogo_intent` cookie that rides on the sign-up request. The
 * server stores that on the user row (`User.signupIntent`), which is what
 * survives a different device.
 *
 * The `template` half is folded in here too: `pending_template_id` is still
 * written, so every existing template deep link keeps working unchanged.
 */
import { Platform } from 'react-native'
import {
  normalizeSignupIntent,
  parseSignupIntent,
  serializeSignupIntent,
  type SignupIntent,
} from '@shogo/shared-app/signup-intent'
import { safeGetItem, safeRemoveItem, safeSetItem } from './safe-storage'

export type { SignupIntent } from '@shogo/shared-app/signup-intent'

export const SIGNUP_INTENT_STORAGE_KEY = 'shogo_signup_intent'
export const SIGNUP_INTENT_COOKIE = '__shogo_intent'
/** Same lifetime as the cookie, so both copies stop being trusted together. */
export const SIGNUP_INTENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const COOKIE_MAX_AGE_SECONDS = SIGNUP_INTENT_MAX_AGE_MS / 1000
/** Storage slots the app already reads; folded into the capture below. */
export const PENDING_TEMPLATE_KEY = 'pending_template_id'
export const PENDING_APP_TEMPLATE_KEY = 'pending_app_template'

/** Params the capture consumes, so a refresh can't capture the same link twice. */
const CONSUMED_PARAMS = ['prompt', 'plan', 'trial', 'intent', 'template', 'app_template']

function isWeb(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined'
}

function cookieAttributes(maxAgeSeconds: number): string {
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : ''
  return `; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`
}

function writeIntentCookie(intent: SignupIntent): void {
  if (!isWeb()) return
  try {
    document.cookie = `${SIGNUP_INTENT_COOKIE}=${serializeSignupIntent(intent)}${cookieAttributes(COOKIE_MAX_AGE_SECONDS)}`
  } catch {
    // A blocked cookie jar only costs cross-device support, never sign-up.
  }
}

function clearIntentCookie(): void {
  if (!isWeb()) return
  try {
    document.cookie = `${SIGNUP_INTENT_COOKIE}=${cookieAttributes(0)}`
  } catch {}
}

/**
 * Read the sign-up intent out of the URL, store it for this browser and for
 * the server, and strip the consumed params from the address bar.
 *
 * Synchronous and idempotent: the root layout calls it during its first
 * render, before the `/sign-up` → `/sign-in` redirect can drop the query.
 */
export function captureSignupIntent(): SignupIntent | null {
  if (!isWeb()) return null

  let params: URLSearchParams
  try {
    params = new URLSearchParams(window.location.search)
  } catch {
    return null
  }

  // `template` / `app_template` predate this module: keep writing the slots
  // the home screen and the old links already read.
  const template = params.get('template')
  if (template) safeSetItem(PENDING_TEMPLATE_KEY, template)
  const appTemplate = params.get('app_template')
  if (appTemplate) safeSetItem(PENDING_APP_TEMPLATE_KEY, appTemplate)

  const intent = parseSignupIntent((name) => params.get(name))

  let changed = false
  for (const name of CONSUMED_PARAMS) {
    if (!params.has(name)) continue
    params.delete(name)
    changed = true
  }
  if (changed) {
    try {
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    } catch {}
  }

  if (!intent) return null
  const record: SignupIntent = { ...intent, capturedAt: Date.now() }
  try {
    safeSetItem(SIGNUP_INTENT_STORAGE_KEY, JSON.stringify(record))
  } catch {}
  writeIntentCookie(intent)
  return intent
}

/**
 * The intent this browser captured, if it is still fresh. Used as the first
 * source in onboarding (same browser, no round trip); the server copy covers
 * the device-switch case.
 */
export function getSignupIntent(now: number = Date.now()): SignupIntent | null {
  if (!isWeb()) return null
  const raw = safeGetItem(SIGNUP_INTENT_STORAGE_KEY)
  if (!raw) return null
  const intent = (() => {
    try {
      return normalizeSignupIntent(JSON.parse(raw))
    } catch {
      return null
    }
  })()
  if (!intent) {
    safeRemoveItem(SIGNUP_INTENT_STORAGE_KEY)
    return null
  }
  if (!intent.capturedAt || now - intent.capturedAt > SIGNUP_INTENT_MAX_AGE_MS) {
    safeRemoveItem(SIGNUP_INTENT_STORAGE_KEY)
    return null
  }
  return intent
}

/** Forget it once the first build has started, or once onboarding is done. */
export function clearSignupIntent(): void {
  if (!isWeb()) return
  safeRemoveItem(SIGNUP_INTENT_STORAGE_KEY)
  clearIntentCookie()
}
