// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure merge/guard logic for cold-load project route parameter recovery
 * (SHO-174). Extracted into a no-React, no-expo-router module so Bun unit
 * tests can import it without triggering native module resolution.
 *
 * The companion hook `useProjectRouteParams` (in use-project-route-params.ts)
 * wires this to expo-router's `useLocalSearchParams` / `useGlobalSearchParams`.
 */

/**
 * Merges global (leaf) params with local (layout segment) params, guarded by
 * pathname so that a screen pushed on top of the project layout cannot bleed
 * its params into the mounted layout.
 *
 * @param local       Params from `useLocalSearchParams` (the layout's own segment).
 * @param global      Params from `useGlobalSearchParams` (the focused leaf).
 * @param pathname    `usePathname()` — the current focused path.
 * @param projectId   The `[id]` segment value from the layout route.
 * @param arrivalHref `window.location.href` captured once at mount (web only).
 *
 * ### Why `arrivalHref` is needed
 *
 * expo-router's `store.routeInfo` starts as `defaultRouteInfo` (params: {},
 * pathname: '/') and is only updated after the focused **leaf** route's
 * `BaseRoute` renders and calls `store.setFocusedState()`.  The project layout
 * renders BEFORE its leaf child, so on the very first render:
 *   - `useGlobalSearchParams()` returns `{}` (store not yet ready)
 *   - `usePathname()` returns `'/'`
 *
 * Both `useState` initializers and the tab-intent effect would therefore see
 * empty params, causing chatSessionId / tab / file captures to be null/undefined
 * before the leaf finally populates the store.
 *
 * `window.location.href` is set synchronously by the browser and is always
 * correct at mount time — it is the ground truth regardless of React rendering
 * order. When `global` is empty we fall back to parsing it, then on subsequent
 * renders (after the leaf renders and store.routeInfo is set) the normal path
 * takes over.
 */
export function mergeProjectRouteParams<T extends Record<string, unknown>>(input: {
  local: T
  global: T
  pathname: string
  projectId: string | undefined
  /**
   * `window.location.href` captured once at hook mount (web only).
   * Pass an empty string on native or when unavailable.
   */
  arrivalHref?: string
}): T {
  const { local, global: leaf, pathname, projectId, arrivalHref } = input
  if (!projectId) return local

  // On the first render, before the leaf's BaseRoute calls setFocusedState(),
  // useGlobalSearchParams() returns {} and usePathname() returns '/'.
  // Detect this by checking whether global has ANY keys: an initialised store
  // always has at least `id` on the focused route for a project path.
  const isStoreNotReady = Object.keys(leaf as object).length === 0
  if (isStoreNotReady) {
    if (!arrivalHref) return local
    let url: URL | null = null
    try { url = new URL(arrivalHref) } catch { return local }
    // Only use the arrival URL when we are actually on this project's path.
    if (!url.pathname.includes(`/projects/${projectId}`)) return local
    // All query params from the URL, with local segment params winning.
    const urlParams = Object.fromEntries(url.searchParams) as T
    return { ...urlParams, ...local }
  }

  // Normal path: guard against a screen pushed on top of this layout.
  if (!pathname.includes(`/projects/${projectId}`)) return local
  // Local params win: an in-app router.push sets params on the layout segment
  // itself, so local will carry the values and they should not be overridden.
  // For cold loads, local only has { id } and leaf carries everything else.
  return { ...leaf, ...local }
}
