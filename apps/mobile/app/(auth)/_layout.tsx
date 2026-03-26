// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Stack, Redirect, useSegments } from 'expo-router'
import { useAuth } from '../../contexts/auth'

export default function AuthLayout() {
  const { isAuthenticated, isLoading } = useAuth()
  const segments = useSegments()
  const isResetPassword = segments.includes('reset-password')
  const isVerifyEmail = segments.includes('verify-email')

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
