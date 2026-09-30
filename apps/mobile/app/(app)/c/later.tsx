// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Later: saved messages, reminders, and scheduled messages in one place.
 */
import { useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { AlarmClock, Bookmark, Check, Clock, Hash, Lock, MessageSquare, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { useMentionables } from '../../../hooks/useTeamChat'
import { useLater } from '../../../hooks/useChatItems'
import type { ConversationRef } from '../../../lib/team-chat-api'
import { mentionNames, renderMentions, scheduleOptions } from '../../../lib/team-chat-state'

type Tab = 'saved' | 'reminders' | 'scheduled'

function where(c: ConversationRef | null | undefined): string {
  if (!c) return ''
  if (c.kind === 'dm' || c.kind === 'group_dm') return 'Direct message'
  return `#${c.slug ?? c.name ?? 'channel'}`
}

function when(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Today at ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`
}

function plain(text: string, names: ReturnType<typeof mentionNames>): string {
  return renderMentions(text, names).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`>]/g, '').trim()
}

export default function TeamChatLater() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const names = mentionNames(useMentionables(workspaceId))
  const later = useLater(workspaceId)
  const [tab, setTab] = useState<Tab>('saved')
  const [snoozing, setSnoozing] = useState<string | null>(null)

  const open = (conversationId: string | null, messageId?: string | null, threadRootId?: string | null) => {
    if (!conversationId) return
    const thread = threadRootId ?? messageId
    router.push({
      pathname: '/(app)/c/[conversationId]',
      params: thread ? { conversationId, thread } : { conversationId },
    } as any)
  }

  const counts = { saved: later.saved.length, reminders: later.reminders.length, scheduled: later.scheduled.length }
  const snoozeChoices = useMemo(() => scheduleOptions(), [snoozing])

  if (experience.resolved && experience.kind !== 'team') {
    return (
      <View className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-center text-sm text-muted-foreground">Team chat is available in team workspaces.</Text>
      </View>
    )
  }

  const empty = {
    saved: 'Save messages to come back to them. Hover a message and press the bookmark.',
    reminders: 'Set reminders with “/remind me to … in 2 hours”, or from a message’s alarm clock button.',
    scheduled: 'Write a message and press the clock next to Send to schedule it.',
  }[tab]

  return (
    <View className="flex-1 bg-background">
      <View className="w-full self-center px-6 pt-6" style={{ maxWidth: 820 }}>
        <Text className="text-2xl font-semibold text-foreground">Later</Text>
        <View className="mt-3 flex-row items-center gap-2">
          {([
            { key: 'saved', label: 'Saved', icon: Bookmark },
            { key: 'reminders', label: 'Reminders', icon: AlarmClock },
            { key: 'scheduled', label: 'Scheduled', icon: Clock },
          ] as const).map(({ key, label, icon: Icon }) => (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === key }}
              onPress={() => setTab(key)}
              className={cn('flex-row items-center gap-1.5 rounded-full border px-3 py-1', tab === key ? 'border-primary bg-primary/10' : 'border-border')}
            >
              <Icon size={12} className={tab === key ? 'text-primary' : 'text-muted-foreground'} />
              <Text className={cn('text-xs', tab === key ? 'text-primary' : 'text-muted-foreground')}>
                {label}{counts[key] ? ` · ${counts[key]}` : ''}
              </Text>
            </Pressable>
          ))}
          {later.loading ? <ActivityIndicator size="small" /> : null}
        </View>
        {later.error ? <Text className="mt-3 text-sm text-destructive">{later.error}</Text> : null}
      </View>

      <FlatList
        data={(tab === 'saved' ? later.saved : tab === 'reminders' ? later.reminders : later.scheduled) as any[]}
        keyExtractor={(item: any) => item.id ?? item.message.id}
        contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 16, maxWidth: 820, width: '100%', alignSelf: 'center' }}
        ListEmptyComponent={!later.loading ? <Text className="mt-8 text-center text-sm text-muted-foreground">{empty}</Text> : null}
        renderItem={({ item }: { item: any }) => {
          if (tab === 'saved') {
            const m = item.message
            const ConvIcon = item.conversation.kind === 'private' ? Lock : item.conversation.kind === 'public' ? Hash : MessageSquare
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => open(m.conversationId, m.id, m.threadRootId)}
                className="mb-2 rounded-md border border-border px-4 py-3 active:bg-muted/60 web:hover:bg-muted/40"
              >
                <View className="flex-row items-center gap-1.5">
                  <ConvIcon size={12} className="text-muted-foreground" />
                  <Text className="text-xs font-medium text-muted-foreground">{where(item.conversation)}</Text>
                  <Text className="text-xs text-muted-foreground">· {m.authorType === 'agent' ? m.authorAgent?.name ?? 'Agent' : m.author?.name ?? 'Someone'}</Text>
                  <View className="flex-1" />
                  <Pressable accessibilityLabel="Remove from saved" hitSlop={8} onPress={() => void later.unsave(m.id)}>
                    <X size={14} className="text-muted-foreground" />
                  </Pressable>
                </View>
                <Text className="mt-1 text-sm text-foreground" numberOfLines={3}>{plain(m.text, names)}</Text>
              </Pressable>
            )
          }
          if (tab === 'reminders') {
            const overdue = item.status === 'fired'
            return (
              <View className={cn('mb-2 rounded-md border px-4 py-3', overdue ? 'border-primary/40 bg-primary/5' : 'border-border')}>
                <View className="flex-row items-center gap-2">
                  <AlarmClock size={14} className={overdue ? 'text-primary' : 'text-muted-foreground'} />
                  <Pressable className="flex-1" onPress={() => open(item.conversationId, item.messageId)} disabled={!item.conversationId}>
                    <Text className="text-sm text-foreground" numberOfLines={2}>{plain(item.text, names)}</Text>
                    <Text className="text-xs text-muted-foreground">{overdue ? 'Due ' : ''}{when(item.remindAt)}</Text>
                  </Pressable>
                  <Pressable accessibilityLabel="Snooze" onPress={() => setSnoozing(snoozing === item.id ? null : item.id)} className="rounded-md px-2 py-1 active:bg-muted">
                    <Text className="text-xs text-muted-foreground">Snooze</Text>
                  </Pressable>
                  <Pressable accessibilityLabel="Mark done" onPress={() => void later.completeReminder(item.id)} className="rounded-md p-1 active:bg-muted">
                    <Check size={14} className="text-primary" />
                  </Pressable>
                </View>
                {snoozing === item.id ? (
                  <View className="mt-2 flex-row flex-wrap gap-2">
                    {snoozeChoices.map((o) => (
                      <Pressable
                        key={o.label}
                        onPress={() => {
                          setSnoozing(null)
                          void later.snoozeReminder(item.id, o.at.toISOString())
                        }}
                        className="rounded-full border border-border px-3 py-1 active:bg-accent/50"
                      >
                        <Text className="text-xs text-muted-foreground">{o.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            )
          }
          return (
            <View className={cn('mb-2 rounded-md border px-4 py-3', item.status === 'failed' ? 'border-destructive/40' : 'border-border')}>
              <View className="flex-row items-center gap-1.5">
                <Clock size={12} className="text-muted-foreground" />
                <Text className="text-xs font-medium text-muted-foreground">{where(item.conversation)}{item.threadRootId ? ' · in thread' : ''}</Text>
                <Text className="text-xs text-muted-foreground">· {when(item.sendAt)}</Text>
                <View className="flex-1" />
                <Pressable accessibilityLabel="Cancel scheduled message" hitSlop={8} onPress={() => void later.cancelScheduled(item.id)}>
                  <X size={14} className="text-muted-foreground" />
                </Pressable>
              </View>
              <Text className="mt-1 text-sm text-foreground" numberOfLines={3}>{plain(item.text, names)}</Text>
              {item.status === 'failed' ? (
                <View className="mt-1 flex-row items-center gap-2">
                  <Text className="flex-1 text-xs text-destructive">Not sent: {item.error ?? 'unknown error'}</Text>
                  <Pressable onPress={() => void later.reschedule(item.id, new Date(Date.now() + 60_000).toISOString())}>
                    <Text className="text-xs font-medium text-primary">Retry</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          )
        }}
      />
    </View>
  )
}
