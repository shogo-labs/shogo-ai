// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useState } from 'react'
import { Keyboard, Platform, Pressable, View } from 'react-native'
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Activity, LayoutGrid, ListTodo, MessageCircle, Target } from 'lucide-react-native'
import { NativePhoneBottomFade } from '../phone/NativePhoneBottomFade'
import { cn } from '@shogo/shared-ui/primitives'
import { useResolvedTheme } from '../../contexts/theme'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { setLastProjectContext, useLastProjectContext } from '../../hooks/useLastProjectContext'
import type { BottomTabId } from '@shogo/shared-app'
import { CHAT_TRANSCRIPT_MAX_WIDTH } from '../../lib/native-composer-keyboard'
import {
  NATIVE_PHONE_COMPOSER_PILL_HEIGHT,
  NATIVE_PHONE_COMPOSER_PILL_ITEM_INSET,
  NATIVE_PHONE_DOCK_FADE,
  NATIVE_PHONE_DOCK_COMPOSER_GAP,
  NATIVE_PHONE_GUTTER,
  NATIVE_PHONE_HOME_CANVAS,
} from '../../lib/native-phone-layout'

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

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

function isBottomTabPath(pathname: string) {
  return ['/tasks', '/activity', '/canvases', '/goals'].some((path) =>
    pathname === path || pathname.endsWith(path) || pathname.includes(`(app)${path}`),
  )
}

function projectIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/\/projects\/([^/]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
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
  const experience = useWorkspaceExperience()
  const params = useLocalSearchParams<{
    id?: string
    chatSessionId?: string
    projectId?: string
    returnProjectId?: string
    returnChatSessionId?: string
  }>()
  const insets = useSafeAreaInsets()
  const isDark = useResolvedTheme() === 'dark'
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const lastProjectContext = useLastProjectContext()

  const routeProjectId = firstParam(params.id)
  const tabProjectId = firstParam(params.returnProjectId) ?? firstParam(params.projectId)
  const pathnameProjectId = projectIdFromPath(pathname)
  const activeProjectId = routeProjectId ?? pathnameProjectId
  const chatSessionId = firstParam(params.chatSessionId) ?? firstParam(params.returnChatSessionId)

  useEffect(() => {
    if (activeProjectId && isProjectPath(pathname)) {
      setLastProjectContext({ projectId: activeProjectId, ...(chatSessionId ? { chatSessionId } : {}) })
    } else if (tabProjectId && isBottomTabPath(pathname)) {
      // Keep the context alive even if the app layout remounts while moving
      // between bottom tabs. The params are passed by the tab buttons below.
      setLastProjectContext({ projectId: tabProjectId, ...(chatSessionId ? { chatSessionId } : {}) })
    } else if (isHomePath(pathname)) {
      // Re-entering Home intentionally resets the context. The other bottom
      // tabs preserve the last project context while opened from a project,
      // so Chat can return to that project.
      setLastProjectContext(null)
    }
  }, [activeProjectId, chatSessionId, pathname, tabProjectId])

  // Prefer the current project route immediately, before the effect above
  // has necessarily populated the cross-tab context. This prevents the first
  // bottom-nav tap after entering a project from falling back to Home.
  const currentProjectContext =
    isProjectPath(pathname) && activeProjectId
      ? { projectId: activeProjectId, ...(chatSessionId ? { chatSessionId } : {}) }
      : isBottomTabPath(pathname) && tabProjectId
        ? { projectId: tabProjectId, ...(chatSessionId ? { chatSessionId } : {}) }
        : lastProjectContext

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
    if (pathname.includes('/goals')) return 'goals'
    if (pathname.includes('/activity')) return 'activity'
    if (pathname.includes('/canvases')) return 'canvases'
    if (pathname.includes('/marketplace')) return 'none'
    return 'chat'
  }, [pathname])

  if (Platform.OS === 'web') return null
  if (isHiddenPath(pathname) || keyboardOpen) return null

  const goChat = () => {
    if (experience.chatReturnsToProjectContext && currentProjectContext?.projectId) {
      router.replace({
        pathname: '/(app)/projects/[id]' as any,
        params: {
          id: currentProjectContext.projectId,
          ...(currentProjectContext.chatSessionId ? { chatSessionId: currentProjectContext.chatSessionId } : {}),
        },
      } as any)
    } else {
      router.replace('/(app)' as any)
    }
  }

  const taskItem = {
    id: 'tasks',
    label: 'Tasks',
    Icon: ListTodo,
    onPress: () => {
      const context = currentProjectContext
      router.push({
        pathname: '/(app)/tasks' as any,
        ...(context?.projectId
          ? { params: { projectId: context.projectId, returnChatSessionId: context.chatSessionId } }
          : {}),
      } as any)
    },
  }

  const chatItem = { id: 'chat', label: 'Chat', Icon: MessageCircle, onPress: goChat }
  const activityItem = {
    id: 'activity',
    label: 'Activity',
    Icon: Activity,
    onPress: () => router.push({
      pathname: '/(app)/activity' as any,
      ...(currentProjectContext?.projectId
        ? { params: { returnProjectId: currentProjectContext.projectId, returnChatSessionId: currentProjectContext.chatSessionId } }
        : {}),
    } as any),
  }
  const goalsItem = {
    id: 'goals',
    label: 'Goals',
    Icon: Target,
    onPress: () => router.push('/(app)/goals' as any),
  }
  const canvasesItem = {
    id: 'canvases',
    label: 'Canvases',
    Icon: LayoutGrid,
    onPress: () => router.push({
      pathname: '/(app)/canvases' as any,
      ...(currentProjectContext?.projectId
        ? { params: { returnProjectId: currentProjectContext.projectId, returnChatSessionId: currentProjectContext.chatSessionId } }
        : {}),
    } as any),
  }

  // The team vs. personal tab set (and order) is owned by the experience
  // descriptor (`bottomTabs`); this map just supplies the onPress/icon for
  // whichever ids it lists, so adding a workspace-experience tab elsewhere
  // doesn't require touching this component's branching logic.
  const tabsById: Record<BottomTabId, { id: string; label: string; Icon: typeof MessageCircle; onPress: () => void }> = {
    chat: chatItem,
    tasks: taskItem,
    activity: activityItem,
    canvases: canvasesItem,
    goals: goalsItem,
  }
  const items = experience.bottomTabs.map((id) => tabsById[id])

  return (
    <View
      className="bg-transparent pt-1"
      style={{
        position: 'relative',
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
      {!isProjectPath(pathname) ? (
        <NativePhoneBottomFade
          isDark={isDark}
          canvasHex={isHomePath(pathname) && isDark ? NATIVE_PHONE_HOME_CANVAS : undefined}
          height={NATIVE_PHONE_DOCK_FADE + NATIVE_PHONE_COMPOSER_PILL_HEIGHT + 16}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        />
      ) : null}
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
