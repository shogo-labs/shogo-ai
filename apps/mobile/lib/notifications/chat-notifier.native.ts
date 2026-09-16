// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * iOS / Android chat-completion notifier, built on `expo-notifications`.
 *
 * "Inactive" on native = app is not in the foreground (`AppState`).
 * Delivery uses a local notification scheduled with `trigger: null` and a
 * stable identifier so rapid successive turns replace, not stack.
 */

import { AppState, Platform } from 'react-native'
import * as Notifications from 'expo-notifications'

import type {
  ChatNotificationClickData,
  ChatNotificationPayload,
} from './chat-notifier'

let handlerConfigured = false
let androidChannelConfigured = false
let activeChatContext: { sessionId: string; projectId: string } | null = null

/**
 * Lets the native notification handler avoid interrupting the user when the
 * exact chat that just completed is already visible in the foreground.
 */
export function setActiveChatNotificationContext(
  context: { sessionId: string; projectId: string } | null,
): void {
  activeChatContext = context
}

function ensureHandler() {
  if (handlerConfigured) return
  handlerConfigured = true
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data as
        | { sessionId?: string; projectId?: string }
        | undefined
      const isAlreadyVisible =
        AppState.currentState === 'active' &&
        activeChatContext?.sessionId === data?.sessionId &&
        activeChatContext?.projectId === data?.projectId

      return {
        shouldShowBanner: !isAlreadyVisible,
        shouldShowList: !isAlreadyVisible,
        shouldPlaySound: !isAlreadyVisible,
        shouldSetBadge: false,
        // Keep legacy field for older runtime surfaces that still read it.
        shouldShowAlert: !isAlreadyVisible,
      }
    },
  })
}

async function ensureAndroidChannel() {
  if (androidChannelConfigured) return
  androidChannelConfigured = true
  if (Platform.OS !== 'android') return
  try {
    await Notifications.setNotificationChannelAsync('chat-complete', {
      name: 'Chat replies',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    })
  } catch {
    // Channel setup is best-effort.
  }
}

export async function isUserInactive(): Promise<boolean> {
  return AppState.currentState !== 'active'
}

let permissionCache: boolean | null = null

export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionCache !== null) return permissionCache
  try {
    const current = await Notifications.getPermissionsAsync()
    if (current.granted) {
      await ensureAndroidChannel()
      permissionCache = true
      return true
    }
    if (!current.canAskAgain) {
      permissionCache = false
      return false
    }
    const next = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowSound: true,
        allowBadge: false,
      },
    })
    permissionCache = next.granted
    if (next.granted) await ensureAndroidChannel()
    return next.granted
  } catch {
    return false
  }
}

export async function notifyChatFinished(p: ChatNotificationPayload): Promise<void> {
  ensureHandler()
  await ensureAndroidChannel()
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: `chat-complete-${p.sessionId}`,
      content: {
        title: p.title,
        body: p.preview,
        data: { sessionId: p.sessionId, projectId: p.projectId },
        sound: 'default',
        ...(Platform.OS === 'android' ? { channelId: 'chat-complete' } : {}),
      },
      trigger: null,
    })
  } catch {
    // Best-effort; don't surface delivery errors to the user.
  }
}

export function subscribeNotificationClicks(
  cb: (d: ChatNotificationClickData) => void,
): () => void {
  ensureHandler()
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as
      | Partial<ChatNotificationClickData>
      | undefined
    if (typeof data?.taskId === 'string') {
      cb({ taskId: data.taskId })
    } else if (typeof data?.sessionId === 'string' && typeof data.projectId === 'string') {
      cb({ sessionId: data.sessionId, projectId: data.projectId })
    }
  })
  return () => {
    try {
      sub.remove()
    } catch {
      // ignore
    }
  }
}

export async function consumeColdStartNotification(): Promise<ChatNotificationClickData | null> {
  try {
    const resp = await Notifications.getLastNotificationResponseAsync()
    const data = resp?.notification.request.content.data as
      | Partial<ChatNotificationClickData>
      | undefined
    if (typeof data?.taskId === 'string') {
      return { taskId: data.taskId }
    }
    if (typeof data?.sessionId === 'string' && typeof data.projectId === 'string') {
      return { sessionId: data.sessionId, projectId: data.projectId }
    }
  } catch {
    // ignore
  }
  return null
}
