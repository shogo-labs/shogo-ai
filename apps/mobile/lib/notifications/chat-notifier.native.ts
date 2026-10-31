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
import { alertTitleFor } from './alert-title'
import { answerApproval } from '../approval-decision'
import { getRequireBiometricApproval, subscribeRequireBiometricApproval } from '../approval-lock'
import {
  APPROVAL_CATEGORY,
  approvalActionFrom,
  approvalCategoryActions,
  failedAnswerBody,
  type ApprovalAction,
} from './agent-actions'
import {
  HUDDLE_CALLS_CHANNEL,
  HUDDLE_CALL_CATEGORY,
  huddleCallActionFrom,
  huddleCallCategoryActions,
  type HuddleCallAction,
} from './huddle-call-actions'
import type {
  ChannelNotificationPayload,
  ChatNotificationClickData,
  ChatNotificationPayload,
  NotificationPermissionState,
} from './chat-notifier'
import { lifecycleNotificationKind } from './lifecycle-click'

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

/** Join and Decline on a huddle call alert. */
async function registerHuddleCallCategory() {
  try {
    await Notifications.setNotificationCategoryAsync(HUDDLE_CALL_CATEGORY, huddleCallCategoryActions())
  } catch {
    // Without the category the alert still rings; its buttons just don't show.
  }
}

/** Join or Decline on a huddle call alert: the same actions as the in-app ring. */
async function handleHuddleCallAction(action: HuddleCallAction, notificationId: string | null) {
  if (notificationId) {
    await Notifications.dismissNotificationAsync(notificationId).catch(() => {})
  }
  const ring = {
    huddleId: action.huddleId,
    conversationId: action.conversationId,
    workspaceId: action.workspaceId,
    kind: action.kind,
    from: { userId: '', name: action.callerName, image: null },
  }
  // Loaded late: the ring module sets up the system call screen, which this file should not do at load.
  const ringStore = await import('../huddle-ring')
  if (action.decision === 'join') await ringStore.answerRing(ring)
  else await ringStore.declineRing(ring)
}

function ensureHandler() {
  if (handlerConfigured) return
  handlerConfigured = true
  void registerApprovalCategory()
  void registerHuddleCallCategory()
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
    // Incoming huddle calls ring like a phone call: top importance, sound and vibration.
    await Notifications.setNotificationChannelAsync(HUDDLE_CALLS_CHANNEL, {
      name: 'Huddle calls',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      vibrationPattern: [0, 500, 250, 500],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    })
  } catch {
    // Channel setup is best-effort.
  }
}

export async function isUserInactive(): Promise<boolean> {
  return AppState.currentState !== 'active'
}

/** Phones have no dock or taskbar to flag; the notification itself is the attention. */
export async function requestAttention(_reason: string | null | undefined): Promise<void> {}

// Only a grant is cached: a denial can be reversed in iOS Settings while the
// app is running, so it has to be checked again next time.
let permissionGranted = false
const permissionGrantedListeners = new Set<() => void>()

/** Called whenever permission turns out to be granted, e.g. after the user allows it in Settings. */
export function subscribeNotificationPermissionGranted(listener: () => void): () => void {
  permissionGrantedListeners.add(listener)
  return () => permissionGrantedListeners.delete(listener)
}

async function markGranted() {
  await ensureAndroidChannel()
  if (permissionGranted) return
  permissionGranted = true
  permissionGrantedListeners.forEach((l) => l())
}

async function requestPermission(): Promise<boolean> {
  const next = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowSound: true,
      allowBadge: false,
    },
  })
  if (next.granted) await markGranted()
  return next.granted
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionGranted) return true
  try {
    const current = await Notifications.getPermissionsAsync()
    if (current.granted) {
      await markGranted()
      return true
    }
    if (!current.canAskAgain) {
      console.warn('[notifications] Permission denied; it can only be turned on in Settings')
      return false
    }
    const granted = await requestPermission()
    if (!granted) console.warn('[notifications] Permission request was declined')
    return granted
  } catch (err) {
    console.warn('[notifications] Permission check failed:', (err as Error).message)
    return false
  }
}

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  try {
    const current = await Notifications.getPermissionsAsync()
    if (current.granted) {
      await markGranted()
      return 'granted'
    }
    permissionGranted = false
    return current.canAskAgain ? 'prompt' : 'denied'
  } catch {
    return 'unsupported'
  }
}

export async function requestNotificationPermissionFromGesture(): Promise<NotificationPermissionState> {
  const state = await getNotificationPermissionState()
  if (state !== 'prompt') return state
  try {
    return (await requestPermission()) ? 'granted' : await getNotificationPermissionState()
  } catch {
    return 'unsupported'
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

export function parseClickData(raw: unknown): ChatNotificationClickData | null {
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
  // A lifecycle nudge (build that finished while away, usage limit that came
  // back) names `type` and a project — the chat to resume is the one the server
  // knew, or (credits-reset) the project's most recently active one, which the
  // project screen already opens by default. Handled before the generic
  // session pair below, which would otherwise drop `type` (SHO-266).
  const lifecycle = lifecycleNotificationKind(data.type)
  if (lifecycle && typeof data.projectId === 'string' && data.projectId) {
    return {
      projectId: data.projectId,
      sessionId: typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null,
      lifecycle,
    }
  }
  if (typeof data.sessionId === 'string' && typeof data.projectId === 'string') {
    return { sessionId: data.sessionId, projectId: data.projectId }
  }
  // Any other notification with an in-app destination (an invitation, a due
  // reminder) carries it as an app-relative path. Absolute URLs are not
  // followed here: only the agent deep link above is a known destination.
  if (typeof data.actionUrl === 'string' && data.actionUrl.startsWith('/')) {
    return { actionUrl: data.actionUrl }
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
        title: alertTitleFor(p.reason, p.title),
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
    const call = huddleCallActionFrom(response)
    if (call) {
      void handleHuddleCallAction(call, response.notification.request.identifier)
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
    // A press on Join or Decline of a huddle call alert opened the app: act on it, don't open a chat.
    const call = huddleCallActionFrom(resp)
    if (call) {
      await Notifications.clearLastNotificationResponseAsync().catch(() => {})
      void handleHuddleCallAction(call, resp?.notification.request.identifier ?? null)
      return null
    }
    return parseClickData(resp?.notification.request.content.data)
  } catch {
    // ignore
  }
  return null
}
