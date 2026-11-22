// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keeps the open chat's id in the project page URL (`?chatSessionId=<id>`) so
 * the address bar names the chat: copying, reloading or sharing the URL lands
 * on that exact chat instead of the project's pinned/default one.
 *
 * The read side already works (`?chatSessionId=` is honoured on arrival). This
 * module owns the **write** side: one mirror for the ~25 `setChatSessionId`
 * call sites, plus the bookkeeping that tells an id *this screen wrote* apart
 * from one the viewer actually deep-linked (several guards treat "the URL
 * names a chat" as "don't auto-select over the viewer's choice").
 */
import { useEffect, useRef } from 'react'

export type ChatSessionParamValue = string | string[] | undefined

/** Params to hand to `router.setParams`; `undefined` drops the key. */
export type ChatUrlParams = Record<string, string | undefined>

export type ChatUrlScope = 'workspace' | 'project'

/**
 * Arrival-only params. They must not survive the mirror write, or reloading a
 * shared URL would create another chat or resend the first message.
 */
export const CHAT_URL_ONE_SHOT_PARAMS = [
  'newChat',
  'newChatNonce',
  'initialMessage',
  'startEzMode',
  'autoStartVoice',
] as const

export function firstChatSessionParam(
  value: ChatSessionParamValue
): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.length > 0 ? first : undefined
}

/** True when any arrival-only param is still in the URL. */
export function hasChatUrlOneShotParams(
  params: Record<string, unknown>
): boolean {
  return CHAT_URL_ONE_SHOT_PARAMS.some((key) => {
    const value = params[key]
    const first = Array.isArray(value) ? value[0] : value
    return first !== undefined && first !== null && first !== ''
  })
}

/**
 * The chat the viewer asked for on arrival — the URL's id unless this screen
 * wrote it itself. An id we mirrored is just our own state echoed back, so
 * guards must not treat it as a deep link.
 */
export function deepLinkedChatSessionId(
  currentParam: ChatSessionParamValue,
  selfWrittenId: string | null
): string | undefined {
  const incoming = firstChatSessionParam(currentParam)
  if (!incoming) return undefined
  if (selfWrittenId && incoming === selfWrittenId) return undefined
  return incoming
}

/**
 * The id the viewer asked for, as the selection guards must read it.
 *
 * - an id a cold load restored (SHO-174) is the viewer's request even though
 *   this mirror is the one writing it into the URL, because the router dropped
 *   it on arrival;
 * - otherwise an id in the URL that this mirror wrote itself is just our own
 *   state echoed back and must not read as a deep link.
 */
export function resolveDeepLinkedChatSessionId(input: {
  currentParam: ChatSessionParamValue
  selfWrittenId: string | null
  preservedChatSessionId?: string
}): string | undefined {
  const restored = firstChatSessionParam(input.preservedChatSessionId)
  if (restored) return restored
  return deepLinkedChatSessionId(input.currentParam, input.selfWrittenId)
}

/**
 * The address bar with `preserved` keys added, or `null` when it already has
 * them all.
 *
 * Needed because the router only re-serialises the URL when its *state*
 * changes: on a cold load it parses `?chatSessionId=` into the state and then
 * writes a barer URL, and a `setParams` that repeats what the state already
 * holds is not a change, so nothing repairs the address bar. Rewriting the
 * query directly fixes the one thing that is wrong (the URL) without inventing
 * a state change that would remount the screen.
 */
/**
 * When to re-check the address bar after a write. The linking layer parses the
 * query into its state immediately but serialises the URL from that state in
 * more than one pass, and the last pass — the one that drops the query — lands
 * roughly 0.6s after the document starts. These delays straddle that window.
 */
const URL_REPAIR_DELAYS_MS = [900]

export function withPreservedQuery(
  search: string,
  preserved: Record<string, string>
): string | null {
  const current = new URLSearchParams(search)
  let changed = false
  for (const [key, value] of Object.entries(preserved)) {
    if (current.get(key) === value) continue
    current.set(key, value)
    changed = true
  }
  if (!changed) return null
  const query = current.toString()
  return query ? `?${query}` : ''
}

