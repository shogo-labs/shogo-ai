// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Catch-all route for the integrations OAuth callback deep link.
 *
 * On Android, the JS redirect from the callback page opens the app via intent
 * rather than through openAuthSessionAsync's interception. This route prevents
 * the "Unmatched Route" error by redirecting back to the originating project.
 * The ConnectToolWidget's on-mount check will detect the active connection
 * and send the confirmation message to the agent.
 */
import { useEffect } from "react"
import { ActivityIndicator, Text, View } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import { SafeAreaView } from "react-native-safe-area-context"

export default function IntegrationsCallback() {
  const router = useRouter()
  const { projectId } = useLocalSearchParams<{ projectId?: string }>()
  const destination = projectId
    ? `/(app)/projects/${projectId}?fromOAuth=1`
    : "/"

  useEffect(() => {
    router.replace(destination as never)
  }, [destination, router])

  return (
    <SafeAreaView className="flex-1 bg-muted/20">
      <View className="flex-1 items-center justify-center px-6">
        <View className="w-full max-w-sm rounded-2xl border border-border/80 bg-card p-6">
          <View className="mb-5 h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
            <ActivityIndicator color="#e27927" />
          </View>
          <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-primary">
            Integration
          </Text>
          <Text className="mt-1 text-xl font-semibold tracking-tight text-foreground">
            Finishing connection
          </Text>
          <Text className="mt-2 text-sm leading-5 text-muted-foreground">
            Your connection is being verified. You’ll return to your workspace automatically.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  )
}
