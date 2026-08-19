// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppHeader - Mobile application header
 *
 * Shows a hamburger menu button on narrow screens to toggle the sidebar drawer,
 * plus the current page title derived from the active route.
 */

import { Platform, View, Text, Pressable, useWindowDimensions } from 'react-native'
import { usePathname } from 'expo-router'
import { Menu } from 'lucide-react-native'
import { ShogoWordmark } from '../branding/ShogoWordmark'
import { NotificationBell } from '../notifications/NotificationBell'

function isHomePathname(pathname: string): boolean {
  return pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
}

function getTitleFromPathname(pathname: string): string {
  if (isHomePathname(pathname)) {
    return 'Home'
  }
  if (pathname.startsWith('/(app)/projects/')) return 'Project'
  if (pathname.startsWith('/(app)/projects')) return 'Projects'
  if (pathname.startsWith('/(app)/starred')) return 'Starred'
  if (pathname.startsWith('/(app)/shared')) return 'Shared'
  if (pathname.startsWith('/(app)/templates')) return 'Templates'
  if (pathname.startsWith('/(app)/billing')) return 'Billing'
  if (pathname.startsWith('/(app)/settings')) return 'Settings'
  const segments = pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  if (last) return last.charAt(0).toUpperCase() + last.slice(1)
  return 'Shogo'
}

interface AppHeaderProps {
  onMenuPress?: () => void
}

export function AppHeader({ onMenuPress }: AppHeaderProps) {
  const { width } = useWindowDimensions()
  const pathname = usePathname()
  const isWide = Platform.OS === 'web' && width >= 768
  const showNativeHomeMark = Platform.OS !== 'web' && isHomePathname(pathname)
  const title = getTitleFromPathname(pathname)

  // On wide screens the sidebar is persistent, so no header needed
  if (isWide) return null

  return (
    <View className="h-14 flex-row items-center border-b border-border bg-card px-4 gap-3">
      <Pressable
        onPress={onMenuPress}
        className="p-1.5 -ml-1.5 rounded-md active:bg-muted"
      >
        <Menu size={22} className="text-foreground" />
      </Pressable>
      {showNativeHomeMark ? (
        <ShogoWordmark compact className="h-6 w-6" />
      ) : (
        <Text className="text-base font-semibold text-foreground">{title}</Text>
      )}
      <View className="flex-1" />
      <NotificationBell />
    </View>
  )
}
