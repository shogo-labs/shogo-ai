// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { SIGNUP_INTENT_KEYS } from './signup-intent'

/**
 * Where `/` sends a signed-in user, and with which query string.
 *
 * `apps/mobile/app/index.tsx` is the app's front door: every full page load of
 * `/` enters there and redirects into the `(app)` group. A bare
 * `<Redirect href="/(app)" />` dropped the incoming query string, so a link
 * like `/?chatSessionId=X` — written by the workspace agent chat so a reload,
 * a second tab or Back reopens the chat that is running — arrived at the
 * landing with no `chatSessionId`, and the landing minted a fresh empty chat
 * instead (SHO-300).
 *
 * Only the parameters the landing itself understands are forwarded. `workspace`
 * is deliberately not one of them: on `/agent` and `/(app)` it is the guarded
 * "a link wants to move you" input (SHO-284, `adoptableWorkspaceParam`), and
 * handing that flow a workspace on every `/` load would change which code path
 * decides the active workspace. `file` goes with it for the same reason.
 *
 * The sign-up intent keys (`plan`, `trial`, `prompt`, `utm_*`) ride along in
 * both directions, because an Instagram ad link is followed through `/` by
 * exactly the visitors this front door exists for (SHO-613): the redirect to
 * onboarding has to keep them (`onboardingRedirectHref`), and so does the
 * redirect into the app for an account that already finished onboarding.
 */

/**
 * The query parameters the landing keeps. Anything else is dropped.
 *
 * `SIGNUP_INTENT_KEYS` is spread rather than repeated so the allow-list that
 * captures the intent and the list that forwards it can never drift apart.
 */
const FORWARDED_PARAMS = ['chatSessionId', 'embed', ...SIGNUP_INTENT_KEYS] as const

export type RootQueryParams = Record<
  string,
  string | string[] | undefined | null
>

export interface AppRedirectTarget {
  pathname: '/(app)'
  params: Record<string, string | string[]>
}

export interface OnboardingRedirectTarget {
  pathname: '/(onboarding)'
  params: Record<string, string | string[]>
}

/**
 * The `FORWARDED_PARAMS` that carry a value, as expo-router `params`. Empty
 * values are dropped (an `?a=&b=` link means nothing to the landing, and
 * expo-router would otherwise serialise them into the next URL).
 */
function forwardedParams(params: RootQueryParams | null | undefined): Record<string, string | string[]> {
  const forwarded: Record<string, string | string[]> = {}
  for (const key of FORWARDED_PARAMS) {
    const value = params?.[key]
    if (Array.isArray(value)) {
      const kept = value.filter(
        (entry) => typeof entry === 'string' && entry.length > 0,
      )
      if (kept.length > 0) forwarded[key] = kept
      continue
    }
    if (typeof value === 'string' && value.length > 0) forwarded[key] = value
  }
  return forwarded
}

/**
 * The redirect target for the params `/` was opened with: the plain route when
 * there is nothing to forward, otherwise the route plus the parameters above
 * that carry a value.
 */
export function appRedirectHref(
  params: RootQueryParams | null | undefined,
): '/(app)' | AppRedirectTarget {
  const forwarded = forwardedParams(params)
  if (Object.keys(forwarded).length === 0) return '/(app)'
  return { pathname: '/(app)', params: forwarded }
}

/**
 * The same rule for `/` → onboarding: a visitor who signs up from an ad must
 * still have `plan`/`utm_*` in the URL when onboarding opens, because the
 * onboarding screen (and the cards after this one) read them from there.
 */
export function onboardingRedirectHref(
  params: RootQueryParams | null | undefined,
): '/(onboarding)' | OnboardingRedirectTarget {
  const forwarded = forwardedParams(params)
  if (Object.keys(forwarded).length === 0) return '/(onboarding)'
  return { pathname: '/(onboarding)', params: forwarded }
}
