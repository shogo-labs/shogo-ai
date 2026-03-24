// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import '../polyfills'
import '../global.css'
import '../lib/icon-interop'

import { useEffect } from 'react'
import { Platform } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme } from 'react-native'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { AuthProvider } from '../contexts/auth'
import { PostHogProvider } from '../contexts/posthog'
import { ThemeProvider, useTheme } from '../contexts/theme'
import { RootErrorBoundary } from '../components/RootErrorBoundary'
import { captureAttribution } from '../lib/attribution'

const PENDING_TEMPLATE_KEY = 'pending_template_id'
const PENDING_APP_TEMPLATE_KEY = 'pending_app_template'

function useCaptureTemplateDeepLink() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const templateId = params.get('template')
    if (templateId) {
      localStorage.setItem(PENDING_TEMPLATE_KEY, templateId)
      params.delete('template')
    }
    const appTemplateName = params.get('app_template')
    if (appTemplateName) {
      localStorage.setItem(PENDING_APP_TEMPLATE_KEY, appTemplateName)
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

  const resolvedMode = theme === 'system'
    ? (systemColorScheme === 'dark' ? 'dark' : 'light')
    : theme

  if (!isLoaded) return null

  return (
    <GluestackUIProvider mode={resolvedMode}>
      <PostHogProvider>
        <AuthProvider>
          <StatusBar style={resolvedMode === 'dark' ? 'light' : 'dark'} />
          <Stack screenOptions={{ headerShown: false, lazy: true }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(onboarding)" />
            <Stack.Screen name="(app)" />
            <Stack.Screen name="(admin)" />
          </Stack>
        </AuthProvider>
      </PostHogProvider>
    </GluestackUIProvider>
  )
}

export default function RootLayout() {
  return (
    <RootErrorBoundary>
      <ThemeProvider>
        <RootLayoutInner />
      </ThemeProvider>
    </RootErrorBoundary>
  )
}
