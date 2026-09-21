// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Users } from 'lucide-react-native'

/**
 * Legacy /members route — redirects to Settings > People tab.
 * Kept as a redirect so existing bookmarks and links still work.
 */
export default function MembersRedirect() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/(app)/settings?tab=people' as any)
  }, [router])

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center px-6">
        <View className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
          <View className="mb-5 h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
            <Users size={22} className="text-primary" />
          </View>
          <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-primary">People</Text>
          <Text className="mt-2 text-xl font-semibold tracking-tight text-foreground">Opening workspace members</Text>
          <Text className="mt-2 text-sm leading-5 text-muted-foreground">
            Member management now lives with your workspace settings.
          </Text>
          <View className="mt-5 flex-row items-center gap-2 border-t border-border pt-4">
            <ActivityIndicator size="small" />
            <Text className="text-sm text-muted-foreground">Taking you there…</Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  )
}
