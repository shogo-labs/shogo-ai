// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle pushes that arrive while the app is in the background or closed.
 * Android delivers `huddle-ring` as a data-only push, which puts the call on the
 * system call screen even when the app is not running. `huddle-ring-cancel`
 * (sent on answer, decline, end, or timeout) takes it off again. iOS calls come
 * over PushKit (see `native-call.native.ts`); its cancel push also arrives here.
 *
 * Imported from the app entry (`index.js`), so the task exists before React mounts.
 */
import * as Notifications from 'expo-notifications'
import * as TaskManager from 'expo-task-manager'
import { endNativeCall, showNativeIncomingCall } from './native-call'
import { ringFromPushData } from './native-call-payload'

export const HUDDLE_BACKGROUND_TASK = 'shogo-huddle-background'

/** The push's data keys. Headless deliveries carry them as a JSON string in `dataString`. */
function pushDataFrom(payload: Notifications.NotificationTaskPayload): Record<string, unknown> | null {
  if ('actionIdentifier' in payload) return null
  const raw = (payload.data ?? {}) as Record<string, unknown>
  if (typeof raw.dataString === 'string') {
    try {
      return JSON.parse(raw.dataString) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return raw
}

/** Takes down the call alert for a huddle that is over, if one is still in the tray. */
async function clearHuddleAlerts(huddleId: string): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync().catch(() => [])
  for (const n of presented) {
    const data = (n.request.content.data ?? {}) as Record<string, unknown>
    if (data.huddleId === huddleId) await Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {})
  }
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(HUDDLE_BACKGROUND_TASK, async ({ data, error }) => {
  if (error) return Notifications.BackgroundNotificationTaskResult.Failed
  const push = pushDataFrom(data)
  if (!push) return Notifications.BackgroundNotificationTaskResult.NoData

  if (push.type === 'huddle-ring') {
    const ring = ringFromPushData(push)
    if (!ring) return Notifications.BackgroundNotificationTaskResult.Failed
    showNativeIncomingCall(ring)
    return Notifications.BackgroundNotificationTaskResult.NewData
  }
  if (push.type === 'huddle-ring-cancel' && typeof push.huddleId === 'string') {
    endNativeCall(push.huddleId, 'remote_ended')
    await clearHuddleAlerts(push.huddleId)
    return Notifications.BackgroundNotificationTaskResult.NewData
  }
  return Notifications.BackgroundNotificationTaskResult.NoData
})

void Notifications.registerTaskAsync(HUDDLE_BACKGROUND_TASK).catch((err: unknown) => {
  console.warn('[Huddles] background push task unavailable:', (err as Error).message)
})
