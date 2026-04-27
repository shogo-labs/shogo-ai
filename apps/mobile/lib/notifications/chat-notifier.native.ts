// SPDX-License-Identifier: AGPL-3.0-or-later
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

function ensureHandler() {
  if (handlerConfigured) return
  handlerConfigured = true
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      // Keep legacy field for older runtime surfaces that still read it.
      shouldShowAlert: true,
    }),
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
    if (data?.sessionId && data?.projectId) {
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
    if (data?.sessionId && data?.projectId) {
      return { sessionId: data.sessionId, projectId: data.projectId }
    }
  } catch {
    // ignore
  }
  return null
}
