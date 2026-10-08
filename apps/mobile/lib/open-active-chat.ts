// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { useRouter } from 'expo-router'

type Router = ReturnType<typeof useRouter>

export interface ActiveChatTarget {
  chatSessionId?: string
  projectId?: string | null
  isPrimary?: boolean
}

/**
 * Open the chat behind an Activity "running now" card. Project sessions open
 * in the project surface; workspace sessions open as the primary workspace
 * chat or, for any other session, as a side chat.
 *
 * The primary chat opens at `/agent`, not `/`: wide team workspaces render
 * the project builder at `/`.
 */
export function openActiveChat(router: Router, chat: ActiveChatTarget) {
  if (chat.projectId && chat.chatSessionId) {
    router.push({
      pathname: '/(app)/projects/[id]',
      params: { id: chat.projectId, chatSessionId: chat.chatSessionId },
    } as any)
    return
  }
  if (!chat.chatSessionId || chat.isPrimary) {
    router.push('/(app)/agent' as any)
    return
  }
  router.push({ pathname: '/(app)/side-chats/[id]', params: { id: chat.chatSessionId } } as any)
}
