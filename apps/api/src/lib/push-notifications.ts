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
  data?: Record<string, unknown>
  priority?: 'high' | 'default'
  channelId?: string
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

  // Expo reports invalid/uninstalled device tokens per message. Remove them
  // so future completions do not keep attempting delivery to dead devices.
  const payload = typeof resp.json === 'function'
    ? await resp.json().catch(() => null) as { data?: Array<{ status?: string; details?: { error?: string } }> } | null
    : null
  const invalidTokens = (payload?.data ?? [])
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

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; data?: Record<string, unknown>; priority?: 'high' | 'default' },
): Promise<void> {
  try {
    const subs = await prisma.mobilePushSubscription.findMany({
      where: { userId },
      select: { pushToken: true },
    })
    if (subs.length === 0) return

    await sendExpoMessages(
      subs.map((sub) => ({
        to: sub.pushToken,
        title: payload.title,
        body: payload.body,
        data: { ...(payload.data ?? {}), type: 'chat-complete' },
        priority: payload.priority ?? 'high',
        channelId: 'chat-complete',
      })),
      subs.map((sub) => sub.pushToken),
    )
  } catch (err) {
    console.error('[Push] Error sending user push notification:', (err as Error).message)
  }
}
