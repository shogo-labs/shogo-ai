// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * (app) layout - Responsive app shell
 *
 * Wide screens (>= 768px): persistent sidebar + content side by side
 * Narrow screens (< 768px): header with hamburger + drawer sidebar overlay
 *
 * Route-aware visibility:
 *  - Home page (wide): sidebar visible, NO header
 *  - List pages (wide): sidebar visible, NO header (sidebar provides nav)
 *  - Project detail (wide): NO sidebar (project provides its own top bar)
 *  - Billing page (wide): NO sidebar (standalone full-width page)
 *  - All pages (narrow): hamburger header + drawer sidebar
 *
 * Auth guard redirects unauthenticated users to sign-in (or root in local mode).
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { ActivityIndicator, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { Slot, usePathname, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { usePlatformConfig } from '../../lib/platform-config'
import { API_URL } from '../../lib/api'
import { trackSignUp, trackLogin } from '../../lib/tracking'
import { usePostHogIdentify, usePostHogSafe } from '../../contexts/posthog'
import { DomainProvider } from '../../contexts/domain'
import { AppSidebar } from '../../components/layout/AppSidebar'
import { AppHeader } from '../../components/layout/AppHeader'
import { RecordingIndicator } from '../../components/meetings/RecordingIndicator'
import { VMDownloadBanner } from '../../components/VMDownloadBanner'
import { useNotificationClickRouter } from '../../lib/notifications/useNotificationClickRouter'
import { mark as csMark } from '../../lib/cold-start-timing'

csMark('app:layout:module-load')

export default function AppLayout() {
  csMark('app:layout:render')
  const { isAuthenticated, isLoading, user, refreshSession } = useAuth()
  const { localMode } = usePlatformConfig()
  const router = useRouter()
  const pathname = usePathname()
  const isIdeEmbed = useMemo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('embed') === 'ide'
  }, [])
  const ideApiBaseUrl = useMemo(() => {
    if (isIdeEmbed && Platform.OS === 'web' && typeof window !== 'undefined') {
      return window.location.origin
    }
    return API_URL
  }, [isIdeEmbed])
  const [ideAutoSigningIn, setIdeAutoSigningIn] = useState(false)
  const [ideAutoSignInError, setIdeAutoSignInError] = useState<string | null>(null)
  const ideAutoSignInAttempted = useRef(false)
  const { width } = useWindowDimensions()
  const isWide = width >= 768
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isHomePage = pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'

  const isProjectDetail = /^\/(app\/)?projects\/[^/]+/.test(pathname.replace(/^\/(app\/)?/, '/'))
    && pathname !== '/projects'
    && pathname !== '/(app)/projects'
  const isSettingsPage = pathname === '/settings' || pathname === '/(app)/settings' || pathname.includes('/settings')
  const isBillingPage = pathname === '/billing' || pathname === '/(app)/billing'
  // The notifications inbox provides its own header (back + mark-all-read), so
  // suppress the app header on narrow screens to avoid stacking two headers.
  const isNotificationsPage = pathname === '/notifications' || pathname === '/(app)/notifications'

  usePostHogIdentify()
  const posthog = usePostHogSafe()
  useNotificationClickRouter()

  useEffect(() => {
    if (isAuthenticated && posthog) {
      posthog.screen(pathname)
    }
  }, [pathname, isAuthenticated, posthog])

  useEffect(() => {
    if (!localMode || !isIdeEmbed || isAuthenticated || isLoading || ideAutoSignInAttempted.current) return
    ideAutoSignInAttempted.current = true
    setIdeAutoSigningIn(true)
    setIdeAutoSignInError(null)
    fetch(`${ideApiBaseUrl}/api/local/auto-sign-in`, {
      method: 'POST',
      credentials: 'include',
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return refreshSession()
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[IDEEmbed] Auto-sign-in failed:', err)
        setIdeAutoSignInError(message || 'auto sign-in failed')
      })
      .finally(() => setIdeAutoSigningIn(false))
  }, [ideApiBaseUrl, isAuthenticated, isIdeEmbed, isLoading, localMode, refreshSession])

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !ideAutoSigningIn) {
      if (localMode && isIdeEmbed) return
      router.replace(localMode ? '/' : '/(auth)/sign-in')
    }
  }, [isAuthenticated, isIdeEmbed, ideAutoSigningIn, isLoading, localMode, router])

  useEffect(() => {
    if (!isLoading) csMark('app:layout:auth-resolved', { isAuthenticated })
  }, [isLoading, isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated || !user) return
    try {
      const pending = sessionStorage.getItem('oauth_pending')
      if (pending) {
        sessionStorage.removeItem('oauth_pending')
        const accountAge = user.createdAt
          ? Date.now() - new Date(user.createdAt).getTime()
          : Infinity
        if (accountAge < 60_000) {
          trackSignUp(pending as 'google')
        } else {
          trackLogin(pending as 'google')
        }
      }
    } catch {}
  }, [isAuthenticated, user])

  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  useEffect(() => {
    if (isWide) setDrawerOpen(false)
  }, [isWide])

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const d = (window as any).shogoDesktop
    if (!d?.onNavigate) return
    d.onNavigate((path: string) => {
      router.push(path as any)
    })
    return () => d.removeNavigateListener?.()
  }, [router])

  if (isLoading || ideAutoSigningIn) {
    if (isIdeEmbed) {
      return (
        <View className="flex-1 items-center justify-center bg-background p-4">
          <ActivityIndicator size="large" />
          <Text className="mt-3 text-sm text-muted-foreground">Loading Shogo chat…</Text>
        </View>
      )
    }
    return null
  }

  if (!isAuthenticated) {
    if (isIdeEmbed) {
      const retry = () => {
        ideAutoSignInAttempted.current = false
        setIdeAutoSignInError(null)
        setIdeAutoSigningIn(true)
        fetch(`${ideApiBaseUrl}/api/local/auto-sign-in`, { method: 'POST', credentials: 'include' })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return refreshSession()
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err)
            console.error('[IDEEmbed] Auto-sign-in retry failed:', err)
            setIdeAutoSignInError(message || 'auto sign-in failed')
          })
          .finally(() => setIdeAutoSigningIn(false))
      }
      return (
        <View className="flex-1 items-center justify-center bg-background p-4">
          <Text className="text-base font-semibold text-foreground">Shogo chat could not sign in</Text>
          <Text className="mt-2 max-w-md text-center text-sm text-muted-foreground">
            {ideAutoSignInError ? `Local sign-in failed: ${ideAutoSignInError}` : 'Waiting for the Desktop local session…'}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="mt-4 rounded-md bg-primary px-4 py-2"
            onPress={retry}
          >
            <Text className="text-sm font-medium text-primary-foreground">Retry</Text>
          </Pressable>
        </View>
      )
    }
    return null
  }

  const showSidebar = isWide && !isIdeEmbed && !isSettingsPage && !isBillingPage

  return (
    <DomainProvider>
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 flex-row">
          {showSidebar && <AppSidebar />}

          <View className="flex-1">
            {!isWide && !isIdeEmbed && !isProjectDetail && !isBillingPage && !isNotificationsPage && <AppHeader onMenuPress={openDrawer} />}
            <View className="flex-1">
              {!isIdeEmbed && <VMDownloadBanner />}
              {localMode && !isIdeEmbed && <RecordingIndicator />}
              <Slot />
            </View>
          </View>
        </View>

        {!isWide && (
          <AppSidebar isOpen={drawerOpen} onClose={closeDrawer} />
        )}
      </SafeAreaView>
    </DomainProvider>
  )
}
