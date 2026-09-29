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
import { View, Text, Pressable, ScrollView, RefreshControl, ActivityIndicator, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  ArrowLeft,
  Bell,
  CheckCheck,
  CheckCircle2,
  Clock3,
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
import { filterNotificationsForPlatform } from '../../lib/notification-policy'

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
    case 'agent_task_started':
      return { Icon: Clock3, color: 'text-primary' }
    case 'agent_task_completed':
      return { Icon: CheckCircle2, color: 'text-emerald-600' }
    case 'agent_task_failed':
      return { Icon: AlertTriangle, color: 'text-destructive' }
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
  const [markingAllRead, setMarkingAllRead] = useState(false)
  const [markAllError, setMarkAllError] = useState(false)

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
  const items = filterNotificationsForPlatform(notifications.all, Platform.OS)
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
    if (markingAllRead) return
    const toMark = items.filter((n) => !n.readAt)
    if (toMark.length === 0) return
    setMarkingAllRead(true)
    setMarkAllError(false)
    try {
      // `markNotificationRead` is optimistic in the domain store, so the
      // unread badge and button disappear immediately. If any request fails,
      // reload once to reconcile the failed row instead of silently claiming
      // that the entire operation succeeded.
      const results = await Promise.allSettled(
        toMark.map((n) => actions.markNotificationRead(n.id)),
      )
      const failed = results.some((result) => result.status === 'rejected')
      if (failed) {
        setMarkAllError(true)
        await notifications.loadAll().catch((e) =>
          console.error('[Notifications] mark-all reconciliation failed:', e),
        )
      }
      notificationEvents.emit()
    } finally {
      setMarkingAllRead(false)
    }
  }, [items, actions, markingAllRead, notifications])

  const isNative = Platform.OS !== 'web'

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* Header */}
      <View className="border-b border-border/70 px-4">
        <View className={cn('w-full max-w-3xl self-center flex-row items-center gap-3', isNative ? 'py-4' : 'py-3')}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(app)'))}
            accessibilityLabel="Back"
            className={cn('h-10 w-10 items-center justify-center rounded-full border border-border active:bg-muted', !isNative && 'h-8 w-8')}
          >
            <ArrowLeft size={isNative ? 20 : 18} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-primary">Inbox</Text>
            <Text className={cn('font-semibold tracking-tight text-foreground', isNative ? 'text-2xl' : 'text-xl')}>Notifications</Text>
          </View>
          {unread.length > 0 && (
            <Pressable
              onPress={markAllRead}
              disabled={markingAllRead}
              accessibilityLabel="Mark all as read"
              className="min-h-11 flex-row items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 active:bg-muted disabled:opacity-50"
            >
              {markingAllRead ? (
                <ActivityIndicator size="small" />
              ) : (
                <CheckCheck size={isNative ? 18 : 16} className="text-primary" />
              )}
              <Text className={cn('font-medium text-foreground', isNative ? 'text-sm' : 'text-xs')}>Mark all read</Text>
            </Pressable>
          )}
        </View>
      </View>

      {markAllError ? (
        <Text className="px-4 pt-2 text-xs text-destructive">
          Some notifications could not be marked read. Pull to refresh and try again.
        </Text>
      ) : null}

      {notifications.isLoading && items.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : items.length === 0 ? (
        <View className={cn('flex-1 items-center justify-center px-8', isNative ? 'gap-3' : 'gap-2')}>
          <View className="w-full max-w-sm items-center rounded-2xl border border-border bg-card px-6 py-8">
            <View className="mb-4 h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <Bell size={isNative ? 26 : 22} className="text-primary" />
            </View>
            <Text className={cn('font-semibold text-foreground text-center', isNative ? 'text-2xl' : 'text-sm')}>
              You're all caught up
            </Text>
            <Text className={cn('mt-2 text-muted-foreground text-center', isNative ? 'text-base leading-6 max-w-[280px]' : 'text-xs')}>
              Billing receipts, usage alerts, and workspace updates will show up here.
            </Text>
          </View>
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="w-full max-w-3xl self-center px-4 pb-8 pt-3"
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
                  'mb-2 flex-row gap-3 rounded-xl border border-border bg-card px-4 active:bg-muted/50',
                  isNative ? 'py-4' : 'py-3',
                  isUnread && 'border-l-2 border-l-primary bg-primary/5',
                )}
              >
                <View className="mt-0.5">
                  <Icon size={isNative ? 22 : 18} className={color} />
                </View>
                <View className="flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text
                      className={cn(
                        'flex-1',
                        isNative ? 'text-base' : 'text-sm',
                        isUnread ? 'font-semibold text-foreground' : 'text-foreground',
                      )}
                      numberOfLines={1}
                    >
                      {n.title}
                    </Text>
                    {isUnread && <View className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                  </View>
                  <Text className={cn('text-muted-foreground mt-0.5', isNative ? 'text-sm' : 'text-xs')} numberOfLines={3}>
                    {n.message}
                  </Text>
                  <Text className={cn('text-muted-foreground mt-1', isNative ? 'text-xs' : 'text-[11px]')}>{relativeTime(n.createdAt)}</Text>
                </View>
              </Pressable>
            )
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  )
})
