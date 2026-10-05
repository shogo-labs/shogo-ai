// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Activity inbox: mentions, thread replies, keyword alerts, reactions to
 * your messages, and reminders, newest first.
 */
import { useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { AlarmClock, AtSign, CheckCheck, Heart, Megaphone, MessageSquare, MessagesSquare, Tag } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { useInbox } from '../../../hooks/useChatPrefs'
import type { InboxItem, InboxKind } from '../../../lib/team-chat-api'

const ICONS: Record<InboxKind, typeof AtSign> = {
  mention: AtSign,
  dm: MessageSquare,
  thread: MessagesSquare,
  reaction: Heart,
  reminder: AlarmClock,
  keyword: Tag,
  broadcast: Megaphone,
  message: MessageSquare,
}

const KIND_LABEL: Record<InboxKind, string> = {
  mention: 'Mention',
  dm: 'Direct message',
  thread: 'Thread reply',
  reaction: 'Reaction',
  reminder: 'Reminder',
  keyword: 'Keyword',
  broadcast: 'Announcement',
  message: 'Message',
}

function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime())
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function TeamChatInbox() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const [unreadOnly, setUnreadOnly] = useState(false)
  const { items, loading, error, markRead, loadMore } = useInbox(workspaceId, unreadOnly)
  const anyUnread = items.some((i) => !i.readAt)

  const open = (item: InboxItem) => {
    if (!item.readAt) void markRead([item.id])
    if (!item.conversationId) return
    const thread = item.threadRootId ?? item.messageId
    router.push({
      pathname: '/(app)/c/[conversationId]',
      params: thread ? { conversationId: item.conversationId, thread } : { conversationId: item.conversationId },
    } as any)
  }

  if (experience.resolved && experience.kind !== 'team') {
    return (
      <View className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-center text-sm text-muted-foreground">Team chat is available in team workspaces.</Text>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background">
      <View className="w-full self-center px-6 pt-6" style={{ maxWidth: 820 }}>
        <View className="flex-row items-center">
          <Text className="flex-1 text-2xl font-semibold text-foreground">Inbox</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mark all as read"
            disabled={!anyUnread}
            onPress={() => void markRead('all')}
            className={cn('flex-row items-center gap-1.5 rounded-md px-2 py-1', anyUnread ? 'active:bg-accent/50' : 'opacity-40')}
          >
            <CheckCheck size={14} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Mark all read</Text>
          </Pressable>
        </View>
        <View className="mt-3 flex-row items-center gap-2">
          {([false, true] as const).map((u) => (
            <Pressable
              key={String(u)}
              accessibilityRole="button"
              accessibilityState={{ selected: unreadOnly === u }}
              onPress={() => setUnreadOnly(u)}
              className={cn('rounded-full border px-3 py-1', unreadOnly === u ? 'border-primary bg-primary/10' : 'border-border')}
            >
              <Text className={cn('text-xs', unreadOnly === u ? 'text-primary' : 'text-muted-foreground')}>{u ? 'Unread' : 'All'}</Text>
            </Pressable>
          ))}
          {loading ? <ActivityIndicator size="small" /> : null}
        </View>
        {error ? <Text className="mt-3 text-sm text-destructive">{error}</Text> : null}
      </View>

      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 16, maxWidth: 820, width: '100%', alignSelf: 'center' }}
        ListEmptyComponent={
          !loading ? (
            <Text className="mt-8 text-center text-sm text-muted-foreground">
              {unreadOnly ? "You're all caught up." : 'Mentions, thread replies, reactions, and reminders show up here.'}
            </Text>
          ) : null
        }
        renderItem={({ item }) => {
          const Icon = ICONS[item.kind] ?? MessageSquare
          const unread = !item.readAt
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${KIND_LABEL[item.kind] ?? 'Activity'}: ${item.title}${unread ? ', unread' : ''}`}
              onPress={() => open(item)}
              onLongPress={() => void markRead([item.id], !unread)}
              className={cn(
                'mb-2 flex-row gap-3 rounded-md border px-4 py-3 active:bg-muted/60 web:hover:bg-muted/40',
                unread ? 'border-primary/40 bg-primary/5' : 'border-border',
              )}
            >
              <Icon size={16} className={unread ? 'mt-0.5 text-primary' : 'mt-0.5 text-muted-foreground'} />
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <Text className={cn('flex-1 text-sm text-foreground', unread && 'font-semibold')} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text className="text-xs text-muted-foreground">{relativeTime(item.createdAt)}</Text>
                  {unread ? <View className="h-2 w-2 rounded-full bg-primary" /> : null}
                </View>
                {item.preview ? (
                  <Text className="mt-0.5 text-sm text-muted-foreground" numberOfLines={2}>{item.preview}</Text>
                ) : null}
              </View>
            </Pressable>
          )
        }}
        onEndReachedThreshold={0.4}
        onEndReached={loadMore}
      />
    </View>
  )
}
