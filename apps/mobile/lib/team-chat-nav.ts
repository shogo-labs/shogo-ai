// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where an agent's session was opened from, and the trail back.
 *
 * A channel reply opens the session it ran in (project chat). The route carries where the person
 * came from so that screen can show `#eng › Thread › Agent` and let them step back up.
 */

export interface SessionOrigin {
  conversationId: string
  /** `eng`, or the person/people in a DM. */
  conversationLabel: string
  /** Channels read as `#eng`; the `#` cannot travel in a URL, so the kind does. */
  conversationKind: string
  threadRootId?: string | null
  agentName: string
}

export interface SessionRoute {
  pathname: '/(app)/project-chat/[id]' | '/(app)/projects/[id]' | '/(app)/agent'
  params: Record<string, string>
}

/**
 * The route for an agent's session. A project agent's session is project chat; the workspace
 * agent (`projectId` null) has no project, so its session opens in the workspace agent chat.
 */
export function sessionRoute(input: { projectId: string | null; sessionId: string; origin: SessionOrigin; wide: boolean }): SessionRoute {
  const { projectId, sessionId, origin, wide } = input
  const originParams = {
    fromConversation: origin.conversationId,
    fromLabel: origin.conversationLabel,
    fromKind: origin.conversationKind,
    ...(origin.threadRootId ? { fromThread: origin.threadRootId } : {}),
    fromAgent: origin.agentName,
  }
  if (!projectId) {
    return { pathname: '/(app)/agent', params: { chatSessionId: sessionId, ...originParams } }
  }
  return {
    pathname: wide ? '/(app)/projects/[id]' : '/(app)/project-chat/[id]',
    params: { id: projectId, chatSessionId: sessionId, ...originParams },
  }
}

/** The conversation, and the thread when the run happened in one. Same shape as the session breadcrumb. */
export function conversationThreadRoute(conversationId: string, threadRootId?: string | null): {
  pathname: '/(app)/c/[conversationId]'
  params: Record<string, string>
} {
  return {
    pathname: '/(app)/c/[conversationId]',
    params: threadRootId ? { conversationId, thread: threadRootId } : { conversationId },
  }
}

// ─── One thread at a time ────────────────────────────────────────────────────
/**
 * Opening a thread used to `router.push` a second `/c/[conversationId]` screen,
 * so a thread opened while another was on screen stacked a copy of the channel
 * over it (a slide on a phone, a hidden entry in history on wide web) instead of
 * replacing it. Every entry point — a timeline reply, a quote card, an in-app
 * message link, Activity, Inbox, Later, Search, Questions, a dispatch card, a
 * notification — goes through `openConversationTarget` so that stays true.
 */

/** The conversation screen in focus, and the thread open in it. */
export interface ThreadNavState {
  conversationId: string | null
  threadRootId: string | null
}

/** `push` a new screen, `swap` the thread in place, or do nothing. */
export type ThreadNavAction = 'push' | 'swap' | 'none'

/**
 * What opening `target` should do while `state` is the screen in focus.
 *
 * A thread replaces a thread in the same conversation; everything else pushes a
 * screen, which is what keeps Back closing the thread back to the channel.
 */
export function threadNavAction(state: ThreadNavState, target: { conversationId: string; thread?: string | null }): ThreadNavAction {
  if (!target.thread) return 'push'
  if (state.conversationId !== target.conversationId) return 'push'
  if (!state.threadRootId) return 'push'
  return state.threadRootId === target.thread ? 'none' : 'swap'
}

const NO_THREAD_FOCUS: ThreadNavState = { conversationId: null, threadRootId: null }
let threadFocus: ThreadNavState = NO_THREAD_FOCUS
// The screen that published the focus. A screen being covered by the one it
// opens does not get to clear it, so the new focus survives the old blur.
let threadFocusOwner: object | null = null

/**
 * Publish which conversation and thread the screen has in focus. The
 * conversation screen calls this on focus and whenever its params change, so
 * `openConversationTarget` can tell a swap from a push without every caller
 * having to hand over a navigation object.
 */
