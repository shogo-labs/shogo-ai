// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * /sign-out — Direct sign-out route.
 *
 * Navigating to /sign-out signs the user out immediately and redirects to
 * the sign-in screen (or root in local mode for auto-re-sign-in).
 */
import { useEffect } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { useAuth } from '../contexts/auth'
import { usePlatformConfig } from '../lib/platform-config'

export default function SignOutScreen() {
  const { signOut } = useAuth()
  const router = useRouter()
  const { localMode } = usePlatformConfig()

  useEffect(() => {
    signOut()
      .catch((e) => console.error('[SignOut] Failed to sign out:', e))
      .finally(() => {
        router.replace(localMode ? '/' : ('/sign-in' as any))
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ActivityIndicator />
    </View>
  )
}
