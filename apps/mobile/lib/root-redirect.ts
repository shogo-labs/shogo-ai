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
 * instead (SHO-300).
 *
 * Only the parameters the landing itself understands are forwarded. `workspace`
 * is deliberately not one of them: on `/agent` and `/(app)` it is the guarded
 * "a link wants to move you" input (SHO-284, `adoptableWorkspaceParam`), and
 * handing that flow a workspace on every `/` load would change which code path
 * decides the active workspace. `file` goes with it for the same reason.
 */

/** The query parameters the landing keeps. Anything else is dropped. */
const FORWARDED_PARAMS = ['chatSessionId', 'embed'] as const

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
 * there is nothing to forward, otherwise the route plus the parameters above
 * that carry a value. Empty values are dropped (an `?a=&b=` link means nothing
 * to the landing, and expo-router would otherwise serialise them into the next
 * URL).
 */
export function appRedirectHref(
  params: RootQueryParams | null | undefined,
): '/(app)' | AppRedirectTarget {
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
  if (Object.keys(forwarded).length === 0) return '/(app)'
  return { pathname: '/(app)', params: forwarded }
}
