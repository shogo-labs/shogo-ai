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

export function usePostHogIdentify() {
  const posthog = usePostHog()
  const { user, isAuthenticated } = useAuth()
  const prevUserId = useRef<string | null>(null)

  useEffect(() => {
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
