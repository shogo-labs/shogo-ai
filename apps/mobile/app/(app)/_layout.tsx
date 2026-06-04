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

import { useState, useCallback, useEffect } from 'react'
import { Platform, View, useWindowDimensions } from 'react-native'
import { Slot, usePathname, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { usePlatformConfig } from '../../lib/platform-config'
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
  const { isAuthenticated, isLoading, user } = useAuth()
  const { localMode } = usePlatformConfig()
  const router = useRouter()
  const pathname = usePathname()
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
    if (!isLoading && !isAuthenticated) {
      router.replace(localMode ? '/' : '/(auth)/sign-in')
    }
  }, [isAuthenticated, isLoading, localMode, router])

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

  if (isLoading) return null
  if (!isAuthenticated) return null

  const showSidebar = isWide && !isSettingsPage && !isBillingPage

  return (
    <DomainProvider>
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 flex-row">
          {showSidebar && <AppSidebar />}

          <View className="flex-1">
            {!isWide && !isProjectDetail && !isBillingPage && !isNotificationsPage && <AppHeader onMenuPress={openDrawer} />}
            <View className="flex-1">
              <VMDownloadBanner />
              {localMode && <RecordingIndicator />}
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
