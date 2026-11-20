// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useMemo } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Bell, Keyboard, Plus, Search, UserPlus, type LucideIcon } from 'lucide-react-native'
import { ConversationRow, PanelLink, PanelSection } from '../ConversationRows'
import { useTeamChatNav } from '../TeamChatSidebarProvider'
import type { ConversationSummary } from '../../../lib/team-chat-api'
import { sidebarChannels } from '../../../lib/channel-list'
import { usePermissions } from '../../../hooks/usePermissions'
import { useInviteDialog } from '../../workspace/invite-dialog-context'

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
  const inviteDialog = useInviteDialog()
  const { canInvite } = usePermissions({ workspaceId: chat.workspaceId })

  // "You're the only one here" (SHO-454): a workspace with one human member has
  // nobody to talk to, so the panel says so and offers the invite dialog. The
  // people list is the one the pickers already load, so this costs no request.
  const onlyOneHere = canInvite && !!chat.mentionables && chat.mentionables.people.length <= 1

  if (!chat.enabled || !chat.workspaceId) return null
  const row = (c: ConversationSummary) => (
    <ConversationRow key={c.id} conversation={c} workspaceId={chat.workspaceId!} active={chat.activeId === c.id} onPress={chat.openConversation} />
  )
  return (
    <View className="px-2" testID="channels-panel">
      {onlyOneHere && (
        <Pressable
          testID="channels-panel-invite"
          onPress={() => inviteDialog.openInviteDialog(chat.workspaceId)}
          accessibilityLabel="You're the only one here. Invite your team."
          className="mx-1 mb-2 flex-row items-center gap-2 rounded-lg bg-primary/10 px-3 py-2.5 active:bg-primary/20"
        >
          <UserPlus size={15} className="text-primary" />
          <View className="min-w-0 flex-1">
            <Text className="text-xs font-medium text-foreground">You&apos;re the only one here</Text>
            <Text className="text-[11px] text-muted-foreground">Invite your team to start a conversation.</Text>
          </View>
        </Pressable>
      )}
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
