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

    const resp = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    })

    if (!resp.ok) {
      console.error(`[Push] Expo push failed: HTTP ${resp.status}`)
    }
  } catch (err) {
    console.error('[Push] Error sending push notification:', (err as Error).message)
  }
}
