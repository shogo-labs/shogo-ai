// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { useRouter } from 'expo-router'
import type { WorkTarget } from './agent-directory'
import { conversationThreadRoute } from './team-chat-nav'

type Router = ReturnType<typeof useRouter>

export interface ActiveChatTarget {
  chatSessionId?: string
  projectId?: string | null
  isPrimary?: boolean
  /** Set when the turn is an agent reply in team chat. */
  conversationId?: string | null
  threadRootId?: string | null
  messageId?: string | null
}

/** Open whatever an agent is working on: the team-chat thread, or the session behind it. */
export function openAgentWork(router: Router, target: WorkTarget) {
  if (target.kind === 'conversation') {
    openActiveChat(router, {
      conversationId: target.conversationId,
      threadRootId: target.threadRootId,
      messageId: target.messageId,
    })
    return
  }
  if (target.projectId && !target.chatSessionId) {
    router.push({ pathname: '/(app)/projects/[id]', params: { id: target.projectId } } as any)
    return
  }
  openActiveChat(router, {
    projectId: target.projectId,
    chatSessionId: target.chatSessionId ?? undefined,
    isPrimary: target.isPrimary,
  })
}

/**
 * Open the chat behind an Activity "running now" card. A turn that is an
 * agent reply in team chat opens that conversation (and its thread). Project
 * sessions open in the project surface; workspace sessions open in the
 * workspace agent.
 *
 * The workspace agent opens at `/agent`, not `/`: wide team workspaces render
 * the project builder at `/`.
 */
export function openActiveChat(router: Router, chat: ActiveChatTarget) {
  if (chat.conversationId) {
    const route = conversationThreadRoute(chat.conversationId, chat.threadRootId)
    if (chat.messageId) route.params.msg = chat.messageId
    router.push(route as any)
    return
  }
  if (chat.projectId && chat.chatSessionId) {
    router.push({
      pathname: '/(app)/projects/[id]',
      params: { id: chat.projectId, chatSessionId: chat.chatSessionId },
    } as any)
    return
  }
  if (!chat.chatSessionId) {
    router.push('/(app)/agent' as any)
    return
  }
  router.push({ pathname: '/(app)/agent', params: { chatSessionId: chat.chatSessionId } } as any)
}
