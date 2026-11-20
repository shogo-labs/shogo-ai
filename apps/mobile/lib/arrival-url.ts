// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The URL this document was loaded with, and the one-shot claim on its query.
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
 * ### Why the query is *claimed* rather than simply read
 *
 * The arrival query describes one navigation: the page load. It must not
 * outlive it. The project layout remounts every time the viewer leaves that
 * project and comes back, and in-app those visits carry their own params in
 * the router state — so replaying the arrival query on them applies intent
 * that has already been spent: `initialMessage` would be sent again,
 * `newChat=1` would mint a second chat, and `tab`/`chatSessionId` would snap
 * back to the original link (SHO-174).
 *
 * `peek…` is what render may call (a pure read, so a render-phase probe or a
 * double-invoked component is harmless). `claim…` is what the one effect that
 * acts on the query calls, and it succeeds for exactly one caller per page
 * load — which also makes it StrictMode-safe: the second mount of a
 * double-rendered tree peeks nothing and writes nothing, while the first
 * mount's write already landed in the router state.
 *
 * Empty on native, where there is no address bar to lose.
 */
/**
 * The href a document was loaded with, given the ambient value.
 *
 * Extracted so the native/empty case is exercised by a unit test instead of by
 * whatever globals the test runner happens to expose — the mobile suite runs
 * with a `window`, so `typeof window === 'undefined'` is never true there.
 */
export function captureArrivalHref(value: string | null | undefined): string {
  return typeof value === 'string' ? value : ''
}

const ARRIVAL_HREF = captureArrivalHref(
  typeof window !== 'undefined' ? window.location?.href : undefined,
)

/**
 * Whether this page load has already used its arrival query. Passed
 * explicitly by tests so they do not share the module's state.
 */
export interface ArrivalClaim {
  claimed: boolean
}

/** The claim for this page load. */
export const PAGE_LOAD_ARRIVAL_CLAIM: ArrivalClaim = { claimed: false }

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

/**
 * The arrival query for this project while it is still unclaimed, else `null`.
 * Safe to call during render: it only reads the claim.
 */
export function peekArrivalQueryParamsForProject(
  projectId: string | undefined,
  claim: ArrivalClaim = PAGE_LOAD_ARRIVAL_CLAIM,
): Record<string, string> | null {
  if (claim.claimed) return null
  return arrivalQueryParamsForProject(projectId)
}

/**
 * Take this page load's arrival query. Returns `true` for exactly one caller,
 * which is the one allowed to apply it; every later caller (a remount, a
 * second visit to the project) gets `false`.
 */
export function claimArrivalQueryParams(
  claim: ArrivalClaim = PAGE_LOAD_ARRIVAL_CLAIM,
): boolean {
  if (claim.claimed) return false
  claim.claimed = true
  return true
}
