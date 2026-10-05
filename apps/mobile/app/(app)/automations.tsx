// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'

/**
 * /automations[?workspace=<id>] — a linkable address for Settings >
 * Automations (`/settings` on web also matches the admin console, so the tab
 * can't be deep-linked there directly).
 */
export default function AutomationsRedirect() {
  const router = useRouter()
  const { workspace } = useLocalSearchParams<{ workspace?: string }>()

  useEffect(() => {
    const suffix = workspace ? `&workspace=${encodeURIComponent(workspace)}` : ''
    router.replace(`/(app)/settings?tab=automations${suffix}` as any)
  }, [router, workspace])

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ActivityIndicator />
    </View>
  )
}
