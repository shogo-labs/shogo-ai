// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * /sign-out — Direct sign-out route.
 *
 * Navigating to /sign-out signs the user out immediately and redirects to
 * the sign-in screen. This provides a reliable fallback path that avoids
 * the need to discover the avatar popover in the sidebar.
 */
import { useEffect } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { useAuth } from '../contexts/auth'

export default function SignOutScreen() {
  const { signOut } = useAuth()
  const router = useRouter()

  useEffect(() => {
    signOut()
      .catch(() => {})
      .finally(() => {
        router.replace('/sign-in' as any)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ActivityIndicator />
    </View>
  )
}
