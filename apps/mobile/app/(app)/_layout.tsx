/**
 * (app) layout - Responsive app shell
 *
 * Wide screens (>= 768px): persistent sidebar + content side by side
 * Narrow screens (< 768px): header with hamburger + drawer sidebar overlay
 *
 * Auth guard redirects unauthenticated users to sign-in.
 */

import { useState, useCallback, useEffect } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { Slot, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { DomainProvider } from '../../contexts/domain'
import { AppSidebar } from '../../components/layout/AppSidebar'
import { AppHeader } from '../../components/layout/AppHeader'

export default function AppLayout() {
  const { isAuthenticated, isLoading } = useAuth()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 768
  const [drawerOpen, setDrawerOpen] = useState(false)

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

  return (
    <DomainProvider>
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 flex-row">
          {isWide && <AppSidebar />}

          <View className="flex-1">
            <AppHeader onMenuPress={openDrawer} />
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
