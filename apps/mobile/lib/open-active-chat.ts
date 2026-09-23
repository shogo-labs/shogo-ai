// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { Router } from 'expo-router'

export interface ActiveChatTarget {
  chatSessionId?: string
  projectId?: string | null
  isPrimary?: boolean
}

/**
 * Open the chat behind an Activity "running now" card. Project sessions open
 * in the project surface; workspace sessions open as the primary workspace
 * chat (home) or, for any other session, as a side chat.
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
    router.replace('/(app)' as any)
    return
  }
  router.push({ pathname: '/(app)/side-chats/[id]', params: { id: chat.chatSessionId } } as any)
}
