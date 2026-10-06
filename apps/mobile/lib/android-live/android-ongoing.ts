// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Posts the ongoing notification with expo-notifications; a fixed id makes each post replace the last. */
import * as Notifications from 'expo-notifications'
import { createOngoingSink, type OngoingNotifier } from './ongoing-controller'
import { ONGOING_ID, type OngoingContent } from './ongoing-plan'

const CHANNEL_ID = 'agent-live'
let channelReady = false

async function ensureChannel() {
  if (channelReady) return
  channelReady = true
  // Low importance: no sound or pop-up. The push is the loud alert; this stays put.
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Agents at work',
    description: 'Shows which agents are working or waiting on you',
    importance: Notifications.AndroidImportance.LOW,
    showBadge: false,
  })
}

const notifier: OngoingNotifier = {
  async present(content: OngoingContent) {
    await ensureChannel()
    await Notifications.scheduleNotificationAsync({
      identifier: ONGOING_ID,
      content: {
        title: content.title,
        body: content.body,
        color: content.color,
        data: content.data,
        sticky: true,
        autoDismiss: false,
        priority: Notifications.AndroidNotificationPriority.LOW,
        ...(content.categoryId ? { categoryIdentifier: content.categoryId } : {}),
      },
      trigger: { channelId: CHANNEL_ID },
    })
  },
  async clear() {
    await Notifications.dismissNotificationAsync(ONGOING_ID)
  },
}

export const ongoingSink = createOngoingSink(notifier)
