// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { Redirect } from 'expo-router'
import { useAuth } from '../contexts/auth'
import { usePlatformConfig } from '../lib/platform-config'
import { API_URL } from '../lib/api'

export default function RootIndex() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const platformConfig = usePlatformConfig()
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null)
  const [checkingOnboarding, setCheckingOnboarding] = useState(false)

  useEffect(() => {
    if (!isAuthenticated || authLoading) return
    setCheckingOnboarding(true)
    fetch(`${API_URL}/api/me`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: any) => {
        setOnboardingCompleted(data.data?.onboardingCompleted ?? true)
      })
      .catch(() => setOnboardingCompleted(true))
      .finally(() => setCheckingOnboarding(false))
  }, [isAuthenticated, authLoading])

  // Wait for platform config to load from the API
  if (!platformConfig.configLoaded || authLoading || checkingOnboarding) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  // Local mode first launch: no users yet -> onboarding with account creation
  if (platformConfig.localMode && platformConfig.needsSetup) {
    return <Redirect href="/(onboarding)" />
  }

  if (isAuthenticated) {
    if (onboardingCompleted === false) {
      // Local users go straight to super admin to configure
      if (platformConfig.localMode) {
        return <Redirect href="/(admin)" />
      }
      return <Redirect href="/(onboarding)" />
    }
    return <Redirect href="/(app)" />
  }

  return <Redirect href="/(auth)/sign-in" />
}
