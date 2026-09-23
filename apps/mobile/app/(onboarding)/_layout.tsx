// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Redirect, Slot } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { DomainProvider } from '../../contexts/domain'
import { usePlatformConfig } from '../../lib/platform-config'

export default function OnboardingLayout() {
  const { isAuthenticated, isLoading } = useAuth()
  const { localMode, configLoaded } = usePlatformConfig()

  // Local mode runs onboarding before auto-sign-in completes, so only cloud
  // needs a session here.
  if (configLoaded && !localMode && !isLoading && !isAuthenticated) {
    return <Redirect href="/(auth)/sign-in" />
  }

  return (
    <DomainProvider>
      <SafeAreaView className="flex-1 bg-background">
        <Slot />
      </SafeAreaView>
    </DomainProvider>
  )
}
