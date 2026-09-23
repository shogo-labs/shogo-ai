// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect } from 'react'
import { Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MonitorSmartphone } from 'lucide-react-native'

/**
 * Legacy /remote-control route — redirects to Settings > Remote Control tab.
 * Kept as a redirect so existing bookmarks and links still work.
 */
export default function RemoteControlRedirect() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/(app)/settings?tab=remote-control' as any)
  }, [router])

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'left', 'right']}>
      <View className="flex-1 items-center justify-center px-8">
        <View className="mb-4 h-14 w-14 items-center justify-center rounded-2xl border border-orange-500/20 bg-orange-500/10">
          <MonitorSmartphone size={25} className="text-orange-600 dark:text-orange-300" />
        </View>
        <Text className="text-lg font-semibold text-foreground">Remote control</Text>
        <Text className="mt-1 text-center text-sm leading-5 text-muted-foreground">
          Opening your connection settings…
        </Text>
      </View>
    </SafeAreaView>
  )
}
