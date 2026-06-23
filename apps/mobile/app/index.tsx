// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useMemo, useRef } from 'react'
import { ActivityIndicator, Platform, View } from 'react-native'
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
  const isIdeEmbed = useMemo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('embed') === 'ide'
  }, [])

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

  if (isIdeEmbed && platformConfig.localMode && !isAuthenticated) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (platformConfig.localMode && platformConfig.needsSetup && !isAuthenticated) {
    return <Redirect href="/(onboarding)" />
  }

  if (isAuthenticated) {
    if (!isIdeEmbed && onboardingCompleted === false) {
      return <Redirect href="/(onboarding)" />
    }
    if (!isIdeEmbed && platformConfig.localMode && platformConfig.needsSetup) {
      return <Redirect href="/(admin)" />
    }
    return <Redirect href="/(app)" />
  }

  if (platformConfig.localMode) {
    return <Redirect href="/(onboarding)" />
  }

  return <Redirect href="/(auth)/sign-in" />
}
