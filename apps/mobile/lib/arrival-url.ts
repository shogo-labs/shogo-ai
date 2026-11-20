// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The URL this document was loaded with.
 *
 * Expo Router serialises its navigation state into the address bar as it
 * mounts, and a cold load of `/projects/<id>?tab=…` is written more than once:
 * the arrival URL appears correctly, then the navigator settles on its initial
 * route and the path collapses to that route with the entire query dropped
 * (`/projects/<id>?tab=settings` → `/?id=<project>` → `/projects/<id>`), before
 * the project screen ever renders (SHO-174).
 *
 * So `window.location.href` stops describing what the viewer asked for as soon
 * as the router mounts, and reading it from a component is already too late.
 * Module scope is still correct: every route module is evaluated while the
 * router builds its tree, which is before the first render and therefore
 * before the first `history.replaceState`. This file records that value once.
 *
 * Empty on native, where there is no address bar to lose.
 */
const ARRIVAL_HREF =
  typeof window !== 'undefined' && typeof window.location?.href === 'string'
    ? window.location.href
    : ''

/** The href this document was loaded with (empty on native). */
export function arrivalHref(): string {
  return ARRIVAL_HREF
}

/**
 * Query parameters this document was loaded with, or `null` when there are
 * none to read (native, or an href that will not parse).
 */
export function arrivalQueryParams(): Record<string, string> | null {
  if (!ARRIVAL_HREF) return null
  try {
    const url = new URL(ARRIVAL_HREF)
    const params: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      params[key] = value
    })
    return Object.keys(params).length > 0 ? params : null
  } catch {
    return null
  }
}

/**
 * Query parameters from the arrival URL, but only when that URL was this
 * project's route. A document loaded somewhere else must not leak its query
 * into a project the viewer opened in-app afterwards.
 */
export function arrivalQueryParamsForProject(
  projectId: string | undefined,
  href: string = ARRIVAL_HREF,
): Record<string, string> | null {
  if (!projectId || !href) return null
  try {
    const url = new URL(href)
    if (!url.pathname.includes(`/projects/${projectId}`)) return null
    const params: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      params[key] = value
    })
    return Object.keys(params).length > 0 ? params : null
  } catch {
    return null
  }
}
