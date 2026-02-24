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
import { useAuth } from '../../contexts/auth'
import { AppSidebar } from '../../components/layout/AppSidebar'
import { AppHeader } from '../../components/layout/AppHeader'

export default function AppLayout() {
  const { isAuthenticated, isLoading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const { width } = useWindowDimensions()
  const isWide = width >= 768
  const [drawerOpen, setDrawerOpen] = useState(false)

  const isProjectDetail = /^\/(app\/)?projects\/[^/]+/.test(pathname.replace(/^\/(app\/)?/, '/'))
    && pathname !== '/projects'
    && pathname !== '/(app)/projects'

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

  const showSidebar = isWide && !isProjectDetail

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 flex-row">
        {showSidebar && <AppSidebar />}

        <View className="flex-1">
          {!isWide && <AppHeader onMenuPress={openDrawer} />}
          <View className="flex-1">
            <Slot />
          </View>
        </View>
      </View>

      {!isWide && (
        <AppSidebar isOpen={drawerOpen} onClose={closeDrawer} />
      )}
    </SafeAreaView>
  )
}
