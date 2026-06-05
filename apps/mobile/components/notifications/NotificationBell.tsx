// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * NotificationBell — header/sidebar bell with an unread badge that opens the
 * in-app notifications inbox.
 *
 * The unread count is polled lazily: on mount, whenever the surrounding screen
 * regains focus, on a slow interval, and immediately when the inbox marks
 * something read (via `notificationEvents`). Kept intentionally lightweight —
 * it hits the cheap `GET /api/notifications/unread-count` endpoint, never the
 * full list.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, View, Text } from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Bell } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import { notificationEvents } from '../../lib/notification-events'

const POLL_INTERVAL_MS = 60_000

export function NotificationBell({ size = 22, className }: { size?: number; className?: string }) {
  const router = useRouter()
  const http = useDomainHttp()
  const [count, setCount] = useState(0)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    if (!http) return
    try {
      const next = await api.getUnreadNotificationCount(http)
      if (mounted.current) setCount(next)
    } catch (e) {
      // Non-fatal: the badge just keeps its last value.
      console.warn('[NotificationBell] unread count failed:', (e as Error)?.message ?? e)
    }
  }, [http])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Refresh while focused; also poll slowly so a long-lived screen still sees
  // new notifications arrive.
  useFocusEffect(
    useCallback(() => {
      void refresh()
      const id = setInterval(() => void refresh(), POLL_INTERVAL_MS)
      return () => clearInterval(id)
    }, [refresh]),
  )

  // Immediate sync when the inbox marks notifications read.
  useEffect(() => notificationEvents.subscribe(() => void refresh()), [refresh])

  const badge = count > 9 ? '9+' : String(count)

  return (
    <Pressable
      onPress={() => router.push('/(app)/notifications' as any)}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
      className={cn('relative p-1.5 rounded-md active:bg-muted', className)}
    >
      <Bell size={size} className="text-foreground" />
      {count > 0 && (
        <View className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-destructive items-center justify-center">
          <Text className="text-[9px] font-bold text-white">{badge}</Text>
        </View>
      )}
    </Pressable>
  )
}
