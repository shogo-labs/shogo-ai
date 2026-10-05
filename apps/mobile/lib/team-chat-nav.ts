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
  pathname: '/(app)/project-chat/[id]' | '/(app)/projects/[id]'
  params: Record<string, string>
}

export function sessionRoute(input: { projectId: string; sessionId: string; origin: SessionOrigin; wide: boolean }): SessionRoute {
  const { projectId, sessionId, origin, wide } = input
  return {
    pathname: wide ? '/(app)/projects/[id]' : '/(app)/project-chat/[id]',
    params: {
      id: projectId,
      chatSessionId: sessionId,
      fromConversation: origin.conversationId,
      fromLabel: origin.conversationLabel,
      fromKind: origin.conversationKind,
      ...(origin.threadRootId ? { fromThread: origin.threadRootId } : {}),
      fromAgent: origin.agentName,
    },
  }
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
