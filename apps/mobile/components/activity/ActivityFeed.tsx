// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Everything that happened, by people and by agents, in one list: filter
 * chips, a strip of agents working right now, and a row per event. Used as
 * the Activity tab on mobile and the Activity panel on desktop.
 */
import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { AlarmClock, AtSign, Bot, Heart, Lock, Megaphone, MessageSquare, MessagesSquare, Tag } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useAgentActivity } from '../../hooks/useAgentActivity'
import { useInbox } from '../../hooks/useChatPrefs'
import { openActiveChat } from '../../lib/open-active-chat'
import { readableAgentTaskError } from '../../lib/agent-task-ui'
import { ACTIVITY_FILTERS, buildFeed, relativeTime, type ActivityEntry, type ActivityFilter } from '../../lib/activity-feed'
import type { AgentTask } from '../../lib/api'
import type { InboxKind } from '../../lib/team-chat-api'

const KIND_ICON: Record<InboxKind, typeof AtSign> = {
  mention: AtSign,
  dm: MessageSquare,
  thread: MessagesSquare,
  reaction: Heart,
  reminder: AlarmClock,
  keyword: Tag,
  broadcast: Megaphone,
  message: MessageSquare,
}

/** Polls only while the screen showing the feed is focused. */
function useFocused(): boolean {
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, []),
  )
  return focused
}

export interface ActivityFeedProps {
  /** Tighter rows for the desktop side panel. */
  compact?: boolean
}

export function ActivityFeed({ compact = false }: ActivityFeedProps) {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id ?? null
  const focused = useFocused()
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const inbox = useInbox(workspaceId, false)
  const agents = useAgentActivity({ polling: focused, light: true })

  const feed = useMemo(
    () => buildFeed({ inbox: inbox.items, tasks: agents.tasks, activeChats: agents.activeChats, filter, unreadOnly }),
    [inbox.items, agents.tasks, agents.activeChats, filter, unreadOnly],
  )
  const loading = (inbox.loading && inbox.items.length === 0) || (agents.loading && agents.tasks.length === 0)
  const empty = !loading && feed.running.length === 0 && feed.entries.length === 0

  const open = (entry: ActivityEntry) => {
    if (entry.inbox) {
      const item = entry.inbox
      if (!item.readAt) void inbox.markRead([item.id])
      if (!item.conversationId) return
      const thread = item.threadRootId ?? item.messageId
      router.push({
        pathname: '/(app)/c/[conversationId]',
        params: thread ? { conversationId: item.conversationId, thread } : { conversationId: item.conversationId },
      } as any)
      return
    }
    if (entry.agent?.chat) {
      openActiveChat(router, entry.agent.chat)
      return
    }
    const task = entry.agent?.task
    if (task) openTask(router, task)
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="max-h-12 shrink-0 grow-0"
        contentContainerClassName={cn('items-center gap-2', compact ? 'px-3 py-2' : 'px-4 py-2')}
      >
        {ACTIVITY_FILTERS.map(({ id, label }) => (
          <Pressable
            key={id}
            accessibilityRole="button"
            aria-selected={filter === id}
            onPress={() => setFilter(id)}
            className={cn('rounded-full border px-3 py-1', filter === id ? 'border-primary bg-primary/10' : 'border-border active:bg-accent/50')}
          >
            <Text className={cn('text-xs', filter === id ? 'font-medium text-primary' : 'text-muted-foreground')}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-28"
        refreshControl={
          <RefreshControl
            refreshing={agents.refreshing}
            onRefresh={() => {
              void agents.refresh({ manual: true })
              void inbox.refresh()
            }}
          />
        }
      >
        {feed.running.length > 0 && <RunningNow entries={feed.running} compact={compact} onOpen={open} />}
        {loading ? <ActivityIndicator className="mt-8" /> : null}
        {inbox.error && !loading ? <Text className="px-4 pt-3 text-sm text-destructive">{inbox.error}</Text> : null}
        {agents.error && !loading ? <Text className="px-4 pt-3 text-sm text-destructive">{readableAgentTaskError(agents.error, 'We could not refresh agent activity.')}</Text> : null}
        {feed.entries.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} compact={compact} onPress={() => open(entry)} />
        ))}
        {empty ? (
          <Text className="px-6 pt-10 text-center text-sm text-muted-foreground">
            {unreadOnly ? "You're all caught up." : filter === 'agents' ? 'Agent work shows up here.' : 'Messages, mentions, and agent work show up here.'}
          </Text>
        ) : null}
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        aria-selected={unreadOnly}
        accessibilityLabel="Unreads only"
        onPress={() => setUnreadOnly((v) => !v)}
        className={cn(
          // Phones keep the right corner for the floating "+".
          compact ? 'absolute bottom-4 right-4' : 'absolute bottom-7 left-4',
          'rounded-full border px-4 py-2 shadow-sm',
          unreadOnly ? 'border-primary bg-primary' : 'border-border bg-card active:bg-accent/50',
        )}
      >
        <Text className={cn('text-xs font-medium', unreadOnly ? 'text-primary-foreground' : 'text-foreground')}>Unreads</Text>
      </Pressable>
    </View>
  )
}

