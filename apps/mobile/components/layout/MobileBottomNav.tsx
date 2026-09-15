// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useState } from 'react'
import { Keyboard, Platform, Pressable, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Activity, ListTodo, MessageCircle, Store } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useResolvedTheme } from '../../contexts/theme'
import { CHAT_TRANSCRIPT_MAX_WIDTH } from '../../lib/native-composer-keyboard'
import {
  NATIVE_PHONE_COMPOSER_PILL_HEIGHT,
  NATIVE_PHONE_COMPOSER_PILL_ITEM_INSET,
  NATIVE_PHONE_DOCK_COMPOSER_GAP,
  NATIVE_PHONE_GUTTER,
  WEB_WIDE_MIN_WIDTH,
} from '../../lib/native-phone-layout'

let lastProjectContext: { projectId: string; chatSessionId?: string } | null = null

// The project composer already reserves a small safe-area pad. Pull the nav
// capsule into that space so the resting composer-to-nav gap stays around
// 24–28px on an iPhone instead of leaving a large visual hole.
const NATIVE_PHONE_PROJECT_NAV_OVERLAP = 16

function isProjectPath(pathname: string) {
  return pathname.includes('/projects/') && !pathname.endsWith('/projects')
}

function isHomePath(pathname: string) {
  return pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
}

function isHiddenPath(pathname: string) {
  return [
    '/settings', '/billing', '/account', '/profile', '/api-keys', '/search',
    '/notifications', '/project-chats', '/members', '/new-workspace', '/remote-control',
  ].some((path) => pathname === path || pathname.startsWith(`${path}/`) || pathname.includes(`(app)${path}`))
}

export function MobileBottomNav() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useLocalSearchParams<{ id?: string; chatSessionId?: string }>()
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const isDark = useResolvedTheme() === 'dark'
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  const projectId = Array.isArray(params.id) ? params.id[0] : params.id
  const chatSessionId = Array.isArray(params.chatSessionId) ? params.chatSessionId[0] : params.chatSessionId

  useEffect(() => {
    if (projectId && isProjectPath(pathname)) {
      lastProjectContext = { projectId, ...(chatSessionId ? { chatSessionId } : {}) }
    } else if (isHomePath(pathname)) {
      // Re-entering Home intentionally resets the context. Tasks, Activity,
      // and Library preserve the last project context while they are opened
      // from a project, so Chat can return to that project.
      lastProjectContext = null
    }
  }, [chatSessionId, pathname, projectId])

  useEffect(() => {
    const show = () => setKeyboardOpen(true)
    const hide = () => setKeyboardOpen(false)
    const subscriptions = Platform.OS === 'ios'
      ? [Keyboard.addListener('keyboardWillShow', show), Keyboard.addListener('keyboardWillHide', hide)]
      : [Keyboard.addListener('keyboardDidShow', show), Keyboard.addListener('keyboardDidHide', hide)]
    return () => subscriptions.forEach((subscription) => subscription.remove())
  }, [])

  const active = useMemo(() => {
    if (pathname.includes('/tasks')) return 'tasks'
    if (pathname.includes('/activity')) return 'activity'
    if (pathname.includes('/marketplace')) return 'marketplace'
    return 'chat'
  }, [pathname])

  if (Platform.OS === 'web' && width >= WEB_WIDE_MIN_WIDTH) return null
  if (isHiddenPath(pathname) || keyboardOpen) return null

  const goChat = () => {
    if (lastProjectContext?.projectId) {
      router.replace({
        pathname: '/(app)/projects/[id]' as any,
        params: {
          id: lastProjectContext.projectId,
          ...(lastProjectContext.chatSessionId ? { chatSessionId: lastProjectContext.chatSessionId } : {}),
        },
      } as any)
    } else {
      router.replace('/(app)' as any)
    }
  }

  const items = [
    { id: 'chat', label: 'Chat', Icon: MessageCircle, onPress: goChat },
    {
      id: 'tasks',
      label: 'Tasks',
      Icon: ListTodo,
      onPress: () => router.push({
        pathname: '/(app)/tasks' as any,
        ...(lastProjectContext?.projectId ? { params: { projectId: lastProjectContext.projectId } } : {}),
      } as any),
    },
    { id: 'activity', label: 'Activity', Icon: Activity, onPress: () => router.push('/(app)/activity' as any) },
    { id: 'marketplace', label: 'Marketplace', Icon: Store, onPress: () => router.push('/(app)/marketplace' as any) },
  ] as const

  return (
    <View
      className="bg-transparent pt-1"
      style={{
        marginTop: isProjectPath(pathname)
          ? -(NATIVE_PHONE_DOCK_COMPOSER_GAP + NATIVE_PHONE_PROJECT_NAV_OVERLAP)
          : -(NATIVE_PHONE_DOCK_COMPOSER_GAP + 16),
        // Home is edge-to-edge in the root shell, while project chat is
        // already inside the shell's bottom safe area. Reserve the home
        // inset here so the composer and this capsule move up together and
        // match the project-chat dock position.
        paddingBottom: isHomePath(pathname) ? insets.bottom + 8 : 8,
        paddingHorizontal: NATIVE_PHONE_GUTTER,
      }}
      testID="mobile-bottom-nav"
    >
      <View
        className="w-full flex-row items-center gap-1 border border-border bg-card/95 px-1.5 shadow-sm"
        style={{
          height: NATIVE_PHONE_COMPOSER_PILL_HEIGHT,
          maxWidth: CHAT_TRANSCRIPT_MAX_WIDTH,
          alignSelf: 'center',
          borderRadius: NATIVE_PHONE_COMPOSER_PILL_HEIGHT / 2,
        }}
      >
        {items.map(({ id, label, Icon, onPress }) => {
          const selected = active === id
          return (
            <Pressable
              key={id}
              onPress={onPress}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={label}
              className={cn('flex-1 items-center justify-center rounded-full', selected && 'bg-muted')}
              style={{ height: NATIVE_PHONE_COMPOSER_PILL_HEIGHT - NATIVE_PHONE_COMPOSER_PILL_ITEM_INSET * 2 }}
            >
              <Icon size={23} color={selected ? (isDark ? '#ffffff' : '#111827') : (isDark ? '#a1a1aa' : '#6b7280')} strokeWidth={selected ? 2.2 : 1.9} />
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}
