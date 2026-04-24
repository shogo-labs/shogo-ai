// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Subscribe once at the app root to route notification taps/clicks back into
 * the project + chat session that finished. Shared across all platforms —
 * the underlying source (Electron IPC, Web Notification API, or
 * expo-notifications response listener) is handled by the chat-notifier
 * platform extensions.
 */

import { useEffect } from 'react'
import { useRouter } from 'expo-router'

import {
  consumeColdStartNotification,
  subscribeNotificationClicks,
  type ChatNotificationClickData,
} from './chat-notifier'

function buildChatHref(data: ChatNotificationClickData) {
  return {
    pathname: '/(app)/projects/[id]' as const,
    params: { id: data.projectId, chatSessionId: data.sessionId },
  }
}

export function useNotificationClickRouter(): void {
  const router = useRouter()

  useEffect(() => {
    const unsubscribe = subscribeNotificationClicks((data) => {
      try {
        router.push(buildChatHref(data) as any)
      } catch {
        // ignore routing errors
      }
    })

    // Native cold-start: if the app was opened by tapping the notification
    // while killed, pick up that initial response and route accordingly.
    void consumeColdStartNotification().then((data) => {
      if (!data) return
      try {
        router.push(buildChatHref(data) as any)
      } catch {
        // ignore routing errors
      }
    })

    return () => {
      unsubscribe()
    }
  }, [router])
}
