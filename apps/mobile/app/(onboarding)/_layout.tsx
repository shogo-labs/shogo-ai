// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { Redirect, Slot } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { DomainProvider } from '../../contexts/domain'
import { usePlatformConfig } from '../../lib/platform-config'
import { API_URL } from '../../lib/api'

export default function OnboardingLayout() {
  const { isAuthenticated, isLoading, refreshSession } = useAuth()
  const { localMode, configLoaded } = usePlatformConfig()
  const autoSignInAttempted = useRef(false)
  const [autoSigningIn, setAutoSigningIn] = useState(false)

  useEffect(() => {
    if (!configLoaded || !localMode || isLoading || isAuthenticated || autoSignInAttempted.current) {
      return
    }
    autoSignInAttempted.current = true
    setAutoSigningIn(true)
    fetch(`${API_URL}/api/local/auto-sign-in`, {
      method: 'POST',
      credentials: 'include',
    })
      .then(() => refreshSession())
      .catch((err) => console.error('[LocalMode] Auto-sign-in failed:', err))
      .finally(() => setAutoSigningIn(false))
  }, [configLoaded, localMode, isAuthenticated, isLoading, refreshSession])

  // Cloud requires an existing account; local mode signs in the seeded user
  // here before mounting the shared onboarding flow.
  if (configLoaded && !localMode && !isLoading && !isAuthenticated) {
    return <Redirect href="/(auth)/sign-in" />
  }

  if (configLoaded && localMode && !isAuthenticated && (autoSigningIn || !autoSignInAttempted.current)) {
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