function openTask(router: ReturnType<typeof useRouter>, task: AgentTask) {
  if (task.projectId) {
    router.push({
      pathname: '/(app)/projects/[id]',
      params: { id: task.projectId, ...(task.chatSessionId ? { chatSessionId: task.chatSessionId } : {}) },
    } as any)
  } else {
    router.push({
      pathname: '/(app)/agent',
      params: task.chatSessionId ? { chatSessionId: task.chatSessionId } : {},
    } as any)
  }
}

/** The agents working right now, kept above the history. */
export function RunningNow({ entries, compact, onOpen }: { entries: ActivityEntry[]; compact?: boolean; onOpen: (e: ActivityEntry) => void }) {
  return (
    <View className={cn('border-b border-border/60', compact ? 'px-3 pb-2' : 'px-4 pb-3')} testID="running-now">
      <View className="flex-row items-center gap-2 pb-1 pt-2">
        <View className="h-2 w-2 rounded-full bg-primary" />
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{`Running now · ${entries.length}`}</Text>
      </View>
      {entries.map((entry) => (
        <Pressable
          key={entry.id}
          accessibilityRole="button"
          accessibilityLabel={`${entry.title}, ${entry.agent?.state === 'queued' ? 'queued' : 'running'}`}
          onPress={() => onOpen(entry)}
          className="flex-row items-center gap-2.5 rounded-md px-1 py-1.5 active:bg-accent/50"
        >
          <AgentMark running />
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{entry.title}</Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>{`${entry.context} · ${entry.preview}`}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  )
}

/** The agent avatar: a bot, ringed while it works. */
export function AgentMark({ running = false, size = 32 }: { running?: boolean; size?: number }) {
  return (
    <View
      style={{ width: size, height: size }}
      className={cn('items-center justify-center rounded-lg bg-primary/15', running && 'border border-primary/60')}
    >
      <Bot size={Math.round(size / 2)} className="text-primary" />
    </View>
  )
}

function ActivityRow({ entry, compact, onPress }: { entry: ActivityEntry; compact: boolean; onPress: () => void }) {
  const Icon = KIND_ICON[entry.kind as InboxKind] ?? MessageSquare
  const failed = entry.agent?.state === 'failed'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.title}, ${entry.context}${entry.unread ? ', unread' : ''}`}
      onPress={onPress}
      className={cn('flex-row gap-3 active:bg-accent/50', compact ? 'px-3 py-2' : 'px-4 py-3', entry.unread && 'bg-primary/5')}
    >
      {entry.source === 'agent' ? (
        <AgentMark />
      ) : (
        <View style={{ width: 32, height: 32 }} className="items-center justify-center rounded-lg bg-muted">
          <Icon size={16} className="text-muted-foreground" />
        </View>
      )}
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text className={cn('flex-1 text-sm text-foreground', entry.unread && 'font-semibold')} numberOfLines={1}>{entry.title}</Text>
          <Text className="text-[11px] text-muted-foreground">{relativeTime(entry.at)}</Text>
          {entry.unread && <View testID="unread-dot" className={cn('h-2 w-2 rounded-full', failed ? 'bg-destructive' : 'bg-primary')} />}
        </View>
        <View className="flex-row items-center gap-1">
          {entry.private && <Lock size={10} className="text-muted-foreground" />}
          <Text className={cn('text-xs', failed ? 'text-destructive' : 'text-muted-foreground')} numberOfLines={1}>{entry.context}</Text>
        </View>
        {entry.preview ? <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={compact ? 1 : 2}>{entry.preview}</Text> : null}
      </View>
    </Pressable>
  )
}