export interface ChatUrlMirrorInput {
  /** The chat the project page currently has open (`null` = none). */
  chatSessionId: string | null
  /** `params.chatSessionId` as the screen reads it. */
  currentParam: ChatSessionParamValue
  /** Any arrival-only params still in the URL. */
  oneShotPresent: boolean
  chatScope: ChatUrlScope
  /** The session the URL named on first mount (the workspace hand-off tab). */
  initialPropsSessionId: string | null
  /**
   * Arrival keys a cold load restored, which every write must keep (SHO-174).
   * A key drops out once the screen changes its value itself.
   */
  preserved?: Record<string, string>
  /**
   * The address bar's own query, as `URLSearchParams` would read it. The router
   * *state* is not the same thing: a cold load parses the query into the state
   * and then serialises the URL without it, so `currentParam` can be exactly
   * right while the address bar is bare. When a preserved key is missing or
   * different here, the URL is wrong now and only a write can fix it.
   */
  urlQuery?: Record<string, string>
}

export interface ChatUrlWrite {
  /** The id to remember as our own write (`null` when clearing the param). */
  selfWrittenId: string | null
  params: ChatUrlParams
}

/**
 * What to write into the URL for the current chat, or `null` when the URL is
 * already right. Callers pass the result straight to `router.setParams`, which
 * replaces the current history entry — switching chats never stacks Back
 * entries.
 */
export function planChatUrlWrite(
  input: ChatUrlMirrorInput
): ChatUrlWrite | null {
  const { chatSessionId, currentParam, oneShotPresent } = input
  const incoming = firstChatSessionParam(currentParam)

  // Keys a cold load restored must survive this write: the address bar is built
  // from the router state, so a write that omits them drops them again. The
  // chat keys are this function's own and are never taken from `preserved`.
  const preserved: ChatUrlParams = {}
  for (const [key, value] of Object.entries(input.preserved ?? {})) {
    if (key === 'chatSessionId' || key === 'chatScope') continue
    preserved[key] = value
  }
  // Is the address bar actually missing what the screen wants kept?
  const preservedStale = input.urlQuery
    ? Object.entries(preserved).some(([key, value]) => input.urlQuery![key] !== value)
    : false
  if (!chatSessionId) {
    // No chat open (last tab closed): the URL must not keep naming one.
    if (!incoming && !preservedStale) return null
    return {
      selfWrittenId: null,
      params: { ...preserved, chatSessionId: undefined, chatScope: undefined },
    }
  }

  // The URL already names the open chat, carries what the arrival asked for and
  // has no one-shot params left. A param that arrived as a real deep link is
  // deliberately not re-written: leaving it alone keeps it a deep link for the
  // selection guards (they must not treat our own echo as the viewer's choice).
  if (incoming === chatSessionId && !oneShotPresent && !preservedStale) return null

  // Keep workspace scope only for the tab the URL handed off; chats opened
  // afterwards are ordinary project chats (see `resolveChatScope`).
  const keepScope =
    input.chatScope === 'workspace' &&
    !!input.initialPropsSessionId &&
    input.chatSessionId === input.initialPropsSessionId

  const params: ChatUrlParams = {
    ...preserved,
    chatSessionId,
    chatScope: keepScope ? 'workspace' : undefined,
  }
  if (oneShotPresent) {
    for (const key of CHAT_URL_ONE_SHOT_PARAMS) params[key] = undefined
  }
  return { selfWrittenId: chatSessionId, params }
}

/**
 * Does the chat a link names belong on this project page? `contextId` is the
 * project for both project-scoped and project-anchored workspace chats; a
 * workspace-scoped chat with no anchor (`contextId: null`) can be shown on any
 * page it was linked to. A chat anchored to *another* project is only kept
 * when the link explicitly asked for workspace scope — that is how a file
 * opened in an attached project keeps showing the workspace chat it came from.
 */
export function isChatSessionOfProject(
  session: { contextId?: string | null } | null | undefined,
  input: { projectId: string; allowCrossProject?: boolean }
): boolean {
  if (!session) return false
  const contextId = session.contextId ?? null
  if (!contextId) return true
  if (contextId === input.projectId) return true
  return input.allowCrossProject === true
}

/**
 * Is there an address bar to mirror into? React Native (Hermes, native) exposes
 * a global `window` with no `location`, so `typeof window === 'undefined'` is
 * false on the phone while `window.location.search` throws — every read and
 * write in this module goes through this check instead.
 */
export function canUseAddressBar(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.location?.search === 'string' &&
    typeof window.history?.replaceState === 'function'
  )
}

export interface UseProjectChatUrlMirrorOptions extends Omit<ChatUrlMirrorInput, 'currentParam'> {
  currentParam: ChatSessionParamValue
  /** Off for the IDE embed (it owns the URL) and for native (no address bar). */
  enabled: boolean
  /** `router.setParams` — pass the router's own function. */
  setParams?: (params: ChatUrlParams) => void
}

