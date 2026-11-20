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
 * Restoring the value for rendering is not enough on its own: the URL is
 * serialised from the router's own state, so a key that only exists in the
 * merged object would be dropped again on the next write. Any restored key is
 * therefore also put back into the router state once, which is what keeps
 * `?tab=` in the address bar.
 *
 * The pure merge/guard function lives in `project-route-params-core.ts` so
 * unit tests can import it without resolving expo-router native modules.
 */
import { useEffect, useRef } from 'react'
import { useLocalSearchParams, useGlobalSearchParams, usePathname, useRouter } from 'expo-router'
import { arrivalQueryParamsForProject } from './arrival-url'
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
 * Drop-in replacement for `useLocalSearchParams` in `_layout.tsx`.
 *
 * Returns the params that hold for both cold loads and in-app pushes, plus one
 * effect that puts any cold-load-only key back into the router state so the
 * URL keeps it.
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
  const arrivalParams = arrivalQueryParamsForProject(projectId)

  const merged = mergeProjectRouteParams({
    local,
    global,
    pathname,
    projectId,
    arrivalParams,
  })

  // Keys that came only from the arrival URL. Computed once, from the first
  // render's params: later renders reflect the state this effect writes.
  const restoredRef = useRef<Record<string, string> | null>(null)
  if (restoredRef.current === null) {
    const supplied: Record<string, unknown> = { ...global, ...local }
    const restored: Record<string, string> = {}
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value !== 'string' || NOT_RESTORED.has(key)) continue
      if (supplied[key] === undefined) restored[key] = value
    }
    restoredRef.current = restored
  }

  const restoredOnce = useRef(false)
  useEffect(() => {
    const restored = restoredRef.current
    if (restoredOnce.current || !restored) return
    if (Object.keys(restored).length === 0) return
    restoredOnce.current = true
    router.setParams(restored)
  }, [router])

  return merged
}
