// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * NotificationsScreen — the in-app notification inbox.
 *
 * Lists the current user's notifications (the server scopes `/api/notifications`
 * to the authenticated user). Tapping a row marks it read and follows its
 * `actionUrl` deep link (e.g. billing). "Mark all read" clears the unread
 * state in one go. The bell badge stays in sync via `notificationEvents`.
 */
import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, RefreshControl, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  Bell,
  CheckCheck,
  CheckCircle2,
  AlertTriangle,
  Receipt,
  Gauge,
  ShieldAlert,
  Mail,
  Users,
  Building2,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useNotificationCollection, useDomainActions } from '../../contexts/domain'
import { notificationEvents } from '../../lib/notification-events'

/** Type → icon + accent color (Tailwind text class) for the row glyph. */
function visualForType(type: string): { Icon: React.ElementType; color: string } {
  switch (type) {
    case 'payment_succeeded':
      return { Icon: CheckCircle2, color: 'text-emerald-600' }
    case 'payment_failed':
      return { Icon: AlertTriangle, color: 'text-destructive' }
    case 'overage_charged':
      return { Icon: Receipt, color: 'text-amber-600' }
    case 'usage_threshold':
      return { Icon: Gauge, color: 'text-amber-600' }
    case 'spend_limit_reached':
      return { Icon: ShieldAlert, color: 'text-destructive' }
    case 'invitation_pending':
    case 'invitation_accepted':
      return { Icon: Mail, color: 'text-primary' }
    case 'member_joined':
    case 'member_left':
      return { Icon: Users, color: 'text-primary' }
    case 'workspace_updated':
      return { Icon: Building2, color: 'text-muted-foreground' }
    default:
      return { Icon: Bell, color: 'text-muted-foreground' }
  }
}

function relativeTime(epochMs: number): string {
  if (!epochMs) return ''
  const diff = Date.now() - epochMs
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(epochMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default observer(function NotificationsScreen() {
  const router = useRouter()
  const notifications = useNotificationCollection()
  const actions = useDomainActions()
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      await notifications.loadAll()
    } catch (e) {
      console.error('[Notifications] Failed to load:', e)
    }
  }, [notifications])

  useEffect(() => {
    void load()
  }, [load])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  // Newest first.
  const items = notifications.all
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const unread = items.filter((n) => !n.readAt)

  const handleOpen = useCallback(
    async (n: { id: string; readAt: number; actionUrl: string }) => {
      if (!n.readAt) {
        try {
          await actions.markNotificationRead(n.id)
          notificationEvents.emit()
        } catch (e) {
          console.error('[Notifications] Failed to mark read:', e)
        }
      }
      if (n.actionUrl && n.actionUrl.startsWith('/')) {
        router.push(n.actionUrl as any)
      }
    },
    [actions, router],
  )

  const markAllRead = useCallback(async () => {
    const toMark = items.filter((n) => !n.readAt)
    if (toMark.length === 0) return
    await Promise.all(
      toMark.map((n) =>
        actions.markNotificationRead(n.id).catch((e) => console.error('[Notifications] mark-all failed:', e)),
      ),
    )
    notificationEvents.emit()
  }, [items, actions])

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {/* Header */}
      <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border">
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(app)'))}
          accessibilityLabel="Back"
          className="p-1.5 -ml-1.5 rounded-md active:bg-muted"
        >
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1">Notifications</Text>
        {unread.length > 0 && (
          <Pressable
            onPress={markAllRead}
            accessibilityLabel="Mark all as read"
            className="flex-row items-center gap-1.5 px-2 py-1 rounded-md active:bg-muted"
          >
            <CheckCheck size={16} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Mark all read</Text>
          </Pressable>
        )}
      </View>

      {notifications.isLoading && items.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : items.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8 gap-2">
          <Bell size={28} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-foreground">You're all caught up</Text>
          <Text className="text-xs text-muted-foreground text-center">
            Billing receipts, usage alerts, and workspace updates will show up here.
          </Text>
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {items.map((n) => {
            const { Icon, color } = visualForType(n.type)
            const isUnread = !n.readAt
            return (
              <Pressable
                key={n.id}
                onPress={() => handleOpen(n)}
                className={cn(
                  'flex-row gap-3 px-4 py-3 border-b border-border active:bg-muted/50',
                  isUnread && 'bg-primary/5',
                )}
              >
                <View className="mt-0.5">
                  <Icon size={18} className={color} />
                </View>
                <View className="flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text
                      className={cn('text-sm flex-1', isUnread ? 'font-semibold text-foreground' : 'text-foreground')}
                      numberOfLines={1}
                    >
                      {n.title}
                    </Text>
                    {isUnread && <View className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                  </View>
                  <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={3}>
                    {n.message}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground mt-1">{relativeTime(n.createdAt)}</Text>
                </View>
              </Pressable>
            )
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  )
})
