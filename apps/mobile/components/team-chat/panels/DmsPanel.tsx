// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Conversations with people, and links to agent chat histories. `variant="panel"`
 * is the compact desktop list; `variant="screen"` adds the row of recent faces
 * and roomier rows for the mobile DMs tab. A chat with an agent is a project/
 * workspace chat session, not a DM conversation (SHO-412 / SHO-473).
 */
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronRight, Plus } from 'lucide-react-native'
import { Avatar, cn } from '@shogo/shared-ui/primitives'
import { ConversationRow, CountPill, PanelLink, PanelSection, attentionCount, rowTitle } from '../ConversationRows'
import { PresenceDot } from '../PresenceDot'
import { useTeamChatNav } from '../TeamChatSidebarProvider'
import { resolveAvatarUrl } from '../../../lib/chat-attachment-url'
import { DM_FILTERS, splitStarredDms, recentContacts, type DmFilter } from '../../../lib/dm-list'
import { type ConversationSummary } from '../../../lib/team-chat-api'
import { AgentAvatar } from '../AgentAvatar'
import { useRecentAgentChats } from '../../../hooks/useRecentAgentChats'
import { relativeTime } from '../../../lib/activity-feed'

// In the sidebar the panel sits inside the sidebar's own scroll view.
function Rows({ children, ...props }: any) {
  return props.contentContainerClassName ? <ScrollView {...props}>{children}</ScrollView> : <View className={cn('pb-2')}>{children}</View>
}

