// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Push Notification Sender
 *
 * Sends push notifications to Expo push tokens registered for instances.
 * Used primarily for instant WebSocket wakeup — when a remote control
 * session is requested, we push to the desktop app so it can connect
 * immediately rather than waiting for the next poll cycle.
 */

import { prisma } from './prisma'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

interface PushPayload {
  type: string
  priority?: 'high' | 'default'
  instanceId?: string
  [key: string]: unknown
}

interface ExpoPushMessage {
  to: string
  title?: string
  body?: string
  /** Wakes the app in the background without showing anything (iOS `content-available`). */
  _contentAvailable?: boolean
  data?: Record<string, unknown>
  priority?: 'high' | 'default'
  channelId?: string
  /** Notification category registered on the phone; it decides which action buttons show. */
  categoryId?: string
  /** `default` plays the system sound; `null` (or omitted) keeps the push silent. */
  sound?: 'default' | null
  /** Seconds that the push may be retained for redelivery. */
  ttl?: number
}

type InvalidTokenCleanup = (tokens: string[]) => Promise<unknown>

async function deleteMobilePushTokens(tokens: string[]) {
  return prisma.mobilePushSubscription.deleteMany({ where: { pushToken: { in: tokens } } })
}

async function sendExpoMessages(
  messages: ExpoPushMessage[],
  tokensToClean: string[] = [],
  cleanupInvalidTokens: InvalidTokenCleanup = deleteMobilePushTokens,
) {
  const resp = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  })

  if (!resp.ok) {
    console.error(`[Push] Expo push failed: HTTP ${resp.status}`)
    return
  }

  // Expo reports errors per message. Uninstalled devices are removed so future
  // completions stop trying them; anything else (e.g. InvalidCredentials when
  // the APNs key is missing from EAS) is logged, since the push silently never
  // arrives otherwise.
  const payload = typeof resp.json === 'function'
    ? await resp.json().catch(() => null) as { data?: Array<{ status?: string; message?: string; details?: { error?: string } }> } | null
    : null
  const tickets = payload?.data ?? []
  tickets.forEach((ticket, index) => {
    if (ticket.status !== 'error' || ticket.details?.error === 'DeviceNotRegistered') return
    console.error(
      `[Push] Expo rejected message ${index}: ${ticket.details?.error ?? 'unknown'}${ticket.message ? ` - ${ticket.message}` : ''}`,
    )
  })
  const invalidTokens = tickets
    .map((receipt, index) => receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered' ? tokensToClean[index] : null)
    .filter((token): token is string => Boolean(token))
  if (invalidTokens.length > 0) {
    await cleanupInvalidTokens(invalidTokens).catch(() => {})
  }
}

export async function sendPushToInstance(
  instanceId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    const subs = await prisma.pushSubscription.findMany({
      where: { instanceId },
    })

    if (subs.length === 0) return

    const messages: ExpoPushMessage[] = subs.map((sub) => ({
      to: sub.pushToken,
      data: { ...payload, instanceId },
      priority: payload.priority || 'high',
      channelId: 'remote-control',
    }))

    await sendExpoMessages(
      messages,
      subs.map((sub) => sub.pushToken),
      (tokens) => prisma.pushSubscription.deleteMany({ where: { pushToken: { in: tokens } } }),
    )
  } catch (err) {
    console.error('[Push] Error sending push notification:', (err as Error).message)
  }
}

// Default push payload `type` + Android channel id. Existing callers (task
// completion, project-chat turn completion) rely on this value, so it must
// stay the default; callers that need a distinct push (e.g. a due reminder)
// pass `type`/`channelId` explicitly.
const DEFAULT_USER_PUSH_TYPE = 'chat-complete'

export async function sendPushToUser(
  userId: string,
  payload: {
    /** Omitted for `dataOnly` pushes, which never show a banner. */
    title?: string
    body?: string
    data?: Record<string, unknown>
    priority?: 'high' | 'default'
    /** Value written to `data.type` on the push payload. Defaults to `chat-complete`. */
    type?: string
    /** Android notification channel id. Defaults to `chat-complete`. */
    channelId?: string
    /**
     * `agent` (the default: turn and task completions) skips devices that
     * turned those off; `chat` (team chat messages and reminders) goes to
     * every device, since chat has its own levels, mute, and Do Not Disturb.
     */
    audience?: 'agent' | 'chat'
    /** Shows the action buttons of this category on the notification (e.g. `agent-approval`). */
    categoryId?: string
    /** `default` plays the system sound. Omitted or `null` keeps the push silent. */
    sound?: 'default' | null
    /** Seconds that the push may be retained for redelivery. */
    ttl?: number
    /** Only these devices (Expo push tokens). Omitted means every device of the user. */
    pushTokens?: string[]
    /**
     * A silent, data-only push: no banner or sound. The app handles it in the
     * background (Android data message, iOS `content-available`), e.g. to
     * start or cancel a call screen.
     */
    dataOnly?: boolean
  },
): Promise<void> {
  try {
    if (payload.pushTokens && payload.pushTokens.length === 0) return
    const subs = await prisma.mobilePushSubscription.findMany({
      where: {
        userId,
        ...(payload.audience === 'chat' ? {} : { agentTurns: true }),
        ...(payload.pushTokens ? { pushToken: { in: payload.pushTokens } } : {}),
      },
      select: { pushToken: true },
    })
    if (subs.length === 0) return

    const pushType = payload.type || DEFAULT_USER_PUSH_TYPE
    const channelId = payload.channelId || DEFAULT_USER_PUSH_TYPE

    await sendExpoMessages(
      subs.map((sub) => ({
        to: sub.pushToken,
        ...(payload.dataOnly
          ? { _contentAvailable: true }
          : { title: payload.title, body: payload.body }),
        data: { ...(payload.data ?? {}), type: pushType },
        priority: payload.priority ?? 'high',
        channelId,
        ...(payload.categoryId ? { categoryId: payload.categoryId } : {}),
        ...(payload.sound && !payload.dataOnly ? { sound: payload.sound } : {}),
        ...(payload.ttl !== undefined ? { ttl: payload.ttl } : {}),
      })),
      subs.map((sub) => sub.pushToken),
    )
  } catch (err) {
    console.error('[Push] Error sending user push notification:', (err as Error).message)
  }
}
