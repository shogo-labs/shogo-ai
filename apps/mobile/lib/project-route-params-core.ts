// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure merge/guard logic for cold-load project route parameter recovery
 * (SHO-174). Extracted into a no-React, no-expo-router module so Bun unit
 * tests can import it without triggering native module resolution.
 *
 * The companion hook `useProjectRouteParams` (in use-project-route-params.ts)
 * wires this to expo-router's `useLocalSearchParams` / `useGlobalSearchParams`
 * and to the arrival URL captured in `arrival-url.ts`.
 */

/**
 * Arrival keys that are never treated as route params to restore.
 *
 * `workspace` is the guarded "a link wants to move you" input (SHO-284,
 * `adoptableWorkspaceParam`); `embed` is read straight from `location.search`
 * by the IDE embed checks. Neither is a parameter of the project route.
 */
export const NOT_RESTORED_PARAMS: ReadonlySet<string> = new Set(['workspace', 'embed'])

export interface ProjectRouteParamsInput<T extends Record<string, unknown>> {
  local: T
  global: T
  pathname: string
  projectId: string | undefined
  /**
   * Query parameters of the document's arrival URL, when that URL was this
   * project's route. Pass null on native or when unavailable.
   */
  arrivalParams?: Record<string, string> | null
  /**
   * The params the router supplied on this mount's first render. A key whose
   * value is still this is one the app has not acted on since the page loaded,
   * so the arrival URL may still speak for it. Defaults to the current params.
   */
  baseline?: T
  /**
   * Arrival values the screen has since proven wrong, keyed by param.
   *
   * The arrival URL is a claim, not a fact: `?chatSessionId=` can name a
   * deleted, foreign or otherwise unopenable chat (SHO-169 AC8). Once the
   * server says so, that value must stop speaking — at the router state too,
   * because the same query also reached the router and would otherwise be
   * re-applied on the next render and pin the screen to a dead id forever.
   * Only the exact rejected value is dropped; a later real id still applies.
   */
  rejected?: Readonly<Record<string, string>>
}

/** Params the router itself supplied, i.e. what the URL would serialise to. */
function routerParams<T extends Record<string, unknown>>(
  local: T,
  leaf: T,
  pathname: string,
  projectId: string | undefined,
): T {
  // Only trust the focused leaf while the focused path is this project: a
  // screen pushed on top of the layout must not bleed its params in here.
  const onThisProject = !!projectId && pathname.includes(`/projects/${projectId}`)
  return (onThisProject ? { ...leaf, ...local } : { ...local }) as T
}

/**
 * Does the router's value for `key` still stand for the viewer's arrival
 * request, rather than something this page decided afterwards?
 *
 * - nothing supplied: the router dropped it on the way in (the query collapse)
 *   — the arrival URL is the only record, so it speaks;
 * - supplied and unchanged since the first render: still the value the app had
 *   before it acted, so it is not the viewer's doing — the arrival URL speaks.
 *   This is the `chatSessionId` case: by first render the chat mirror has
 *   already named the project's pinned chat, and a "fill only what is missing"
 *   rule loses to it;
 * - supplied and changed since the first render: this screen wrote it (a tab
 *   click, a chat switch, the chat mirror) — the screen wins, and stays won.
 */
function arrivalSpeaks(
  key: string,
  supplied: Record<string, unknown>,
  baseline: Record<string, unknown>,
): boolean {
  if (supplied[key] === undefined) return true
  return supplied[key] === baseline[key]
}

/**
 * The params that hold for both cold loads and in-app pushes: the router's own
 * params, with the arrival URL speaking for every key the router is not
 * authoritatively carrying (see `arrivalSpeaks`).
 *
 * While the arrival query is unclaimed it corrects the router's params; once
 * claimed, `arrivalParams` is null again and this is a plain local-over-leaf
 * merge, so in-app pushes behave exactly as before.
 */
export function mergeProjectRouteParams<T extends Record<string, unknown>>(
  input: ProjectRouteParamsInput<T>,
): T {
  const { local, global: leaf, pathname, projectId, arrivalParams } = input

  const merged = routerParams(local, leaf, pathname, projectId) as Record<string, unknown>
  const baseline = (input.baseline ?? merged) as Record<string, unknown>

  // A value the screen has disproved is dropped from the router's own params as
  // well as from the arrival ones: the router parsed the same query, so leaving
  // it would re-apply the dead id on every render.
  for (const [key, value] of Object.entries(input.rejected ?? {})) {
    if (merged[key] === value) delete merged[key]
  }

  if (!arrivalParams) return merged as T

  for (const [key, value] of Object.entries(arrivalParams)) {
    if (NOT_RESTORED_PARAMS.has(key)) continue
    if (input.rejected?.[key] === value) continue
    if (!arrivalSpeaks(key, merged, baseline)) continue
    merged[key] = value
  }
  return merged as T
}
