// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useMemo, useRef } from 'react'
import { ActivityIndicator, Platform, View } from 'react-native'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../contexts/auth'
import { usePlatformConfig } from '../lib/platform-config'
import { API_URL } from '../lib/api'
import { autoSignInLocally } from '../lib/auth-client'
import { appRedirectHref } from '../lib/root-redirect'

export default function RootIndex() {
  const { isAuthenticated, isLoading: authLoading, refreshSession } = useAuth()
  const platformConfig = usePlatformConfig()
  // `/` is the front door for every full page load, and the query string is
  // part of the destination: `?chatSessionId=X` is how the workspace agent chat
  // makes a reload, a second tab or Back reopen the running chat (SHO-300).
  const rootParams = useLocalSearchParams()
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
    autoSignInLocally()
      .then(refreshSession)
      .catch((err) => console.error('[LocalMode] Auto-sign-in failed:', err))
      .finally(() => setAutoSigningIn(false))
  }, [platformConfig.configLoaded, platformConfig.localMode, isAuthenticated, authLoading, refreshSession])

  useEffect(() => {
    if (!isAuthenticated || authLoading) return
    setCheckingOnboarding(true)
    fetch(`${API_URL}/api/me`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: any) => {
        // Only a well-formed `false` sends the user to onboarding; anything
        // else (error body, missing field) fails open like a network error.
        setOnboardingCompleted(data?.data?.onboardingCompleted !== false)
      })
      .catch(() => setOnboardingCompleted(true))
      .finally(() => setCheckingOnboarding(false))
  }, [isAuthenticated, authLoading])

  // Wait for platform config to load from the API
  const onboardingUnknown = isAuthenticated && onboardingCompleted === null
  if (!platformConfig.configLoaded || authLoading || checkingOnboarding || autoSigningIn || onboardingUnknown) {
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
    return <Redirect href={appRedirectHref(rootParams)} />
  }

  if (platformConfig.localMode) {
    return <Redirect href="/(onboarding)" />
  }

  return <Redirect href="/(auth)/sign-in" />
}
