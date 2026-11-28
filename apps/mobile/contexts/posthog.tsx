// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { type ReactNode, useEffect, useRef } from 'react'
import { Platform } from 'react-native'
import { PostHogProvider as PHProvider, usePostHog } from 'posthog-react-native'
import { useAuth } from './auth'
import { getActiveEnvKey, telemetryEnvFor } from '../lib/env-override'
import { getRuntimeAppEnv } from '../lib/runtime-env'
import { getWebsitePosthogDistinctId, markPosthogAliased } from '../lib/attribution'

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

export function usePostHogIdentify() {
  const posthog = usePostHogSafe()
  const { user, isAuthenticated } = useAuth()
  const prevUserId = useRef<string | null>(null)

  useEffect(() => {
    if (!posthog) return
    if (isAuthenticated && user?.id && user.id !== prevUserId.current) {
      // The website's anonymous PostHog id, carried on the studio link as
      // `ph_did` (SHO-611). Aliasing it onto the account is what joins the
      // website funnel to the app's; a fresh `identify` alone leaves two
      // strangers in one funnel. Once per browser, web only, and a no-op
      // without a PostHog key.
      if (isWeb) {
        try {
          const websiteId = getWebsitePosthogDistinctId()
          if (websiteId && websiteId !== posthog.getDistinctId() && markPosthogAliased(websiteId)) {
            posthog.alias(websiteId)
          }
        } catch {
          // Analytics must never block sign-in.
        }
      }
      posthog.identify(user.id, { email: user.email, name: user.name })
      posthog.register({ platform: Platform.OS, environment: appEnv })
      prevUserId.current = user.id
    } else if (!isAuthenticated && prevUserId.current) {
      posthog.reset()
      prevUserId.current = null
    }
  }, [isAuthenticated, user?.id, posthog])
}
