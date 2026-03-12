// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { type ReactNode, useEffect, useRef } from 'react'
import { Platform } from 'react-native'
import { PostHogProvider as PHProvider, usePostHog } from 'posthog-react-native'
import { useAuth } from './auth'

const apiKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
const isWeb = Platform.OS === 'web'

export function PostHogProvider({ children }: { children: ReactNode }) {
  if (!apiKey) return <>{children}</>

  return (
    <PHProvider
      apiKey={apiKey}
      options={{
        host,
        captureAppLifecycleEvents: !isWeb,
      }}
      autocapture={{
        captureScreens: false,
        captureTouches: !isWeb,
      }}
    >
      {children}
    </PHProvider>
  )
}

/**
 * Safe wrapper around usePostHog that returns null when PostHog is not
 * configured (EXPO_PUBLIC_POSTHOG_API_KEY unset). apiKey is a module-level
 * constant so the branch is stable across all renders.
 */
// eslint-disable-next-line react-hooks/rules-of-hooks -- apiKey is a module constant; branch never changes
export const usePostHogSafe = apiKey
  ? usePostHog
  : () => null

export function usePostHogIdentify() {
  const posthog = usePostHogSafe()
  const { user, isAuthenticated } = useAuth()
  const prevUserId = useRef<string | null>(null)

  useEffect(() => {
    if (!posthog) return
    if (isAuthenticated && user?.id && user.id !== prevUserId.current) {
      posthog.identify(user.id, { email: user.email, name: user.name })
      posthog.register({ platform: Platform.OS })
      prevUserId.current = user.id
    } else if (!isAuthenticated && prevUserId.current) {
      posthog.reset()
      prevUserId.current = null
    }
  }, [isAuthenticated, user?.id, posthog])
}
