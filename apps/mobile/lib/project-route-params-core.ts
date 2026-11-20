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
 * @param local     Params from `useLocalSearchParams` (the layout's own segment).
 * @param global    Params from `useGlobalSearchParams` (the focused leaf).
 * @param pathname  `usePathname()` — the current focused path.
 * @param projectId The `[id]` segment value from the layout route.
 */
export function mergeProjectRouteParams<T extends Record<string, unknown>>(input: {
  local: T
  global: T
  pathname: string
  projectId: string | undefined
}): T {
  const { local, global: leaf, pathname, projectId } = input
  if (!projectId) return local
  // The leaf params are only valid when we are inside this project's route tree.
  // A screen pushed on top (e.g. a modal) would have a different pathname.
  if (!pathname.includes(`/projects/${projectId}`)) return local
  // Local params win: an in-app router.push sets params on the layout segment
  // itself, so local will carry the values and they should not be overridden.
  // For cold loads, local only has { id } and leaf carries everything else.
  return { ...leaf, ...local }
}
