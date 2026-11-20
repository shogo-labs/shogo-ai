// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fixes a cold-load parameter loss bug (SHO-174).
 *
 * On a cold load expo-router's `getStateFromPath` puts query params on the
 * *focused leaf route* (`projects/[id]/index`), not on the ancestor layout
 * (`projects/[id]/_layout.tsx`).  `useLocalSearchParams` only returns the
 * current segment's own params, so after a cold load the layout sees only
 * `{ id }` and all of `tab`, `chatSessionId`, `file`, etc. are undefined.
 *
 * Fix: merge `useGlobalSearchParams` (which sees every route's params,
 * including the leaf's) with `useLocalSearchParams` (which wins for in-app
 * `router.push` calls where the params land on the layout segment itself).
 * The global params are only used when the current pathname is the project
 * route — a screen pushed *on top* of the layout must not bleed its params
 * into the mounted layout.
 *
 * The pure merge/guard function lives in `project-route-params-core.ts` so
 * unit tests can import it without resolving expo-router native modules.
 */
import { useState } from 'react'
import { Platform } from 'react-native'
import { useLocalSearchParams, useGlobalSearchParams, usePathname } from 'expo-router'
export { mergeProjectRouteParams } from './project-route-params-core'
import { mergeProjectRouteParams } from './project-route-params-core'

/**
 * Drop-in replacement for `useLocalSearchParams` in `_layout.tsx`.
 *
 * Returns the merged params that work correctly for both cold loads (params
 * arrive on the leaf via `getStateFromPath`) and in-app pushes (params land
 * on the layout segment and are authoritative).
 *
 * On the very first render, expo-router's `store.routeInfo` is not yet
 * populated (see `mergeProjectRouteParams` JSDoc for the full explanation).
 * We capture `window.location.href` once via a lazy `useState` initializer —
 * this runs synchronously at mount, before any React effects, and before the
 * expo-router store is ready, so it is always the correct arrival URL.
 */
export function useProjectRouteParams<
  T extends Record<string, string | string[]>,
>(): T {
  const local = useLocalSearchParams<T>()
  const global = useGlobalSearchParams<T>()
  const pathname = usePathname()
  const projectId =
    typeof local.id === 'string'
      ? local.id
      : Array.isArray(local.id)
        ? local.id[0]
        : undefined
  // Captured once at mount: the lazy initializer runs synchronously on the
  // first render, before store.routeInfo is populated, giving the hook the
  // arrival URL as a fallback when useGlobalSearchParams() returns {}.
  const [arrivalHref] = useState(() =>
    Platform.OS === 'web' && typeof window !== 'undefined'
      ? window.location.href
      : ''
  )
  return mergeProjectRouteParams({ local, global, pathname, projectId, arrivalHref })
}
