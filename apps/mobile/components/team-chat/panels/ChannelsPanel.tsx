// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo } from 'react'
import { Platform, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Bell, Keyboard, Plus, Search } from 'lucide-react-native'
import { ConversationRow, PanelLink, PanelSection } from '../ConversationRows'
import { useTeamChatNav } from '../TeamChatSidebarProvider'
import type { ConversationSummary } from '../../../lib/team-chat-api'
import { sidebarChannels } from '../../../lib/channel-list'

/** Joined channels (starred first), archived ones under their own label, and the ways to find and tune the rest. */
export function ChannelsPanel({ onNavPress }: { onNavPress?: () => void }) {
  const router = useRouter()
  const chat = useTeamChatNav()
  const { starred, others, archived } = useMemo(() => sidebarChannels(chat.list), [chat.list])
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
      {archived.length > 0 && (
        <PanelSection label={`Archived (${archived.length})`} defaultCollapsed={!archived.some((c) => c.id === chat.activeId)}>
          {archived.map(row)}
        </PanelSection>
      )}
      <PanelSection label="Find and tune" fixed>
        <PanelLink icon={Search} label="Search messages" onPress={() => go('/(app)/c/search')} />
        <PanelLink icon={Bell} label="Chat preferences" onPress={() => go('/(app)/c/settings')} />
        {Platform.OS === 'web' && <PanelLink icon={Keyboard} label="Keyboard shortcuts" onPress={chat.openShortcuts} />}
      </PanelSection>
    </View>
  )
}
