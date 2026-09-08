// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppHeader - Mobile application header
 *
 * Web (narrow): hamburger + title + bell in a compact bar.
 * Native home: no bar — menu and bell float over the page so the gradient
 * can go edge-to-edge. Other native screens keep an in-flow chrome row
 * without a filled bar. Wide web keeps the persistent sidebar and renders
 * nothing.
 */

import { Platform, View, Text, Pressable, useWindowDimensions } from 'react-native'
import { usePathname } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Menu } from 'lucide-react-native'
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

const overlayControlClass =
  'h-10 w-10 items-center justify-center rounded-full bg-muted p-0'

interface AppHeaderProps {
  onMenuPress?: () => void
  menuOpen?: boolean
}

export function AppHeader({ onMenuPress, menuOpen = false }: AppHeaderProps) {
  const { width } = useWindowDimensions()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const isWide = Platform.OS === 'web' && width >= 768
  const isHome = isHomePathname(pathname)
  const title = getTitleFromPathname(pathname)

  if (isWide) return null

  if (Platform.OS !== 'web') {
    const overlay = isHome
    return (
      <View
        pointerEvents="box-none"
        style={
          overlay
            ? {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 30,
                paddingTop: insets.top + 6,
                paddingHorizontal: 14,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }
            : {
                paddingTop: 6,
                paddingBottom: 6,
                paddingHorizontal: 14,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }
        }
      >
        <Pressable
          onPress={onMenuPress}
          accessibilityRole="button"
          accessibilityLabel={menuOpen ? 'Close menu' : 'Open menu'}
          hitSlop={4}
          className={overlayControlClass}
        >
          <Menu size={22} className="text-foreground" />
        </Pressable>
        {isHome ? (
          <View className="flex-1" pointerEvents="none" />
        ) : (
          <Text className="flex-1 text-center text-base font-semibold text-foreground" numberOfLines={1}>
            {title}
          </Text>
        )}
        <NotificationBell className={overlayControlClass} />
      </View>
    )
  }

  return (
    <View className="h-14 flex-row items-center border-b border-border bg-card px-4 gap-3">
      <Pressable
        onPress={onMenuPress}
        accessibilityRole="button"
        accessibilityLabel={menuOpen ? 'Close menu' : 'Open menu'}
        className="p-1.5 -ml-1.5 rounded-md active:bg-muted"
      >
        <Menu size={22} className="text-foreground" />
      </Pressable>
      <Text className="text-base font-semibold text-foreground">{title}</Text>
      <View className="flex-1" />
      <NotificationBell />
    </View>
  )
}
