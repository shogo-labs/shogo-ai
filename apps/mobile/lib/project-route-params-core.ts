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
 * Merges global (leaf) params with local (layout segment) params, guarded by
 * pathname so that a screen pushed on top of the project layout cannot bleed
 * its params into the mounted layout, then restores any query key the arrival
 * URL carried that the router no longer supplies.
 *
 * @param local       Params from `useLocalSearchParams` (the layout's own segment).
 * @param global      Params from `useGlobalSearchParams` (the focused leaf).
 * @param pathname    `usePathname()` — the current focused path.
 * @param projectId   The `[id]` segment value from the layout route.
 * @param arrivalParams Query parameters of the URL this document was loaded
 *                      with (already scoped to this project), or null.
 *
 * ### Why `arrivalParams` is needed
 *
 * expo-router's linking layer writes its navigation state into the address bar
 * while it mounts, and on a cold load it does that twice: the arrival URL is
 * written correctly, then the navigator settles on its initial route and the
 * path collapses to that route with the whole query dropped — before the
 * project screen renders (SHO-174). The state that survives keeps the path
 * segment params (`id`, leaked onto the sibling index route by
 * `populateParams`) but not the query, so by the time this layout mounts:
 *
 *   - `useGlobalSearchParams()` returns `{ id }` — not empty, so an
 *     "is the store ready" check cannot detect the loss
 *   - `usePathname()` returns the project path, likewise intact
 *   - `tab`, `chatSessionId` and `file` are simply gone
 *
 * The arrival URL is therefore the only remaining record of what the viewer
 * asked for. Each missing key is filled from it individually: a single lost
 * key is restored even though its siblings survived, which is what a
 * ready-store check keyed on the whole param object cannot express. A key the
 * router does supply always wins, so in-app navigations are unaffected.
 */
export function mergeProjectRouteParams<T extends Record<string, unknown>>(input: {
  local: T
  global: T
  pathname: string
  projectId: string | undefined
  /**
   * Query parameters of the document's arrival URL, when that URL was this
   * project's route. Pass null on native or when unavailable.
   */
  arrivalParams?: Record<string, string> | null
}): T {
  const { local, global: leaf, pathname, projectId, arrivalParams } = input
  if (!projectId) return local

  // Only trust the focused leaf while the focused path is this project: a
  // screen pushed on top of the layout must not bleed its params in here.
  const onThisProject = pathname.includes(`/projects/${projectId}`)
  const merged: Record<string, unknown> = onThisProject
    ? { ...leaf, ...local }
    : { ...local }

  if (!arrivalParams) return merged as T

  // Fill individual gaps. `id` is a path segment and always present, so it can
  // never be restored here; the query keys are the ones that go missing.
  for (const [key, value] of Object.entries(arrivalParams)) {
    if (merged[key] === undefined) merged[key] = value
  }
  return merged as T
}
