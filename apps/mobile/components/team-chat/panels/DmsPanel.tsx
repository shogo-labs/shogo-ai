// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Conversations with people and with agents, together. `variant="panel"` is
 * the compact desktop list; `variant="screen"` adds the row of recent faces
 * and roomier rows for the mobile DMs tab.
 */
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Plus } from 'lucide-react-native'
import { Avatar, cn } from '@shogo/shared-ui/primitives'
import { AgentMark } from '../../activity/ActivityFeed'
import { ConversationRow, CountPill, PanelLink, attentionCount, rowTitle } from '../ConversationRows'
import { PresenceDot } from '../PresenceDot'
import { useTeamChatNav } from '../TeamChatSidebarProvider'
import { DM_FILTERS, filterDms, isAgentDm, recentContacts, type DmFilter } from '../../../lib/dm-list'
import type { ConversationSummary } from '../../../lib/team-chat-api'

// In the sidebar the panel sits inside the sidebar's own scroll view.
function Rows({ children, ...props }: any) {
  return props.contentContainerClassName ? <ScrollView {...props}>{children}</ScrollView> : <View className={cn('pb-2')}>{children}</View>
}

export function DmsPanel({ variant = 'panel' }: { variant?: 'panel' | 'screen' }) {
  const chat = useTeamChatNav()
  const [filter, setFilter] = useState<DmFilter>('all')
  const rows = useMemo(() => filterDms(chat.list, filter), [chat.list, filter])
  const contacts = useMemo(() => recentContacts(chat.list), [chat.list])
  if (!chat.enabled || !chat.workspaceId) return null
  const workspaceId = chat.workspaceId
  const screen = variant === 'screen'

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
        {rows.map((c) => (
          <ConversationRow key={c.id} conversation={c} workspaceId={workspaceId} active={chat.activeId === c.id} preview={screen} onPress={chat.openConversation} />
        ))}
        {rows.length === 0 && (
          <Text className="px-3 py-4 text-xs text-muted-foreground">{filter === 'unreads' ? "You're all caught up." : 'No conversations yet.'}</Text>
        )}
        <PanelLink icon={Plus} label="New message" onPress={() => chat.startCreate('dm')} />
        <PanelLink icon={Plus} label="Message an agent" onPress={() => chat.startCreate('agent')} />
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
        {isAgentDm(c) ? (
          <AgentMark size={48} />
        ) : (
          <Avatar fallback={name.slice(0, 1).toUpperCase()} src={peer?.type === 'user' ? peer.image : null} size="lg" />
        )}
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
