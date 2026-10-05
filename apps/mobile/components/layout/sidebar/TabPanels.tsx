// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Home and More panels of the desktop sidebar. Channels, DMs, Agents,
 * Projects and Activity have panels of their own.
 */
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Bookmark, ChevronRight, FileText, ListTodo, MessageCircle, MessagesSquare, Store } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useHomeSignals } from '../../../hooks/useHomeSignals'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
// Leaf import: the `@shogo/shared-app` barrel also loads the domain SDK.
import { TASKS_NAV_HIDDEN } from '../../../../../packages/shared-app/src/hooks/useWorkspaceExperience'
import type { ActivityEntry } from '../../../lib/activity-feed'
import { moreItems, type MoreIcon } from '../../../lib/more-items'
import { usePlatformConfig } from '../../../lib/platform-config'
import { RunningNow } from '../../activity/ActivityFeed'
import { ConversationRow, PanelLink, PanelSection } from '../../team-chat/ConversationRows'
import { useTeamChatNav } from '../../team-chat/TeamChatSidebarProvider'
import { NavItem } from './NavItem'

const MORE_ICONS: Record<MoreIcon, React.ElementType> = {
  tasks: ListTodo,
  marketplace: Store,
  'side-chats': MessagesSquare,
  files: FileText,
}

export interface HomePanelProps {
  /** Pinned projects, rendered by the sidebar that owns the project state. */
  pinned?: ReactNode
  onNavPress?: () => void
  isHomeRoute: boolean
}

/**
 * Team Home: the workspace agent first, what agents are doing, what needs
 * you, then starred conversations and pinned projects.
 */
export function HomePanel({ pinned, onNavPress, isHomeRoute }: HomePanelProps) {
  const router = useRouter()
  const { chat, running, failed, mentions, starred, openEntry } = useHomeSignals()
  const open = (entry: ActivityEntry) => {
    openEntry(entry)
    onNavPress?.()
  }
  const needsYou = failed.length + mentions.length

  return (
    <View testID="home-panel">
      <View className="px-2">
        <NavItem icon={MessageCircle} label="Workspace agent" href="/(app)/agent" active={isHomeRoute} onNavPress={onNavPress} />
        {!TASKS_NAV_HIDDEN && <NavItem icon={ListTodo} label="Tasks" href="/(app)/tasks" onNavPress={onNavPress} />}
      </View>

      {running.length > 0 && <RunningNow entries={running} compact onOpen={open} />}

      {needsYou > 0 && (
        <View className="mt-3 px-2">
          <PanelSection label="Needs you">
            {failed.map((entry) => (
              <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`${entry.title}, failed`} onPress={() => open(entry)} className="rounded-md px-2 py-1.5 active:bg-accent/50">
                <Text className="text-xs font-medium text-foreground" numberOfLines={1}>{entry.title}</Text>
                <Text className="text-xs text-destructive" numberOfLines={1}>{`Failed · ${entry.context.replace('Agent task in ', '')}`}</Text>
              </Pressable>
            ))}
            {chat.workspaceId &&
              mentions.map((c) => (
                <ConversationRow key={c.id} conversation={c} workspaceId={chat.workspaceId!} active={chat.activeId === c.id} onPress={chat.openConversation} />
              ))}
          </PanelSection>
        </View>
      )}

      {starred.length > 0 && chat.workspaceId && (
        <View className="mt-3 px-2">
          <PanelSection label="Starred">
            {starred.map((c) => (
              <ConversationRow key={c.id} conversation={c} workspaceId={chat.workspaceId!} active={chat.activeId === c.id} onPress={chat.openConversation} />
            ))}
          </PanelSection>
        </View>
      )}

      {pinned}

      {chat.enabled && (
        <View className="mt-3 px-2">
          <PanelLink
            icon={Bookmark}
            label="Later"
            onPress={() => {
              router.push('/(app)/c/later' as any)
              onNavPress?.()
            }}
          />
        </View>
      )}
    </View>
  )
}

/** A short list of the places that do not have a tab of their own. */
export function MorePanel({ onNavPress, variant = 'panel' }: { onNavPress?: () => void; variant?: 'panel' | 'screen' }) {
  const router = useRouter()
  const experience = useWorkspaceExperience()
  const { features } = usePlatformConfig()
  const items = moreItems({ kind: experience.kind, marketplace: !!features.marketplace && experience.showMarketplace })
  const screen = variant === 'screen'
  return (
    <View className={cn(screen ? 'px-2' : 'px-2 pt-1')} testID="more-panel">
      {items.map((item) => {
        const Icon = MORE_ICONS[item.icon]
        return (
          <Pressable
            key={item.id}
            accessibilityRole="link"
            accessibilityLabel={item.title}
            onPress={() => {
              router.push(item.href as any)
              onNavPress?.()
            }}
            className={cn('flex-row items-center gap-3 rounded-md active:bg-accent/50', screen ? 'px-3 py-3.5' : 'px-2 py-2')}
          >
            <Icon size={screen ? 22 : 18} className="text-muted-foreground" />
            <View className="min-w-0 flex-1">
              <Text className={cn('text-foreground', screen ? 'text-base' : 'text-sm')}>{item.title}</Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={2}>{item.subtitle}</Text>
            </View>
            {screen && <ChevronRight size={16} className="text-muted-foreground" />}
          </Pressable>
        )
      })}
    </View>
  )
}
