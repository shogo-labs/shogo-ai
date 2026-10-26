// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Asks the browser for notification permission from a click. Browsers ignore
 * or hide prompts that aren't triggered by the user, so without this the
 * permission stays undecided and every web alert is dropped.
 */
import { useEffect, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

import { useNotificationPermission } from '../../lib/notifications/useNotificationPermission'

const DISMISSED_KEY = 'shogo:notification-banner-dismissed'

export function NotificationPermissionBanner() {
  const { state, request } = useNotificationPermission()
  const [dismissed, setDismissed] = useState<boolean | null>(null)

  useEffect(() => {
    void AsyncStorage.getItem(DISMISSED_KEY)
      .then((v) => setDismissed(v === 'true'))
      .catch(() => setDismissed(false))
  }, [])

  if (Platform.OS !== 'web' || state !== 'prompt' || dismissed !== false) return null

  const dismiss = () => {
    setDismissed(true)
    void AsyncStorage.setItem(DISMISSED_KEY, 'true').catch(() => {})
  }

  return (
    <View
      className="absolute bottom-4 right-4 z-50 max-w-[340px] rounded-lg border border-border bg-card p-4 shadow-lg"
      style={{ position: 'fixed' as any }}
    >
      <Text className="text-sm font-semibold text-foreground">Turn on notifications</Text>
      <Text className="mt-1 text-xs text-muted-foreground">
        Get an alert when an agent finishes, needs your approval, or someone mentions you.
      </Text>
      <View className="mt-3 flex-row justify-end gap-2">
        <Pressable onPress={dismiss} className="rounded-md px-3 py-1.5 active:bg-muted">
          <Text className="text-xs font-medium text-muted-foreground">Not now</Text>
        </Pressable>
        <Pressable onPress={() => void request()} className="rounded-md bg-primary px-3 py-1.5 active:opacity-80">
          <Text className="text-xs font-medium text-primary-foreground">Turn on</Text>
        </Pressable>
      </View>
    </View>
  )
}
