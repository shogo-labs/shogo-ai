// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Stack, Redirect, useSegments } from 'expo-router'
import { useAuth } from '../../contexts/auth'
import { usePlatformConfig } from '../../lib/platform-config'

export default function AuthLayout() {
  const { isAuthenticated, isLoading } = useAuth()
  const { localMode, configLoaded } = usePlatformConfig()
  const segments = useSegments()
  const isResetPassword = segments.includes('reset-password')
  const isVerifyEmail = segments.includes('verify-email')

  if (configLoaded && localMode) {
    return <Redirect href="/" />
  }

  if (!isLoading && isAuthenticated && !isResetPassword && !isVerifyEmail) {
    return <Redirect href="/(app)" />
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
