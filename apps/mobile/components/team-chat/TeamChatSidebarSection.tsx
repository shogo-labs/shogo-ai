// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sidebar block for workspace team chat: starred, channels, direct messages
 * and agent DMs, with unread/mention badges kept live over the realtime
 * connection.
 */
import { useEffect, useMemo, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import { Bell, Bookmark, Bot, ChevronDown, ChevronRight, Hash, Inbox, Keyboard, Lock, MessagesSquare, Pencil, Plus, Radio, Search, Users } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { densityFor } from '../../lib/phone-density'
import { usePhoneLayout } from '../../lib/native-phone-layout'
import { conversationTitle, nativeChatVisible, type ConversationSummary } from '../../lib/team-chat-api'
import { useWorkspaceChatMode } from '../../hooks/useWorkspaceChatMode'
import { useConversationList, useMentionables, useMyUserId, invalidateConversationList } from '../../hooks/useTeamChat'
import { useInboxFeed, useInboxUnread, useStatusFeed } from '../../hooks/useChatPrefs'
import { usePresenceFeed } from '../../hooks/usePresence'
import { PresenceDot } from './PresenceDot'
import { useDraftsFeed, useHasDraft, useSavedFeed } from '../../hooks/useChatItems'
import { useCustomEmojiFeed } from '../../hooks/useCustomEmoji'
import { ShortcutsHelp, useChatShortcuts } from '../../hooks/useChatShortcuts'
import { setChatBadgeCount } from '../../lib/team-chat-badge'
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

export function TeamChatSidebarSection(props: TeamChatSidebarSectionProps) {
  const { config } = useWorkspaceChatMode(props.workspaceId)
  if (!nativeChatVisible(config?.mode)) return null
  return <TeamChatSidebarContent {...props} />
}

function TeamChatSidebarContent({ workspaceId, collapsed, onNavPress }: TeamChatSidebarSectionProps) {
  const router = useRouter()
  const pathname = usePathname()
  const me = useMyUserId()
  const mentionables = useMentionables(workspaceId)
  const { groups, list } = useConversationList(workspaceId)
  const [creating, setCreating] = useState<NewConversationMode | null>(null)
  useStatusFeed(workspaceId)
  usePresenceFeed(workspaceId)
  useInboxFeed(workspaceId)
  useSavedFeed(workspaceId)
  useDraftsFeed(workspaceId)
  useCustomEmojiFeed(workspaceId)
  const inboxUnread = useInboxUnread(workspaceId)
  const comfortable = usePhoneLayout()
  const density = densityFor(comfortable)

  const activeId = pathname.match(/\/c\/([^/?]+)/)?.[1]
  const totalUnread = list.reduce((n, c) => n + (c.muted ? 0 : c.mentionCount || (c.kind === 'dm' || c.kind === 'group_dm' ? c.unreadCount : 0)), 0)
  const dmUnread = list.reduce((n, c) => n + (!c.muted && (c.kind === 'dm' || c.kind === 'group_dm') ? c.unreadCount : 0), 0)
  useEffect(() => setChatBadgeCount(dmUnread + inboxUnread), [dmUnread, inboxUnread])
  useEffect(() => () => setChatBadgeCount(0), [])

  const ordered = useMemo(() => {
    const seen = new Set<string>()
    return [...groups.starred, ...groups.channels, ...groups.directMessages, ...groups.agents].filter((c) => !seen.has(c.id) && seen.add(c.id))
  }, [groups])
  const shortcuts = useChatShortcuts({ ordered, activeId: activeId ? decodeURIComponent(activeId) : null, hrefFor: conversationHref })
  const [helpOpen, setHelpOpen] = useState(false)

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
    const peers = c.kind === 'dm' ? (c.participants ?? []) : []
    const dmPeer = peers.length === 1 && peers[0]!.type === 'user' ? peers[0]!.id : null
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
        {dmPeer ? (
          <View style={{ width: comfortable ? density.icon.nav : 12 }} className="items-center">
            <PresenceDot userId={dmPeer} workspaceId={workspaceId} />
          </View>
        ) : (
          <Icon size={comfortable ? density.icon.nav : 12} className={active || unread ? 'text-foreground' : 'text-muted-foreground'} />
        )}
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
        {!active && <DraftMark conversationId={c.id} />}
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
        <View>
          {([
            { label: 'Inbox', icon: Inbox, href: '/(app)/c/inbox', count: inboxUnread },
            { label: 'Later', icon: Bookmark, href: '/(app)/c/later', count: 0 },
            { label: 'Browse channels', icon: Plus, href: '/(app)/c', count: 0 },
            { label: 'Search messages', icon: Search, href: '/(app)/c/search', count: 0 },
            { label: 'Preferences', icon: Bell, href: '/(app)/c/settings', count: 0 },
            ...(Platform.OS === 'web' ? [{ label: 'Keyboard shortcuts', icon: Keyboard, href: null, count: 0 }] : []),
          ] as const).map(({ label, icon: Icon, href, count }) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={count ? `${label}, ${count} unread` : label}
              onPress={() => {
                if (!href) {
                  setHelpOpen(true)
                  return
                }
                router.push(href as any)
                onNavPress?.()
              }}
              className={cn('flex-row items-center rounded-md active:bg-accent/50', comfortable ? `${density.rowMin} gap-3 px-3 py-2` : 'gap-2 px-2 py-1')}
            >
              <Icon size={comfortable ? density.icon.nav : 12} className={count ? 'text-foreground' : 'text-muted-foreground'} />
              <Text className={cn('flex-1', count ? 'font-semibold text-foreground' : 'text-muted-foreground', comfortable ? density.text.body : 'text-xs')}>{label}</Text>
              {count > 0 && (
                <View className="min-w-[18px] items-center rounded-full bg-destructive px-1.5">
                  <Text className="text-[10px] font-semibold text-white">{count > 99 ? '99+' : count}</Text>
                </View>
              )}
            </Pressable>
          ))}
        </View>,
      )}
      {section('Direct messages', groups.directMessages, 'dm')}
      {section('Agents', groups.agents, 'agent')}
      <ShortcutsHelp
        visible={helpOpen || shortcuts.helpOpen}
        onClose={() => {
          setHelpOpen(false)
          shortcuts.closeHelp()
        }}
      />
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

function DraftMark({ conversationId }: { conversationId: string }) {
  const hasDraft = useHasDraft(conversationId)
  return hasDraft ? <Pencil size={11} className="text-muted-foreground" accessibilityLabel="Draft" /> : null
}
