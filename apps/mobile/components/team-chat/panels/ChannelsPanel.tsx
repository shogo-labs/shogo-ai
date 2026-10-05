// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo } from 'react'
import { Platform, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Bell, Keyboard, Plus, Search } from 'lucide-react-native'
import { ConversationRow, PanelLink, PanelSection } from '../ConversationRows'
import { useTeamChatNav } from '../TeamChatSidebarProvider'
import type { ConversationSummary } from '../../../lib/team-chat-api'

const isChannel = (c: ConversationSummary) => c.kind === 'public' || c.kind === 'private' || c.kind === 'activity'

/** Joined channels (starred first), plus the ways to find and tune the rest. */
export function ChannelsPanel({ onNavPress }: { onNavPress?: () => void }) {
  const router = useRouter()
  const chat = useTeamChatNav()
  const { starred, others } = useMemo(() => {
    const channels = chat.list.filter((c) => isChannel(c) && !c.archivedAt && (c.joined || c.kind === 'activity'))
    const byName = (a: ConversationSummary, b: ConversationSummary) => {
      if (a.kind === 'activity' && b.kind !== 'activity') return 1
      if (b.kind === 'activity' && a.kind !== 'activity') return -1
      return (a.name ?? '').localeCompare(b.name ?? '')
    }
    return {
      starred: channels.filter((c) => c.starred).sort(byName),
      others: channels.filter((c) => !c.starred).sort(byName),
    }
  }, [chat.list])
  const go = (href: string) => {
    router.push(href as any)
    onNavPress?.()
  }
  if (!chat.enabled || !chat.workspaceId) return null
  const row = (c: ConversationSummary) => (
    <ConversationRow key={c.id} conversation={c} workspaceId={chat.workspaceId!} active={chat.activeId === c.id} onPress={chat.openConversation} />
  )
  return (
    <View className="px-2" testID="channels-panel">
      {starred.length > 0 && <PanelSection label="Starred">{starred.map(row)}</PanelSection>}
      <PanelSection label="Channels" addLabel="Create channel" onAdd={() => chat.startCreate('channel')}>
        {others.map(row)}
        <PanelLink icon={Plus} label="Browse channels" onPress={() => go('/(app)/c')} />
      </PanelSection>
      <PanelSection label="Find and tune" fixed>
        <PanelLink icon={Search} label="Search messages" onPress={() => go('/(app)/c/search')} />
        <PanelLink icon={Bell} label="Chat preferences" onPress={() => go('/(app)/c/settings')} />
        {Platform.OS === 'web' && <PanelLink icon={Keyboard} label="Keyboard shortcuts" onPress={chat.openShortcuts} />}
      </PanelSection>
    </View>
  )
}
