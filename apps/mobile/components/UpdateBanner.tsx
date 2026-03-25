// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View, Text, Pressable, Platform } from 'react-native'
import { useUpdateChecker } from '@/lib/use-update-checker'
import { X } from 'lucide-react-native'

export function UpdateBanner() {
  const { updateAvailable, dismiss } = useUpdateChecker()

  if (!updateAvailable || Platform.OS !== 'web') return null

  return (
    <View className="flex-row items-center justify-center gap-3 bg-primary px-4 py-2.5">
      <Text className="text-sm font-medium text-primary-foreground">
        A new version is available.
      </Text>
      <Pressable
        onPress={() => {
          if (typeof window !== 'undefined') window.location.reload()
        }}
        className="rounded-md bg-primary-foreground/20 px-3 py-1"
      >
        <Text className="text-sm font-semibold text-primary-foreground">
          Refresh
        </Text>
      </Pressable>
      <Pressable onPress={dismiss} className="ml-auto p-1">
        <X size={16} className="text-primary-foreground" />
      </Pressable>
    </View>
  )
}
