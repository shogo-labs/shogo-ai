// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useMemo } from 'react'
import { Platform, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Bell, Keyboard, Plus, Search, type LucideIcon } from 'lucide-react-native'
import { ConversationRow, PanelLink, PanelSection } from '../ConversationRows'
import { useTeamChatNav } from '../TeamChatSidebarProvider'
import type { ConversationSummary } from '../../../lib/team-chat-api'
import { sidebarChannels } from '../../../lib/channel-list'

/** One labelled group of channel rows, plus the links that sit under the rows. */
export interface ChannelPanelSection {
  key: string
  label: string
  addLabel?: string
  onAdd?: () => void
  /** No chevron; always open. */
  fixed?: boolean
  defaultCollapsed?: boolean
  conversations: ConversationSummary[]
  links: { key: string; icon: LucideIcon; label: string; onPress: () => void }[]
}

/**
 * The channel sections as data, so a virtualized list can render each row and
 * each section header itself while the sidebar renders them stacked. Both get
 * the same groups in the same order.
 */
export function useChannelPanelSections({ onNavPress }: { onNavPress?: () => void } = {}): ChannelPanelSection[] {
  const router = useRouter()
  const chat = useTeamChatNav()
  const { starred, others, archived } = useMemo(() => sidebarChannels(chat.list), [chat.list])
  const go = useCallback(
    (href: string) => {
      router.push(href as any)
      onNavPress?.()
    },
    [router, onNavPress],
  )
  const enabled = chat.enabled && !!chat.workspaceId
  const activeId = chat.activeId
  const startCreate = chat.startCreate
  const openShortcuts = chat.openShortcuts

  return useMemo(() => {
    if (!enabled) return []
    const sections: ChannelPanelSection[] = []
    if (starred.length > 0) {
      sections.push({ key: 'starred', label: 'Starred', conversations: starred, links: [] })
    }
    sections.push({
      key: 'channels',
      label: 'Channels',
      addLabel: 'Create channel',
      onAdd: () => startCreate('channel'),
      conversations: others,
      links: [{ key: 'browse', icon: Plus, label: 'Browse channels', onPress: () => go('/(app)/c') }],
    })
    if (archived.length > 0) {
      sections.push({
        key: 'archived',
        label: `Archived (${archived.length})`,
        defaultCollapsed: !archived.some((c) => c.id === activeId),
        conversations: archived,
        links: [],
      })
    }
    sections.push({
      key: 'find',
      label: 'Find and tune',
      fixed: true,
      conversations: [],
      links: [
        { key: 'search', icon: Search, label: 'Search messages', onPress: () => go('/(app)/c/search') },
        { key: 'prefs', icon: Bell, label: 'Chat preferences', onPress: () => go('/(app)/settings?tab=chat') },
        ...(Platform.OS === 'web'
          ? [{ key: 'shortcuts', icon: Keyboard, label: 'Keyboard shortcuts', onPress: openShortcuts }]
          : []),
      ],
    })
    return sections
  }, [enabled, starred, others, archived, activeId, startCreate, go, openShortcuts])
}

/** Joined channels (starred first), archived ones under their own label, and the ways to find and tune the rest. */
export function ChannelsPanel({ onNavPress }: { onNavPress?: () => void }) {
  const chat = useTeamChatNav()
  const sections = useChannelPanelSections({ onNavPress })
  if (!chat.enabled || !chat.workspaceId) return null
  const row = (c: ConversationSummary) => (
    <ConversationRow key={c.id} conversation={c} workspaceId={chat.workspaceId!} active={chat.activeId === c.id} onPress={chat.openConversation} />
  )
  return (
    <View className="px-2" testID="channels-panel">
      {sections.map((section) => (
        <PanelSection
          key={section.key}
          label={section.label}
          addLabel={section.addLabel}
          onAdd={section.onAdd}
          fixed={section.fixed}
          defaultCollapsed={section.defaultCollapsed}
        >
          {section.conversations.map(row)}
          {section.links.map((link) => (
            <PanelLink key={link.key} icon={link.icon} label={link.label} onPress={link.onPress} />
          ))}
        </PanelSection>
      ))}
    </View>
  )
}
