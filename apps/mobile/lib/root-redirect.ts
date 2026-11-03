// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Where `/` sends a signed-in user, and with which query string.
 *
 * `apps/mobile/app/index.tsx` is the app's front door: every full page load of
 * `/` enters there and redirects into the `(app)` group. A bare
 * `<Redirect href="/(app)" />` dropped the incoming query string, so a link
 * like `/?chatSessionId=X` — written by the workspace agent chat so a reload,
 * a second tab or Back reopens the chat that is running — arrived at the
 * landing with no `chatSessionId`, and the landing minted a fresh empty chat
 * instead (SHO-300). Every parameter has to survive the redirect, not just
 * `chatSessionId`: `embed=ide`, `workspace=` and whatever else a link carries
 * mean the same thing after it.
 */

export type RootQueryParams = Record<
  string,
  string | string[] | undefined | null
>

export interface AppRedirectTarget {
  pathname: '/(app)'
  params: Record<string, string | string[]>
}

/**
 * The redirect target for the params `/` was opened with: the plain route when
 * there is nothing to forward, otherwise the route plus the params that carry
 * a value. Empty values are dropped (an `?a=&b=` link means nothing to the
 * landing, and expo-router would otherwise serialise them into the next URL).
 */
export function appRedirectHref(
  params: RootQueryParams | null | undefined,
): '/(app)' | AppRedirectTarget {
  const forwarded: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    if (Array.isArray(value)) {
      const kept = value.filter(
        (entry) => typeof entry === 'string' && entry.length > 0,
      )
      if (kept.length > 0) forwarded[key] = kept
      continue
    }
    if (typeof value === 'string' && value.length > 0) forwarded[key] = value
  }
  if (Object.keys(forwarded).length === 0) return '/(app)'
  return { pathname: '/(app)', params: forwarded }
}
