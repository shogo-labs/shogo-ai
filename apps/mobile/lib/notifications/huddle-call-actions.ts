// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Join and Decline on a huddle call notification, for a phone that isn't
 * showing the call on the system screen. Pure helpers: the category the phone
 * registers, and how a tap on one of its buttons is read. The native notifier
 * does the registering and the answering.
 *
 * The API sends these alerts with `channelId: 'huddle-calls'`,
 * `categoryId: 'huddle-call'`, and `huddleId`, `conversationId`, `workspaceId`
 * in `data` (see `huddle.service.ts`).
 */
import type { ConversationKind } from '../team-chat-api'

export const HUDDLE_CALLS_CHANNEL = 'huddle-calls'
export const HUDDLE_CALL_CATEGORY = 'huddle-call'
export const ACTION_JOIN = 'join'
export const ACTION_DECLINE = 'decline'

export interface HuddleCallCategoryAction {
  identifier: string
  buttonTitle: string
  options: { opensAppToForeground: boolean; isDestructive?: boolean }
}

/** Join opens the app (the call needs the microphone); Decline doesn't. */
export function huddleCallCategoryActions(): HuddleCallCategoryAction[] {
  return [
    { identifier: ACTION_JOIN, buttonTitle: 'Join', options: { opensAppToForeground: true } },
    { identifier: ACTION_DECLINE, buttonTitle: 'Decline', options: { opensAppToForeground: false, isDestructive: true } },
  ]
}

export interface ResponseLike {
  actionIdentifier?: string
  notification?: { request?: { content?: { title?: string | null; data?: unknown } } }
}

export interface HuddleCallAction {
  decision: 'join' | 'decline'
  huddleId: string
  conversationId: string
  workspaceId: string
  kind: ConversationKind
  callerName: string
}

/** A tap on Join or Decline of a huddle call notification, or null for any other response. */
export function huddleCallActionFrom(response: ResponseLike | null | undefined): HuddleCallAction | null {
  if (!response) return null
  const decision = response.actionIdentifier === ACTION_JOIN ? 'join' : response.actionIdentifier === ACTION_DECLINE ? 'decline' : null
  if (!decision) return null
  const content = response.notification?.request?.content
  const data = (content?.data ?? {}) as Record<string, unknown>
  if (typeof data.huddleId !== 'string' || typeof data.conversationId !== 'string' || typeof data.workspaceId !== 'string') return null
  return {
    decision,
    huddleId: data.huddleId,
    conversationId: data.conversationId,
    workspaceId: data.workspaceId,
    kind: data.kind === 'group_dm' ? 'group_dm' : 'dm',
    callerName: content?.title?.trim() || 'Someone',
  }
}
