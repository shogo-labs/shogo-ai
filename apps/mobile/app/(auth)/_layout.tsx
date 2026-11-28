// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useMemo } from 'react'
import { Stack, Redirect, useGlobalSearchParams, useSegments } from 'expo-router'
import { useAuth } from '../../contexts/auth'
import { usePlatformConfig } from '../../lib/platform-config'
import { loadCometlyPixel } from '../../lib/cometly'
import { captureLearnReturn } from '../../lib/learn-return'
import { captureSignupIntent } from '../../lib/signup-intent'

export default function AuthLayout() {
  const { isAuthenticated, isLoading } = useAuth()
  const { localMode, configLoaded } = usePlatformConfig()
  const segments = useSegments()
  const isResetPassword = segments.includes('reset-password')
  const isVerifyEmail = segments.includes('verify-email')
  // Read `?learn_return=` during render, before any redirect below rewrites the
  // URL; the root gate sends the user back to learn.shogo.ai once signed in.
  useMemo(() => captureLearnReturn(), [])
  // Same for the marketing intent (`plan`, `trial`, `prompt`, `utm_*`): it is
  // taken from the URL of the page the visitor actually landed on, and the
  // OAuth/verify round trip then lands back on a URL without it (SHO-613).
  const authParams = useGlobalSearchParams()
  useMemo(() => captureSignupIntent(authParams), [])

  // Cometly (SHO-441): the auth pages are the only place the app loads the
  // pixel — it reads the email/password form itself, and its token is what a
  // Google sign-up hands to the server. Web only; the loader is idempotent.
  useEffect(() => {
    loadCometlyPixel()
  }, [])

  if (configLoaded && localMode) {
    return <Redirect href="/" />
  }

  // Hand off to the root gate rather than `/(app)` so the onboarding check
  // in `app/index.tsx` can't be bypassed.
  if (!isLoading && isAuthenticated && !isResetPassword && !isVerifyEmail) {
    return <Redirect href="/" />
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen
        name="sign-in"
        options={{ contentStyle: { backgroundColor: 'transparent' } }}
      />
      <Stack.Screen name="sign-up" />
      <Stack.Screen name="reset-password" />
      <Stack.Screen name="verify-email" />
    </Stack>
  )
}
