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
 * viewer asked for, so it speaks for every key the router is not
 * authoritatively carrying — including a `chatSessionId` the chat mirror has
 * already filled with the project's pinned chat by first render (see
 * `arrivalSpeaks` in `project-route-params-core.ts` for the exact rule).
 *
 * This hook only *reads*. Writing the query into the router state is the chat
 * URL mirror's job (`lib/project-chat-url.ts`): it is the single writer of
 * `?chatSessionId=`, and two owners of one address bar fight — a write here
 * calculated from the pre-restore params is undone by the mirror's next write,
 * and vice versa. So this hook reports the keys the URL has to keep
 * (`preserved`) and the layout hands them to the mirror, which carries them on
 * every write it makes for the life of the screen.
 *
 * The arrival query is spent once per page load. This layout remounts whenever
 * the viewer leaves the project and comes back, and those in-app visits carry
 * their own params — replaying the arrival query on them would re-send
 * `initialMessage`, mint a second chat for `newChat=1`, and snap
 * `tab`/`chatSessionId` back to the original link. Both the arrival query and
 * the mount's baseline are latched for the life of the mount, so claiming it
 * cannot make a restored tab or chat vanish underneath the screen.
 *
 * The pure merge/guard functions live in `project-route-params-core.ts` so unit
 * tests can import them without resolving expo-router native modules.
 */
import { useEffect, useRef } from 'react'
import { useLocalSearchParams, useGlobalSearchParams, usePathname } from 'expo-router'
import { claimArrivalQueryParams, peekArrivalQueryParamsForProject } from './arrival-url'
import {
  mergeProjectRouteParams,
  NOT_RESTORED_PARAMS,
} from './project-route-params-core'

export { mergeProjectRouteParams, NOT_RESTORED_PARAMS } from './project-route-params-core'

export interface ProjectRouteParams<T> {
  /** The params to read: the arrival URL's intent, then the router's own. */
  params: T
  /**
   * Arrival keys the address bar still has to carry, i.e. what the URL writer
   * must keep on every write. Empty for in-app navigations and for keys the
   * screen has since changed itself.
   */
  preserved: Record<string, string>
  /** The params the router supplied, i.e. what it would serialise the URL to. */
  routerParams: T
}

/**
 * Drop-in replacement for `useLocalSearchParams` in `_layout.tsx`.
 */
export function useProjectRouteParams<
  T extends Record<string, string | string[]>,
>(): ProjectRouteParams<T> {
  const local = useLocalSearchParams<T>()
  const global = useGlobalSearchParams<T>()
  const pathname = usePathname()
  // The id is a path segment, so the focused leaf carries it too (`populateParams`
  // copies path params onto the sibling routes). Reading both matters: the
  // screen latches its state from these params on its FIRST render, and on a
  // cold load that render can still be missing the layout's own params.
  const rawId = local.id ?? global.id
  const projectId =
    typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : undefined

  // Latched for the life of this mount, and only on a render that has arrival
  // params, so an early render without `id` cannot freeze an empty set.
  const latched = useRef<{
    projectId: string
    arrivalParams: Record<string, string>
    baseline: T
  } | null>(null)

  const routerParams = { ...global, ...local } as T
  const arrivalParams = peekArrivalQueryParamsForProject(projectId)
  if (arrivalParams && projectId && latched.current?.projectId !== projectId) {
    latched.current = { projectId, arrivalParams, baseline: routerParams }
  }
  const latchedArrival =
    latched.current?.projectId === projectId ? latched.current : null

  const params = mergeProjectRouteParams<T>({
    local,
    global,
    pathname,
    projectId,
    arrivalParams: latchedArrival?.arrivalParams ?? arrivalParams,
    baseline: latchedArrival?.baseline ?? routerParams,
  })

  // Every arrival key still in force, not only the ones the router had already
  // dropped at first render: the writer drops keys it does not pass, and how
  // much of the query survives the router's settle varies by URL (a reload of a
  // settings link arrives with `tab` intact but loses it to the next write). A
  // key drops out as soon as the screen changes that value itself — a tab
  // click, a chat switch — because then the screen's value is the URL's.
  const preserved: Record<string, string> = {}
  for (const [key, value] of Object.entries(latchedArrival?.arrivalParams ?? {})) {
    if (NOT_RESTORED_PARAMS.has(key)) continue
    if (params[key] === value) preserved[key] = value
  }

  // Claims this page load's arrival query for the first project mount, even
  // when nothing needed correcting, so a later in-app visit to this project
  // cannot pick it up instead.
  const settled = useRef(false)
  useEffect(() => {
    if (settled.current || !projectId) return
    settled.current = true
    claimArrivalQueryParams()
  }, [projectId])

  return { params, preserved, routerParams }
}
