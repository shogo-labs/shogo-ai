// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useMemo, useRef } from 'react'
import { Platform, View } from 'react-native'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../contexts/auth'
import { usePlatformConfig } from '../lib/platform-config'
import { API_URL } from '../lib/api'
import { autoSignInLocally } from '../lib/auth-client'
import { appRedirectHref, onboardingRedirectHref } from '../lib/root-redirect'
import { peekLearnReturn, resumeLearnReturn } from '../lib/learn-return'
import { readCachedOnboardingCompleted, rememberOnboardingCompleted } from '../lib/auth-session-cache'
import { Spinner } from '@/components/ui/spinner'

export default function RootIndex() {
  const { user, isAuthenticated, isLoading: authLoading, refreshSession } = useAuth()
  const platformConfig = usePlatformConfig()
  // `/` is the front door for every full page load, and the query string is
  // part of the destination: `?chatSessionId=X` is how the workspace agent chat
  // makes a reload, a second tab or Back reopen the running chat (SHO-300), and
  // the sign-up intent (`plan`, `trial`, `prompt`, `utm_*`) has to survive the
  // same hop into onboarding and into the app (SHO-613).
  const rootParams = useLocalSearchParams()
  // The `/api/me` answer this device last saw. With one, the app routes on the
  // first frame; without, the screen waits for the fetch as it always did
  // (SHO-580). The fetch below still runs and still wins.
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(
    () => (user?.id ? readCachedOnboardingCompleted(user.id) : null),
  )
  const onboardingUserId = useRef<string | null>(user?.id ?? null)
  const [autoSigningIn, setAutoSigningIn] = useState(false)
  const autoSignInAttempted = useRef(false)
  // A sign-in that started on learn.shogo.ai goes back there (lib/learn-return).
  // Onboarding is skipped for this hop; it still runs the next time Studio opens.
  const pendingLearnReturn = useMemo(() => peekLearnReturn() !== null, [])
  useEffect(() => {
    if (pendingLearnReturn && isAuthenticated && !authLoading) resumeLearnReturn(API_URL ?? '')
  }, [pendingLearnReturn, isAuthenticated, authLoading])
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
    fetch(`${API_URL}/api/me`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: any) => {
        // Only a well-formed `false` sends the user to onboarding; anything
        // else (error body, missing field) fails open like a network error.
        const completed = data?.data?.onboardingCompleted !== false
        setOnboardingCompleted(completed)
        if (user?.id) rememberOnboardingCompleted(user.id, completed)
      })
      .catch(() => setOnboardingCompleted(true))
  }, [isAuthenticated, authLoading, user?.id])

  // An account switch (a cached user answered by a different one) must not keep
  // the previous account's onboarding answer.
  useEffect(() => {
    if ((user?.id ?? null) === onboardingUserId.current) return
    onboardingUserId.current = user?.id ?? null
    setOnboardingCompleted(user?.id ? readCachedOnboardingCompleted(user.id) : null)
  }, [user?.id])

  // Wait for platform config to load from the API
  const onboardingUnknown = isAuthenticated && onboardingCompleted === null
  // With no cached answer `onboardingUnknown` holds the screen; with one this
  // device is ready to route on its first frame (SHO-580).
  if (!platformConfig.configLoaded || authLoading || autoSigningIn || onboardingUnknown) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Spinner size="large" />
      </View>
    )
  }

  if (isIdeEmbed && platformConfig.localMode && !isAuthenticated) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Spinner size="large" />
      </View>
    )
  }

  if (platformConfig.localMode && platformConfig.needsSetup && !isAuthenticated) {
    return <Redirect href={onboardingRedirectHref(rootParams)} />
  }

  if (isAuthenticated) {
    if (pendingLearnReturn) {
      return (
        <View className="flex-1 items-center justify-center bg-background">
          <Spinner size="large" />
        </View>
      )
    }
    if (!isIdeEmbed && onboardingCompleted === false) {
      return <Redirect href={onboardingRedirectHref(rootParams)} />
    }
    if (!isIdeEmbed && platformConfig.localMode && platformConfig.needsSetup) {
      return <Redirect href="/(admin)" />
    }
    return <Redirect href={appRedirectHref(rootParams)} />
  }

  if (platformConfig.localMode) {
    return <Redirect href={onboardingRedirectHref(rootParams)} />
  }

  return <Redirect href="/(auth)/sign-in" />
}
