// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { Redirect, Slot } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import { DomainProvider } from '../../contexts/domain'
import { usePlatformConfig } from '../../lib/platform-config'
import { API_URL } from '../../lib/api'

export default function OnboardingLayout() {
  const { isAuthenticated, isLoading, refreshSession } = useAuth()
  const { localMode, configLoaded } = usePlatformConfig()
  const autoSignInAttempted = useRef(false)
  const [autoSigningIn, setAutoSigningIn] = useState(false)
  const [autoSignInError, setAutoSignInError] = useState<string | null>(null)

  const attemptAutoSignIn = useCallback(() => {
    autoSignInAttempted.current = true
    setAutoSignInError(null)
    setAutoSigningIn(true)
    fetch(`${API_URL}/api/local/auto-sign-in`, {
      method: 'POST',
      credentials: 'include',
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Auto-sign-in returned ${res.status}`)
        return refreshSession()
      })
      .catch((err) => {
        console.error('[LocalMode] Auto-sign-in failed:', err)
        setAutoSignInError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setAutoSigningIn(false))
  }, [refreshSession])

  useEffect(() => {
    if (!configLoaded || !localMode || isLoading || isAuthenticated || autoSignInAttempted.current) {
      return
    }
    attemptAutoSignIn()
  }, [configLoaded, localMode, isAuthenticated, isLoading, attemptAutoSignIn])

  // Cloud requires an existing account; local mode signs in the seeded user
  // here before mounting the shared onboarding flow.
  if (configLoaded && !localMode && !isLoading && !isAuthenticated) {
    return <Redirect href="/(auth)/sign-in" />
  }

  if (configLoaded && localMode && !isAuthenticated) {
    // Onboarding needs a user; without one it would spin forever.
    if (autoSignInAttempted.current && !autoSigningIn && !isLoading) {
      return (
        <View className="flex-1 items-center justify-center bg-background px-6">
          <View className="w-full max-w-sm items-center gap-4">
            <Text className="text-center text-base font-semibold text-foreground">
              Couldn't sign in to Shogo on this machine
            </Text>
            <Text className="text-center text-sm leading-5 text-muted-foreground">
              {autoSignInError
                ? `The local server didn't accept the sign-in (${autoSignInError}).`
                : "The local server didn't return a session."}{' '}
              Make sure Shogo is running, then try again.
            </Text>
            <Button size="lg" className="w-full rounded-xl" onPress={attemptAutoSignIn}>
              Try again
            </Button>
          </View>
        </View>
      )
    }
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="small" />
      </View>
    )
  }

  return (
    <DomainProvider>
      <SafeAreaView className="flex-1 bg-background">
        <Slot />
      </SafeAreaView>
    </DomainProvider>
  )
}
