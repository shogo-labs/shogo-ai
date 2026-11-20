// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fixes a cold-load parameter loss bug (SHO-174).
 *
 * On a cold load of `/projects/<id>?tab=settings` expo-router's linking layer
 * writes its navigation state into the address bar more than once. The arrival
 * URL is written correctly, then the navigator settles on its initial route and
 * the path collapses to that route with the whole query dropped — before this
 * layout ever renders. What survives is the path segment (`id`), so the layout
 * sees `{ id }` and `tab`, `chatSessionId` and `file` are simply undefined.
 *
 * The arrival URL recorded in `arrival-url.ts` is the only record of what the
 * viewer asked for, so each key the router lost is restored from it. Keys the
 * router does supply always win, and the leaf params are only read while the
 * focused path is this project, so a screen pushed *on top* of the layout
 * cannot bleed its params in here.
 *
 * That restore belongs to the page load, not to the mount. This layout
 * remounts whenever the viewer leaves the project and comes back, and those
 * in-app visits carry their own params — replaying the arrival query on them
 * would re-send `initialMessage`, mint a second chat for `newChat=1`, and snap
 * `tab`/`chatSessionId` back to the original link. So the query is peeked
 * while unclaimed (any number of renders, StrictMode included) and claimed by
 * exactly one effect per page load.
 *
 * Restoring the value for rendering is not enough on its own: the URL is
 * serialised from the router's own state, so a key that only exists in the
 * merged object would be dropped again on the next write. The claiming effect
 * therefore also puts those keys into the router state, which is what keeps
 * `?tab=` in the address bar.
 *
 * The pure merge/guard function lives in `project-route-params-core.ts` so
 * unit tests can import it without resolving expo-router native modules.
 */
import { useEffect, useRef } from 'react'
import { useLocalSearchParams, useGlobalSearchParams, usePathname, useRouter } from 'expo-router'
import { claimArrivalQueryParams, peekArrivalQueryParamsForProject } from './arrival-url'
export { mergeProjectRouteParams } from './project-route-params-core'
import { mergeProjectRouteParams } from './project-route-params-core'

/**
 * Arrival keys deliberately not pushed into the router state.
 *
 * `workspace` is the guarded "a link wants to move you" input (SHO-284,
 * `adoptableWorkspaceParam`); re-asserting it would hand that flow a workspace
 * on every cold load. `embed` is read straight from `location.search` by the
 * IDE embed checks. Neither is a parameter of the project route being restored.
 */
const NOT_RESTORED = new Set(['workspace', 'embed'])

/**
 * Keys of `merged` that only the arrival URL supplied, i.e. what the router
 * lost on this page load.
 */
function restoredKeys(
  merged: Record<string, unknown>,
  supplied: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== 'string' || NOT_RESTORED.has(key)) continue
    if (supplied[key] === undefined) out[key] = value
  }
  return out
}

/**
 * Drop-in replacement for `useLocalSearchParams` in `_layout.tsx`.
 *
 * Returns the params that hold for both cold loads and in-app pushes. On the
 * page load that opened this project, the arrival query is also put back into
 * the router state once, so the URL keeps it.
 */
export function useProjectRouteParams<
  T extends Record<string, string | string[]>,
>(): T {
  const local = useLocalSearchParams<T>()
  const global = useGlobalSearchParams<T>()
  const pathname = usePathname()
  const router = useRouter()
  const projectId =
    typeof local.id === 'string'
      ? local.id
      : Array.isArray(local.id)
        ? local.id[0]
        : undefined
  // A read, not a take: RENDERING with the arrival query is fine on every
  // render; only acting on it is once-per-page-load (the effect below).
  const arrivalParams = peekArrivalQueryParamsForProject(projectId)

  const merged = mergeProjectRouteParams({
    local,
    global,
    pathname,
    projectId,
    arrivalParams,
  })

  // Derived every render rather than latched: the first render of a cold load
  // can still be missing `id` (the store is populated by the leaf), so a
  // captured-at-mount value could latch `{}` and never restore anything.
  const restored = restoredKeys(merged, { ...global, ...local })

  const settled = useRef(false)
  useEffect(() => {
    if (settled.current || !projectId) return
    settled.current = true
    // Claimed even when there is nothing to restore, so a later in-app visit
    // to this project cannot pick the arrival query up instead.
    if (!claimArrivalQueryParams()) return
    if (Object.keys(restored).length === 0) return
    router.setParams(restored)
  }, [projectId, restored, router])

  return merged
}