export function DmsPanel({ variant = 'panel', initialFilter }: { variant?: 'panel' | 'screen'; initialFilter?: DmFilter }) {
  const router = useRouter()
  const chat = useTeamChatNav()
  const [filter, setFilter] = useState<DmFilter>(initialFilter ?? 'all')
  const { starred, others } = useMemo(() => splitStarredDms(chat.list, filter), [chat.list, filter])
  const contacts = useMemo(() => recentContacts(chat.list), [chat.list])
  const { chats: recentChats } = useRecentAgentChats({ limit: 20, perAgent: false })
  const screen = variant === 'screen'

  const agents = chat.mentionables?.agents ?? []

  /** Navigate to that agent's full chat list. */
  const openAgentChats = (projectId: string | null) => {
    if (projectId === null) {
      router.push('/(app)/chats' as any)
    } else {
      router.push({ pathname: '/(app)/project-chats', params: { id: projectId } } as any)
    }
  }

  // Build per-agent last-chat data from recent chats.
  const lastChatByAgent = useMemo(() => {
    const map = new Map<string, (typeof recentChats)[number]>()
    for (const c of recentChats) {
      const key = c.projectId ?? 'ws'
      if (!map.has(key)) map.set(key, c)
    }
    return map
  }, [recentChats])

  // Sort: agents with chats first (newest first), then rest alphabetically.
  const sortedAgents = useMemo(() => {
    const chatted = agents.filter((a) => lastChatByAgent.has(a.projectId ?? 'ws'))
    const rest = agents.filter((a) => !lastChatByAgent.has(a.projectId ?? 'ws'))
    chatted.sort((a, b) => {
      const aT = lastChatByAgent.get(a.projectId ?? 'ws')?.lastActiveAt ?? ''
      const bT = lastChatByAgent.get(b.projectId ?? 'ws')?.lastActiveAt ?? ''
      return bT.localeCompare(aT)
    })
    rest.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    return [...chatted, ...rest]
  }, [agents, lastChatByAgent])

  if (!chat.enabled || !chat.workspaceId) return null
  const workspaceId = chat.workspaceId

  // No "Note to self" shortcut: every member is provisioned one, so it is
  // already a row below, under your own name.

  const row = (c: ConversationSummary) => (
    <ConversationRow key={c.id} conversation={c} workspaceId={workspaceId} active={chat.activeId === c.id} preview={screen} onPress={chat.openConversation} />
  )

  const showAgents = filter === 'agents' || filter === 'all'
  const showPeople = filter !== 'agents'

  return (
    <View className={cn(screen ? 'flex-1' : 'px-2')} testID="dms-panel">
      {screen && contacts.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="shrink-0 grow-0" contentContainerClassName="gap-4 px-4 py-3">
          {contacts.map((c) => (
            <Contact key={c.id} conversation={c} workspaceId={workspaceId} onPress={chat.openConversation} />
          ))}
        </ScrollView>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-12 shrink-0 grow-0" contentContainerClassName={cn('items-center gap-2 py-2', screen ? 'px-4' : 'px-1')}>
        {DM_FILTERS.map(({ id, label }) => (
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

      <Rows className={cn(screen && 'flex-1')} {...(screen ? { contentContainerClassName: 'px-2 pb-28' } : { })}>
        {showAgents && sortedAgents.length > 0 && (
          <PanelSection label="Agents">
            {sortedAgents.map((agent) => {
              const lastChat = lastChatByAgent.get(agent.projectId ?? 'ws')
              const subtitle = lastChat
                ? `${lastChat.title} · ${relativeTime(Date.parse(lastChat.lastActiveAt))}`
                : 'Start a chat'
              return (
                <Pressable
                  key={agent.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${agent.name ?? 'Agent'}, ${subtitle}`}
                  onPress={() => openAgentChats(agent.projectId)}
                  className="flex-row items-center gap-3 rounded-lg px-2 py-2.5 active:bg-muted/50"
                >
                  <AgentAvatar
                    name={agent.name ?? 'Agent'}
                    projectId={agent.projectId}
                    workspaceId={workspaceId}
                    size={screen ? 36 : 28}
                  />
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{agent.name ?? 'Agent'}</Text>
                    <Text className="text-xs text-muted-foreground" numberOfLines={1}>{subtitle}</Text>
                  </View>
                  <ChevronRight size={16} className="text-muted-foreground" />
                </Pressable>
              )
            })}
          </PanelSection>
        )}
        {showPeople && starred.length > 0 && <PanelSection label="Starred">{starred.map(row)}</PanelSection>}
        {showPeople && others.map(row)}
        {showAgents && sortedAgents.length === 0 && showPeople && starred.length === 0 && others.length === 0 && (
          <Text className="px-3 py-4 text-xs text-muted-foreground">{'No conversations yet.'}</Text>
        )}
        {!showAgents && starred.length === 0 && others.length === 0 && (
          <Text className="px-3 py-4 text-xs text-muted-foreground">{filter === 'unreads' ? "You're all caught up." : 'No conversations yet.'}</Text>
        )}
        {showPeople && <PanelLink icon={Plus} label="New message" onPress={() => chat.startCreate('message')} />}
      </Rows>
    </View>
  )
}

function Contact({ conversation: c, workspaceId, onPress }: { conversation: ConversationSummary; workspaceId: string; onPress: (c: ConversationSummary) => void }) {
  const peer = (c.participants ?? [])[0]
  const name = rowTitle(c).split(' ')[0] ?? ''
  const unread = attentionCount(c)
  return (
    <Pressable onPress={() => onPress(c)} accessibilityRole="button" accessibilityLabel={`${rowTitle(c)}${unread ? `, ${unread} unread` : ''}`} className="w-14 items-center gap-1">
      <View>
        <Avatar fallback={name.slice(0, 1).toUpperCase()} src={peer?.type === 'user' ? resolveAvatarUrl(peer.image) : null} size="lg" />
        {peer?.type === 'user' && <PresenceDot userId={peer.id} workspaceId={workspaceId} badge size={12} />}
        {unread > 0 && (
          <View className="absolute -right-1 -top-1">
            <CountPill count={unread} />
          </View>
        )}
      </View>
      <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>{name}</Text>
    </Pressable>
  )
}