/**
 * Mirrors the open chat into `?chatSessionId=`. Returns the id the viewer
 * actually deep-linked (undefined for ids this hook wrote), which callers use
 * to decide whether to honour the URL or run their own auto-select.
 */
export function useProjectChatUrlMirror(
  options: UseProjectChatUrlMirrorOptions
): { deepLinkedChatSessionId: string | undefined } {
  const selfWrittenRef = useRef<string | null>(null)
  // Kept in a ref so an inline arrow `setParams` doesn't re-run the effect.
  const setParamsRef = useRef(options.setParams)
  setParamsRef.current = options.setParams
  // Callers rebuild these objects every render; key the effect on their value
  // so a mirror write is not attempted on every render.
  const queryRef = useRef(options.preserved)
  queryRef.current = options.preserved
  const preservedKey = JSON.stringify(options.preserved ?? {})
  // The address bar, read when a write is attempted rather than during render.
  const readUrlQuery = (): Record<string, string> | undefined => {
    if (!options.enabled || !canUseAddressBar()) return undefined
    const query: Record<string, string> = {}
    new URLSearchParams(window.location.search).forEach((value, key) => {
      query[key] = value
    })
    return query
  }
  // A stale URL cannot be stale twice for the same intent: without this, a
  // write that the router cannot serialise would be re-attempted every render.
  const attemptedRef = useRef('')
  // Repairs run on a timer, after the render that scheduled them: read the chat
  // the screen is on *now* from this ref, never the one that render captured.
  const liveChatRef = useRef(options.chatSessionId)
  liveChatRef.current = options.chatSessionId
  const repairUrl = () => {
    if (!options.enabled || !canUseAddressBar()) return
    const preserved = { ...queryRef.current }
    if (!preserved || Object.keys(preserved).length === 0) return
    // Never re-assert a chat the screen has already left — a dead or foreign id
    // from the link is corrected by the screen, and repairing it here would put
    // the rejected id back into the address bar.
    const preservedChat = preserved.chatSessionId
    if (preservedChat && preservedChat !== liveChatRef.current) delete preserved.chatSessionId
    const next = withPreservedQuery(window.location.search, preserved)
    if (next === null) return
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${next}${window.location.hash}`,
    )
  }
  const {
    chatSessionId,
    currentParam,
    chatScope,
    initialPropsSessionId,
    oneShotPresent,
    enabled,
  } = options

  useEffect(() => {
    // The guard the crash came from: a caller that forgot the platform check
    // still must not run this effect where there is no address bar.
    if (!enabled || !setParamsRef.current || !canUseAddressBar()) return
    const intent = JSON.stringify([chatSessionId, oneShotPresent, preservedKey])
    if (attemptedRef.current === intent) return
    const write = planChatUrlWrite({
      chatSessionId,
      currentParam,
      oneShotPresent,
      chatScope,
      initialPropsSessionId,
      preserved: queryRef.current,
      urlQuery: readUrlQuery(),
    })
    if (write) {
      attemptedRef.current = intent
      // Recorded before the write lands so the next render already knows the
      // param is ours, not a deep link.
      selfWrittenRef.current = write.selfWrittenId
      setParamsRef.current(write.params)
    }
    // The state already carried what this screen wants (or carried it only
    // after the write), and the router never re-serialises on an identity
    // change, so the address bar can still be the barer URL the linking layer
    // settled on. Repair that one thing directly; a no-op when it already
    // matches.
    // The linking layer has not finished with the address bar when this runs:
    // it settles the navigator on its initial route ~0.6s after load and
    // replaces the URL with a barer one on the way. Repair now and again
    // across that window; `withPreservedQuery` is a no-op once the URL is
    // right, so the extra passes cost nothing.
    repairUrl()
    const timers = URL_REPAIR_DELAYS_MS.map((delay) => setTimeout(repairUrl, delay))
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [
    enabled,
    chatSessionId,
    currentParam,
    chatScope,
    initialPropsSessionId,
    oneShotPresent,
    preservedKey,
  ])

  return {
    deepLinkedChatSessionId: resolveDeepLinkedChatSessionId({
      currentParam,
      selfWrittenId: selfWrittenRef.current,
      preservedChatSessionId: queryRef.current?.chatSessionId,
    }),
  }
}
