// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Server half of the sign-up intent (SHO-614).
 *
 * The app writes what the marketing link asked for into the first-party
 * `__shogo_intent` cookie. That cookie rides the sign-up POST (and the Google
 * callback), so `user.create.after` reads it here and stores the validated
 * JSON on `User.signupIntent`. Validation is the client's own module
 * (`@shogo/shared-app/signup-intent`), so a crafted cookie can't produce a
 * shape onboarding would not have produced itself.
 */
import {
  deserializeSignupIntent,
  type SignupIntent,
} from '../../../../packages/shared-app/src/signup-intent'
import { parseCookieHeader } from './signup-attribution'

export const SIGNUP_INTENT_COOKIE = '__shogo_intent'

/** The intent in a sign-up request's cookies, or null when there is none. */
export function parseSignupIntentCookie(
  cookieHeader: string | null | undefined,
): SignupIntent | null {
  if (!cookieHeader) return null
  const raw = parseCookieHeader(cookieHeader, SIGNUP_INTENT_COOKIE)
  if (!raw) return null
  return deserializeSignupIntent(raw)
}

/** What `User.signupIntent` holds, for `GET /api/onboarding/intent`. */
export function parseStoredSignupIntent(raw: string | null | undefined): SignupIntent | null {
  return deserializeSignupIntent(raw)
}
