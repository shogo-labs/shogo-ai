// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An inline prompt, shown in team chat, to allow browser alerts after the first
 * direct message or mention arrives while the person is elsewhere. Web only:
 * phones and the desktop app have their own permission flow.
 */
import { useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { requestNotificationPermissionFromGesture } from '../../lib/notifications/chat-notifier'
import {
  dismissPermissionNudge,
  shouldShowPermissionNudge,
  usePermissionNudgeState,
} from '../../lib/notifications/permission-nudge'

function browserPermission(): string | null {
  if (typeof window === 'undefined' || !('Notification' in window)) return null
  return Notification.permission
}

export function ChatPermissionNudge() {
  const nudge = usePermissionNudgeState()
  const [permission, setPermission] = useState<string | null>(browserPermission)
  if (Platform.OS !== 'web') return null
  if (!shouldShowPermissionNudge(permission) || nudge.dismissed) return null

  const turnOn = async () => {
    await requestNotificationPermissionFromGesture()
    setPermission(browserPermission())
  }

  return (
    <View
      testID="chat-permission-nudge"
      accessibilityRole="alert"
      className="mx-4 mt-2 flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
    >
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">Turn on desktop alerts</Text>
        <Text className="text-xs text-muted-foreground">Get an alert for direct messages and mentions while this tab is in the background.</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={() => dismissPermissionNudge()} className="rounded-md px-3 py-1.5 active:bg-muted">
        <Text className="text-xs font-medium text-muted-foreground">Not now</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => void turnOn()} className="rounded-md bg-primary px-3 py-1.5 active:opacity-80">
        <Text className="text-xs font-medium text-primary-foreground">Turn on</Text>
      </Pressable>
    </View>
  )
}