export function setThreadFocus(next: ThreadNavState | null, owner: object): void {
  if (next === null) {
    if (threadFocusOwner !== owner) return
    threadFocusOwner = null
    threadFocus = NO_THREAD_FOCUS
    return
  }
  threadFocusOwner = owner
  threadFocus = next
}

/** The conversation and thread in focus right now — nothing when no conversation screen is. */
export function currentThreadFocus(): ThreadNavState {
  return threadFocus
}

export interface ConversationTarget {
  conversationId: string
  thread?: string | null
  msg?: string | null
  board?: string | null
  card?: string | null
  project?: string | null
  files?: boolean
  doc?: boolean
  file?: string | null
  profile?: string | null
}

type PushRouter = { push: (href: never) => void; setParams: (params: never) => void }

function conversationParams(target: ConversationTarget): Record<string, string> {
  const params: Record<string, string> = { conversationId: target.conversationId }
  if (target.thread) params.thread = target.thread
  if (target.msg) params.msg = target.msg
  if (target.board) params.board = target.board
  if (target.card) params.card = target.card
  if (target.project) params.project = target.project
  if (target.files) params.files = '1'
  if (target.doc) params.doc = '1'
  if (target.file) params.file = target.file
  if (target.profile) params.profile = target.profile
  return params
}

/**
 * Open a conversation, a thread or a pane — pushing a screen, or swapping the
 * open thread out of the way first. Returns what it did, so a caller with more
 * work to do (closing a menu, marking read) can tell a no-op from a navigation.
 */
export function openConversationTarget(router: PushRouter, target: ConversationTarget): ThreadNavAction {
  const action = threadNavAction(currentThreadFocus(), target)
  if (action === 'none') return action
  if (action === 'swap') {
    // The new thread takes the pane; every pane that would hide it steps aside.
    router.setParams({
      thread: target.thread,
      msg: target.msg ?? undefined,
      project: undefined,
      files: undefined,
      doc: undefined,
      file: undefined,
      profile: undefined,
      card: undefined,
      ...(target.board ? { board: target.board } : {}),
      ...(target.card ? { card: target.card } : {}),
    } as never)
    return action
  }
  router.push({ pathname: '/(app)/c/[conversationId]', params: conversationParams(target) } as never)
  return action
}

export interface Crumb {
  key: string
  label: string
  /** Where tapping goes; the last crumb is where you are. */
  to?: { pathname: '/(app)/c/[conversationId]'; params: Record<string, string> }
}

type Param = string | string[] | undefined
const one = (v: Param) => (Array.isArray(v) ? v[0] : v)

/** The trail from the route params, or null when the session was not opened from a conversation. */
export function sessionCrumbs(params: Record<string, Param>): Crumb[] | null {
  const conversationId = one(params.fromConversation)
  if (!conversationId) return null
  const thread = one(params.fromThread)
  const crumbs: Crumb[] = [
    {
      key: 'conversation',
      label: conversationLabel({ kind: one(params.fromKind) ?? '', label: one(params.fromLabel) || 'Chat' }),
      to: { pathname: '/(app)/c/[conversationId]', params: { conversationId } },
    },
  ]
  if (thread) {
    crumbs.push({
      key: 'thread',
      label: 'Thread',
      to: { pathname: '/(app)/c/[conversationId]', params: { conversationId, thread } },
    })
  }
  crumbs.push({ key: 'session', label: one(params.fromAgent) ? `${one(params.fromAgent)} · session` : 'Session' })
  return crumbs
}

/** `#eng` for a channel, the people for a DM. */
export function conversationLabel(c: { kind: string; label: string }): string {
  return c.kind === 'channel' ? `#${c.label}` : c.label
}

/** The trail at the top of a thread: the conversation it belongs to, then the thread itself. */
export function threadCrumbs(c: { kind: string; label: string }): Array<{ key: string; label: string; up?: boolean }> {
  return [
    { key: 'conversation', label: conversationLabel(c), up: true },
    { key: 'thread', label: 'Thread' },
  ]
}
