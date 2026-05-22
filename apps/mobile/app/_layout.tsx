// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import '../polyfills'
import '../lib/devtools'
import '../global.css'
import '../lib/icon-interop'

import { useEffect } from 'react'
import { Platform } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme } from 'react-native'
import * as Sentry from '@sentry/react-native'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { AuthProvider } from '../contexts/auth'
import { ActiveInstanceProvider } from '../contexts/active-instance'
import { InstanceOfflineWatcher } from '../components/instance/InstanceOfflineWatcher'
import { PostHogProvider } from '../contexts/posthog'
import { ThemeProvider, useTheme } from '../contexts/theme'
import { AccentThemeProvider } from '../contexts/accent-theme'
import { RootErrorBoundary } from '../components/RootErrorBoundary'
import { UpdateBanner } from '../components/UpdateBanner'
import { captureAttribution } from '../lib/attribution'
import { safeSetItem } from '../lib/safe-storage'

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: process.env.EXPO_PUBLIC_APP_ENV || 'development',
  release: process.env.EXPO_PUBLIC_BUILD_HASH || 'dev',
  tracesSampleRate: 0.2,
  enabled: !!process.env.EXPO_PUBLIC_SENTRY_DSN,
  // Drop unhandled promise rejections whose "reason" was a non-Error value
  // (e.g. `Promise.reject(new Event(...))` from third-party libs, or string
  // rejections from Stripe / posthog). They show up in Sentry as a single
  // empty `<unknown>` issue with no stack trace, no breadcrumbs that we
  // can act on, and just inflate the issue count. If a real bug ever
  // rejects with a non-Error, we'll still see breadcrumbs / network in
  // adjacent issues.
  beforeSend(event, hint) {
    const reason = hint?.originalException as unknown
    const isPlainEventReason =
      typeof reason !== 'undefined' &&
      reason !== null &&
      !(reason instanceof Error) &&
      typeof (reason as { stack?: unknown }).stack !== 'string'
    const hasUsableStack = !!event.exception?.values?.some(
      (v) => (v.stacktrace?.frames?.length ?? 0) > 0,
    )
    if (isPlainEventReason && !hasUsableStack) return null
    return event
  },
})

const PENDING_TEMPLATE_KEY = 'pending_template_id'
const PENDING_APP_TEMPLATE_KEY = 'pending_app_template'

function useCaptureTemplateDeepLink() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const templateId = params.get('template')
    if (templateId) {
      safeSetItem(PENDING_TEMPLATE_KEY, templateId)
      params.delete('template')
    }
    const appTemplateName = params.get('app_template')
    if (appTemplateName) {
      safeSetItem(PENDING_APP_TEMPLATE_KEY, appTemplateName)
      params.delete('app_template')
    }
    if (templateId || appTemplateName) {
      const qs = params.toString()
      const clean = window.location.pathname + (qs ? `?${qs}` : '')
      window.history.replaceState({}, '', clean)
    }
  }, [])
}

function RootLayoutInner() {
  useEffect(() => { captureAttribution() }, [])
  useCaptureTemplateDeepLink()
  const systemColorScheme = useColorScheme()
  const { theme, isLoaded } = useTheme()

  const statusBarScheme = theme === 'system'
    ? (systemColorScheme === 'dark' ? 'dark' : 'light')
    : theme

  if (!isLoaded) return null

  return (
    <GluestackUIProvider mode={theme}>
      <PostHogProvider>
        <AuthProvider>
          <ActiveInstanceProvider>
            <InstanceOfflineWatcher />
            <UpdateBanner />
            <StatusBar style={statusBarScheme === 'dark' ? 'light' : 'dark'} />
            <Stack screenOptions={{ headerShown: false, lazy: true }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="(onboarding)" />
              <Stack.Screen name="(app)" />
              <Stack.Screen name="(admin)" />
            </Stack>
          </ActiveInstanceProvider>
        </AuthProvider>
      </PostHogProvider>
    </GluestackUIProvider>
  )
}

function RootLayout() {
  return (
    <RootErrorBoundary>
      <ThemeProvider>
        <AccentThemeProvider>
          <RootLayoutInner />
        </AccentThemeProvider>
      </ThemeProvider>
    </RootErrorBoundary>
  )
}

export default Sentry.wrap(RootLayout)
