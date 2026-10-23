// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Catch-all for any path the app does not serve.
 *
 * Without this file expo-router renders its bare "Unmatched Route" developer
 * screen, which is what an emailed link with no matching page looked like in
 * production (SHO-83). nginx serves `index.html` for unknown paths, so this
 * screen is what a stale or mistyped link gets on web — and the same on native.
 */
import { View, Text } from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { FileQuestion } from 'lucide-react-native'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../contexts/auth'

export default function NotFoundScreen() {
  const router = useRouter()
  const { isAuthenticated } = useAuth()

  const goToDashboard = () => router.replace('/')
  const goToSignIn = () => router.replace('/(auth)/sign-in' as never)

  return (
    <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
      <View className="w-full max-w-sm rounded-xl border border-border bg-card p-8 items-center" style={{ gap: 24 }}>
        <View className="h-16 w-16 rounded-full bg-muted items-center justify-center">
          <FileQuestion size={32} className="text-muted-foreground" />
        </View>

        <View className="items-center" style={{ gap: 8 }}>
          <Text className="text-xl font-semibold text-foreground text-center">
            This link doesn't exist or has expired
          </Text>
          <Text className="text-muted-foreground text-center">
            Check the address, or head back to the app and pick up where you left off.
          </Text>
        </View>

        <View className="w-full" style={{ gap: 12 }}>
          <Button className="w-full" onPress={goToDashboard}>
            Go to dashboard
          </Button>
          {!isAuthenticated ? (
            <Button variant="ghost" className="w-full" onPress={goToSignIn}>
              Sign in
            </Button>
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  )
}
