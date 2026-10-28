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

export interface ChatUrlMirrorInput {
  /** The chat the project page currently has open (`null` = none). */
  chatSessionId: string | null
  /** `params.chatSessionId` as the router handed it to us. */
  currentParam: ChatSessionParamValue
  /** Any arrival-only params still in the URL. */
  oneShotPresent: boolean
  chatScope: ChatUrlScope
  /** The session the URL named on first mount (the workspace hand-off tab). */
  initialPropsSessionId: string | null
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

  if (!chatSessionId) {
    // No chat open (last tab closed): the URL must not keep naming one.
    if (!incoming) return null
    return {
      selfWrittenId: null,
      params: { chatSessionId: undefined, chatScope: undefined },
    }
  }

  // The URL already names the open chat and there is nothing one-shot left to
  // drop. A param that arrived as a real deep link is deliberately not
  // re-written: leaving it alone keeps it a deep link for the selection guards
  // (they must not treat our own echo as the viewer's choice).
  if (incoming === chatSessionId && !oneShotPresent) return null

  // Keep workspace scope only for the tab the URL handed off; chats opened
  // afterwards are ordinary project chats (see `resolveChatScope`).
  const keepScope =
    input.chatScope === 'workspace' &&
    !!input.initialPropsSessionId &&
    input.chatSessionId === input.initialPropsSessionId

  const params: ChatUrlParams = {
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

export interface UseProjectChatUrlMirrorOptions {
  chatSessionId: string | null
  currentParam: ChatSessionParamValue
  chatScope: ChatUrlScope
  initialPropsSessionId: string | null
  oneShotPresent: boolean
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
  const {
    chatSessionId,
    currentParam,
    chatScope,
    initialPropsSessionId,
    oneShotPresent,
    enabled,
  } = options

  useEffect(() => {
    if (!enabled || !setParamsRef.current) return
    const write = planChatUrlWrite({
      chatSessionId,
      currentParam,
      oneShotPresent,
      chatScope,
      initialPropsSessionId,
    })
    if (!write) return
    // Recorded before the write lands so the next render already knows the
    // param is ours, not a deep link.
    selfWrittenRef.current = write.selfWrittenId
    setParamsRef.current(write.params)
  }, [
    enabled,
    chatSessionId,
    currentParam,
    chatScope,
    initialPropsSessionId,
    oneShotPresent,
  ])

  return {
    deepLinkedChatSessionId: deepLinkedChatSessionId(
      currentParam,
      selfWrittenRef.current
    ),
  }
}
