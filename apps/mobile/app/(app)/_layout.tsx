// SPDX-License-Identifier: AGPL-3.0-or-later
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
 *  - All pages (narrow): hamburger header + drawer sidebar
 *
 * Auth guard redirects unauthenticated users to sign-in.
 */

import { useState, useCallback, useEffect } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { Slot, usePathname, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { usePostHog } from 'posthog-react-native'
import { useAuth } from '../../contexts/auth'
import { usePostHogIdentify } from '../../contexts/posthog'
import { DomainProvider } from '../../contexts/domain'
import { AppSidebar } from '../../components/layout/AppSidebar'
import { AppHeader } from '../../components/layout/AppHeader'

export default function AppLayout() {
  const { isAuthenticated, isLoading } = useAuth()
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

  usePostHogIdentify()
  const posthog = usePostHog()

  useEffect(() => {
    if (isAuthenticated) {
      posthog.screen(pathname)
    }
  }, [pathname, isAuthenticated, posthog])

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/(auth)/sign-in')
    }
  }, [isAuthenticated, isLoading, router])

  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  useEffect(() => {
    if (isWide) setDrawerOpen(false)
  }, [isWide])

  if (isLoading) return null
  if (!isAuthenticated) return null

  const showSidebar = isWide && !isProjectDetail && !isSettingsPage

  return (
    <DomainProvider>
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 flex-row">
          {showSidebar && <AppSidebar />}

          <View className="flex-1">
            {!isWide && !isProjectDetail && <AppHeader onMenuPress={openDrawer} />}
            <View className="flex-1">
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
