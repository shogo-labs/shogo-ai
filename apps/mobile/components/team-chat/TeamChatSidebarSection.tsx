// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sidebar block for workspace team chat: starred, channels, direct messages
 * and agent DMs, with unread/mention badges kept live over the realtime
 * connection.
 */
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import { Bot, ChevronDown, ChevronRight, Hash, Lock, MessagesSquare, Plus, Radio, Users } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { densityFor } from '../../lib/phone-density'
import { usePhoneLayout } from '../../lib/native-phone-layout'
import { conversationTitle, type ConversationSummary } from '../../lib/team-chat-api'
import { useConversationList, useMentionables, useMyUserId, invalidateConversationList } from '../../hooks/useTeamChat'
import { NewConversationModal, type NewConversationMode } from './NewConversationModal'
import { NavItem } from '../layout/sidebar/NavItem'

export interface TeamChatSidebarSectionProps {
  workspaceId: string
  collapsed?: boolean
  onNavPress?: () => void
}

const ADD_LABELS: Record<NewConversationMode, string> = {
  channel: 'Create channel',
  dm: 'New message',
  agent: 'Message an agent',
}

export function conversationHref(id: string): string {
  return `/(app)/c/${encodeURIComponent(id)}`
}

function iconFor(c: ConversationSummary) {
  if (c.kind === 'activity') return Radio
  if (c.kind === 'private') return Lock
  if (c.kind === 'public') return Hash
  if ((c.participants ?? []).some((p) => p.type === 'agent')) return Bot
  return Users
}

export function TeamChatSidebarSection({ workspaceId, collapsed, onNavPress }: TeamChatSidebarSectionProps) {
  const router = useRouter()
  const pathname = usePathname()
  const me = useMyUserId()
  const mentionables = useMentionables(workspaceId)
  const { groups, list } = useConversationList(workspaceId)
  const [creating, setCreating] = useState<NewConversationMode | null>(null)
  const comfortable = usePhoneLayout()
  const density = densityFor(comfortable)

  const activeId = pathname.match(/\/c\/([^/?]+)/)?.[1]
  const totalUnread = list.reduce((n, c) => n + (c.muted ? 0 : c.mentionCount || (c.kind === 'dm' || c.kind === 'group_dm' ? c.unreadCount : 0)), 0)

  if (collapsed) {
    return (
      <View className="px-2">
        <NavItem icon={MessagesSquare} label={totalUnread ? `Chat (${totalUnread})` : 'Chat'} href="/(app)/c" active={/\/c(\/|$)/.test(pathname)} collapsed onNavPress={onNavPress} />
      </View>
    )
  }

  const open = (c: ConversationSummary) => {
    router.push(conversationHref(c.id) as any)
    onNavPress?.()
  }

  const row = (c: ConversationSummary) => {
    const Icon = iconFor(c)
    const active = activeId === c.id
    const unread = !active && c.unreadCount > 0 && !c.muted && c.joined
    const title = c.kind === 'public' || c.kind === 'private' || c.kind === 'activity' ? c.name ?? 'channel' : conversationTitle(c)
    return (
      <Pressable
        key={c.id}
        onPress={() => open(c)}
        accessibilityRole="link"
        accessibilityLabel={`${title}${c.mentionCount ? `, ${c.mentionCount} mentions` : unread ? ', unread' : ''}`}
        className={cn(
          'flex-row items-center rounded-md',
          comfortable ? `${density.rowMin} gap-3 px-3 py-2` : 'gap-2 px-2 py-1',
          active ? 'bg-accent' : 'active:bg-accent/50',
        )}
      >
        <Icon size={comfortable ? density.icon.nav : 12} className={active || unread ? 'text-foreground' : 'text-muted-foreground'} />
        <Text
          className={cn(
            'flex-1',
            comfortable ? density.text.body : 'text-xs',
            active || unread ? 'text-foreground' : 'text-muted-foreground',
            unread && 'font-semibold',
          )}
          numberOfLines={1}
        >
          {title}
        </Text>
        {c.mentionCount > 0 && !active && (
          <View className="min-w-[18px] items-center rounded-full bg-destructive px-1.5">
            <Text className="text-[10px] font-semibold text-white">{c.mentionCount > 99 ? '99+' : c.mentionCount}</Text>
          </View>
        )}
      </Pressable>
    )
  }

  const section = (label: string, items: ConversationSummary[], addMode?: NewConversationMode, extra?: React.ReactNode) => (
    <Section key={label} label={label} addLabel={addMode ? ADD_LABELS[addMode] : undefined} onAdd={addMode ? () => setCreating(addMode) : undefined} labelClass={density.text.label}>
      {items.map(row)}
      {extra}
    </Section>
  )

  return (
    <View className={cn('px-2', comfortable ? 'mt-5' : 'mt-4')}>
      {groups.starred.length > 0 && section('Starred', groups.starred)}
      {section(
        'Channels',
        groups.channels,
        'channel',
        <Pressable
          onPress={() => {
            router.push('/(app)/c' as any)
            onNavPress?.()
          }}
          className={cn('flex-row items-center rounded-md active:bg-accent/50', comfortable ? `${density.rowMin} gap-3 px-3 py-2` : 'gap-2 px-2 py-1')}
        >
          <Plus size={comfortable ? density.icon.nav : 12} className="text-muted-foreground" />
          <Text className={cn('text-muted-foreground', comfortable ? density.text.body : 'text-xs')}>Browse channels</Text>
        </Pressable>,
      )}
      {section('Direct messages', groups.directMessages, 'dm')}
      {section('Agents', groups.agents, 'agent')}
      {creating && (
        <NewConversationModal
          workspaceId={workspaceId}
          mode={creating}
          mentionables={mentionables}
          me={me}
          onClose={() => setCreating(null)}
          onCreated={(c) => {
            setCreating(null)
            invalidateConversationList(workspaceId)
            open(c)
          }}
        />
      )}
    </View>
  )
}

function Section({ label, addLabel, onAdd, labelClass, children }: { label: string; addLabel?: string; onAdd?: () => void; labelClass: string; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(true)
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <View className="mb-2">
      <View className="flex-row items-center">
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
          className="flex-1 flex-row items-center gap-1.5 rounded-md px-1 py-1 active:bg-accent/50"
        >
          <Text className={cn('flex-1 font-semibold uppercase tracking-wider text-muted-foreground', labelClass)}>{label}</Text>
          <Chevron size={12} className="text-muted-foreground" />
        </Pressable>
        {onAdd && (
          <Pressable onPress={onAdd} accessibilityRole="button" accessibilityLabel={addLabel} className="rounded-md p-1 active:bg-accent/50 hover:bg-accent/50">
            <Plus size={12} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>
      {expanded && children}
    </View>
  )
}
