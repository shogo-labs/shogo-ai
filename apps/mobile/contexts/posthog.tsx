// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { type ReactNode, useEffect, useRef } from 'react'
import { Platform } from 'react-native'
import { PostHogProvider as PHProvider, usePostHog } from 'posthog-react-native'
import type PostHog from 'posthog-react-native'
import { useAuth } from './auth'
import { getActiveEnvKey, telemetryEnvFor } from '../lib/env-override'
import { getRuntimeAppEnv } from '../lib/runtime-env'

const apiKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
const appEnv = telemetryEnvFor(getActiveEnvKey(), getRuntimeAppEnv())
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

/**
 * The last PostHog client the app shell rendered, readable without React
 * context.
 *
 * `ChatPanel` also renders inside popover portals whose host is mounted above
 * this provider, so a `usePostHog` there can throw and take the shell down.
 * `usePostHogIdentify` (mounted once by `(app)/_layout`) publishes the client
 * here instead, the same way `AuthProvider` publishes `getAuthUserSnapshot()`.
 */
let modulePostHog: PostHog | null = null

export function getPostHogSnapshot(): PostHog | null {
  return modulePostHog
}

export function usePostHogIdentify() {
  const posthog = usePostHogSafe()
  // Publish the client for surfaces that render outside this provider (a
  // Gluestack portal host sits above it), so they can capture without a hook.
  modulePostHog = posthog
  const { user, isAuthenticated } = useAuth()
  const prevUserId = useRef<string | null>(null)

  useEffect(() => {
    if (!posthog) return
    if (isAuthenticated && user?.id && user.id !== prevUserId.current) {
      posthog.identify(user.id, { email: user.email, name: user.name })
      posthog.register({ platform: Platform.OS, environment: appEnv })
      prevUserId.current = user.id
    } else if (!isAuthenticated && prevUserId.current) {
      posthog.reset()
      prevUserId.current = null
    }
  }, [isAuthenticated, user?.id, posthog])
}
