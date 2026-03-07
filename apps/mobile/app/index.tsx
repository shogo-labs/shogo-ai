// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useRef } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { Redirect } from 'expo-router'
import { useAuth } from '../contexts/auth'
import { usePlatformConfig } from '../lib/platform-config'
import { API_URL } from '../lib/api'

export default function RootIndex() {
  const { isAuthenticated, isLoading: authLoading, refreshSession } = useAuth()
  const platformConfig = usePlatformConfig()
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null)
  const [checkingOnboarding, setCheckingOnboarding] = useState(false)
  const [autoSigningIn, setAutoSigningIn] = useState(false)
  const autoSignInAttempted = useRef(false)

  // Local mode: auto-sign-in when not authenticated
  useEffect(() => {
    if (!platformConfig.configLoaded || !platformConfig.localMode) return
    if (isAuthenticated || authLoading || autoSignInAttempted.current) return
    autoSignInAttempted.current = true
    setAutoSigningIn(true)
    fetch(`${API_URL}/api/local/auto-sign-in`, {
      method: 'POST',
      credentials: 'include',
    })
      .then(() => refreshSession())
      .catch((err) => console.error('[LocalMode] Auto-sign-in failed:', err))
      .finally(() => setAutoSigningIn(false))
  }, [platformConfig.configLoaded, platformConfig.localMode, isAuthenticated, authLoading, refreshSession])

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
  if (!platformConfig.configLoaded || authLoading || checkingOnboarding || autoSigningIn) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  // Local mode: if authenticated but LLMs not configured, go to admin
  if (platformConfig.localMode && platformConfig.needsSetup && isAuthenticated) {
    return <Redirect href="/(admin)" />
  }

  // Local mode: still no user (seed may not be ready yet) — show onboarding as fallback
  if (platformConfig.localMode && platformConfig.needsSetup) {
    return <Redirect href="/(onboarding)" />
  }

  if (isAuthenticated) {
    if (onboardingCompleted === false) {
      if (platformConfig.localMode) {
        return <Redirect href="/(admin)" />
      }
      return <Redirect href="/(onboarding)" />
    }
    return <Redirect href="/(app)" />
  }

  return <Redirect href="/(auth)/sign-in" />
}
