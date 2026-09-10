// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppHeader - Mobile application header
 *
 * Wide web (>= 768px): persistent sidebar, no header.
 * Phone (native or mobile web): menu and bell float over home; other
 * screens keep an in-flow chrome row without a filled bar.
 */

import { Platform, View, Text, Pressable, useWindowDimensions } from 'react-native'
import { usePathname } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Menu } from 'lucide-react-native'
import { NotificationBell } from '../notifications/NotificationBell'
import { NATIVE_PHONE_HEADER_ICON_SIZE,
  WEB_WIDE_MIN_WIDTH, useNativePhoneIconChrome } from '../../lib/native-phone-layout'
import { PHONE_DENSITY } from '../../lib/phone-density'

function isHomePathname(pathname: string): boolean {
  return ( pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
  )
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
  `${PHONE_DENSITY.hit} rounded-full bg-muted p-0`

interface AppHeaderProps {
  onMenuPress?: () => void
  menuOpen?: boolean
}

export function AppHeader({ onMenuPress, menuOpen = false }: AppHeaderProps) {
  const { width } = useWindowDimensions()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const icon = useNativePhoneIconChrome()
  const isWide = Platform.OS === 'web' && width >= WEB_WIDE_MIN_WIDTH
  const isHome = isHomePathname(pathname)
  const title = getTitleFromPathname(pathname)

  if (isWide) return null
  return (
      <View
        pointerEvents="box-none"
        style={
        isHome
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
          <Menu size={NATIVE_PHONE_HEADER_ICON_SIZE} color={icon.color} strokeWidth={icon.strokeWidth} />
        </Pressable>
        {isHome ? (
          <View className="flex-1" pointerEvents="none" />
        ) : (
          <Text className={`flex-1 text-center ${PHONE_DENSITY.text.body} font-semibold text-foreground`} numberOfLines={1}>
            {title}
          </Text>
        )}
        <NotificationBell size={NATIVE_PHONE_HEADER_ICON_SIZE} className={overlayControlClass} />
      </View>
  )
}
