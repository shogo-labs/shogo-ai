// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Home (workspace-agent chats) and More panels of the desktop sidebar.
 * Channels, DMs, Agents, Projects and Activity have panels of their own.
 */
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Bookmark, ChevronRight, FileText, KanbanSquare, ListTodo, Store } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
// Leaf import: the `@shogo/shared-app` barrel also loads the domain SDK.
import { TASKS_NAV_HIDDEN } from '../../../../../packages/shared-app/src/hooks/useWorkspaceExperience'
import { moreItems, type MoreIcon } from '../../../lib/more-items'
import { usePlatformConfig } from '../../../lib/platform-config'
import { PanelLink } from '../../team-chat/ConversationRows'
import { useTeamChatNav } from '../../team-chat/TeamChatSidebarProvider'
import { NavItem } from './NavItem'
import { WorkspaceChatsPanel } from './WorkspaceChatsPanel'

const MORE_ICONS: Record<MoreIcon, React.ElementType> = {
  tasks: ListTodo,
  work: KanbanSquare,
  marketplace: Store,
  files: FileText,
}

export interface HomePanelProps {
  onNavPress?: () => void
}

/**
 * Home is the workspace agent's chat history, with Tasks and Later above it
 * when this workspace has them. The Activity tab keeps the feed.
 */
export function HomePanel({ onNavPress }: HomePanelProps) {
  const router = useRouter()
  const chat = useTeamChatNav()
  const experience = useWorkspaceExperience()
  const { features } = usePlatformConfig()

  return (
    <View testID="home-panel">
      <View className="px-2 pb-1">
        {!TASKS_NAV_HIDDEN && <NavItem icon={ListTodo} label="Tasks" href="/(app)/tasks" onNavPress={onNavPress} />}
        {features.workBoards && experience.kind === 'team' && <NavItem icon={KanbanSquare} label="My work" href="/(app)/work" onNavPress={onNavPress} />}
        {chat.enabled && (
          <PanelLink
            icon={Bookmark}
            label="Later"
            onPress={() => {
              router.push('/(app)/c/later' as any)
              onNavPress?.()
            }}
          />
        )}
      </View>
      <WorkspaceChatsPanel onNavPress={onNavPress} />
    </View>
  )
}

/** A short list of the places that do not have a tab of their own. */
export function MorePanel({ onNavPress, variant = 'panel' }: { onNavPress?: () => void; variant?: 'panel' | 'screen' }) {
  const router = useRouter()
  const experience = useWorkspaceExperience()
  const { features } = usePlatformConfig()
  const items = moreItems({ kind: experience.kind, marketplace: !!features.marketplace && experience.showMarketplace, workBoards: !!features.workBoards })
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
            className={cn(
              'flex-row items-center gap-3',
              screen ? 'rounded-md px-3 py-3.5 active:bg-accent/50' : 'rounded-lg px-2 py-2 hover:bg-sidebar-accent/60 active:bg-sidebar-accent/60',
            )}
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
