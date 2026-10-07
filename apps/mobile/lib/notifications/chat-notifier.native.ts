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

import { parseAgentDeepLink } from '../agent-glance'
import { answerApproval } from '../approval-decision'
import { getRequireBiometricApproval, subscribeRequireBiometricApproval } from '../approval-lock'
import {
  APPROVAL_CATEGORY,
  approvalActionFrom,
  approvalCategoryActions,
  failedAnswerBody,
  type ApprovalAction,
} from './agent-actions'
import type {
  ChannelNotificationPayload,
  ChatNotificationClickData,
  ChatNotificationPayload,
} from './chat-notifier'

let handlerConfigured = false
let androidChannelConfigured = false
let activeChatContext: { sessionId: string; projectId: string } | null = null
let activeChannelConversationId: string | null = null

/**
 * Lets the native notification handler avoid interrupting the user when the
 * exact chat that just completed is already visible in the foreground.
 */
export function setActiveChatNotificationContext(
  context: { sessionId: string; projectId: string } | null,
): void {
  activeChatContext = context
}

/** Approve and Deny buttons on approval notifications; Approve opens the app when Face ID is required. */
async function registerApprovalCategory(requireBiometric?: boolean) {
  try {
    const required = requireBiometric ?? (await getRequireBiometricApproval())
    await Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, approvalCategoryActions({ requireBiometric: required }))
  } catch {
    // Without the category the notification still shows; its buttons just don't.
  }
}

/** Answer an approval from its notification, and say so if it could not be sent. */
async function handleApprovalAction(action: ApprovalAction) {
  const outcome = await answerApproval(action.messageId, action.decision, { biometricReason: 'Approve this action' })
  if (action.notificationId) {
    try {
      await Notifications.dismissNotificationAsync(action.notificationId)
    } catch {
      // Already gone.
    }
  }
  if (outcome.ok || outcome.reason === 'cancelled') return
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: `approval-failed-${action.messageId}`,
      content: {
        title: 'Agent approval',
        body: failedAnswerBody(action.decision, outcome.message),
        data: { approvalMessageId: action.messageId },
        ...(Platform.OS === 'android' ? { channelId: 'messages' } : {}),
      },
      trigger: null,
    })
  } catch {
    // Best-effort.
  }
}

function ensureHandler() {
  if (handlerConfigured) return
  handlerConfigured = true
  void registerApprovalCategory()
  subscribeRequireBiometricApproval((value) => void registerApprovalCategory(value))
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data as
        | { sessionId?: string; projectId?: string; conversationId?: string }
        | undefined
      const isAlreadyVisible =
        AppState.currentState === 'active' &&
        (data?.conversationId
          ? activeChannelConversationId === data.conversationId
          : activeChatContext?.sessionId === data?.sessionId &&
            activeChatContext?.projectId === data?.projectId)

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
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Team chat',
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

function parseClickData(raw: unknown): ChatNotificationClickData | null {
  const data = (raw ?? {}) as Record<string, unknown>
  const agentKey = typeof data.url === 'string' ? parseAgentDeepLink(data.url) : null
  if (agentKey) return { agentKey }
  if (typeof data.taskId === 'string') return { taskId: data.taskId }
  if (typeof data.conversationId === 'string') {
    return {
      conversationId: data.conversationId,
      threadRootId: typeof data.threadRootId === 'string' ? data.threadRootId : null,
    }
  }
  if (typeof data.sessionId === 'string' && typeof data.projectId === 'string') {
    return { sessionId: data.sessionId, projectId: data.projectId }
  }
  return null
}

export function setActiveChannelNotificationContext(conversationId: string | null): void {
  activeChannelConversationId = conversationId
}

export async function notifyChannelMessage(p: ChannelNotificationPayload): Promise<void> {
  ensureHandler()
  await ensureAndroidChannel()
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: `channel-${p.messageId}`,
      content: {
        title: p.title,
        body: p.body,
        data: { conversationId: p.conversationId, threadRootId: p.threadRootId },
        sound: 'default',
        ...(Platform.OS === 'android' ? { channelId: 'messages' } : {}),
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
    // A press on Approve or Deny answers the agent; it is not a tap to open a chat.
    const answer = approvalActionFrom(response)
    if (answer) {
      void handleApprovalAction(answer)
      return
    }
    const data = parseClickData(response.notification.request.content.data)
    if (data) cb(data)
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
    // The app was started by a press on Approve or Deny: send it once, and
    // clear the response so the next launch does not send it again.
    const answer = approvalActionFrom(resp)
    if (answer) {
      await Notifications.clearLastNotificationResponseAsync().catch(() => {})
      void handleApprovalAction(answer)
      return null
    }
    return parseClickData(resp?.notification.request.content.data)
  } catch {
    // ignore
  }
  return null
}
