// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop navigation: the icon rail plus the list panel for the selected tab.
 * Tapping the selected tab again hides or shows the panel; the rail stays.
 */
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import type { SidebarTabId } from '@shogo/shared-app'
import { useAgentActivity } from '../../../hooks/useAgentActivity'
import { useSidebarTab } from '../../../hooks/useSidebarTab'
import { activityBadge } from '../../../lib/activity-feed'
import { hrefForTab, isMainChatPath, tabForPathname } from '../../../lib/sidebar-tab'
import { useTeamChatNav } from '../../team-chat/TeamChatSidebarProvider'
import { IconRail } from './IconRail'

// Leaf import: the `@shogo/shared-app` barrel also loads the domain SDK.
import { TEAM_CHAT_TABS } from '../../../../../packages/shared-app/src/hooks/useWorkspaceExperience'

/** The tabs this workspace shows: team chat tabs only while team chat is on. */
export function visibleTabs(tabs: SidebarTabId[], chatEnabled: boolean): SidebarTabId[] {
  return tabs.filter((t) => chatEnabled || !TEAM_CHAT_TABS.includes(t))
}

export interface WideSidebarProps {
  workspaceId: string | null
  tabs: SidebarTabId[]
  kind: 'personal' | 'team'
  showAdmin: boolean
  /** The workspace tile at the top of the rail. */
  switcher?: ReactNode
  invites?: { count: number; onPress: () => void }
  onSearch?: () => void
  /** Called on every rail tab click, including a re-click of the selected tab. */
  onSelectTab?: (tab: SidebarTabId) => void
  /**
   * The tabs that have a list panel. Tabs outside it are pages (or the rail
   * says it all), and show no panel. Defaults to every tab.
   */
  panelTabs?: SidebarTabId[]
  /** The panel for a tab. `hidePanel` collapses it to the rail. */
  renderPanel: (tab: SidebarTabId, hidePanel: () => void) => ReactNode
}

export function WideSidebar({ workspaceId, tabs, kind, showAdmin, switcher, invites, onSearch, onSelectTab, panelTabs, renderPanel }: WideSidebarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const chat = useTeamChatNav()
  const available = visibleTabs(tabs, chat.enabled)
  const [tab, setTab] = useSidebarTab(workspaceId, available, pathname, chat.list)
  const [panelHidden, setPanelHidden] = useState(false)
  const activity = useAgentActivity({ light: true })

  const badges: Partial<Record<SidebarTabId, number>> = {
    channels: chat.counts.channels,
    dms: chat.counts.dms,
    activity: activityBadge(chat.counts.inbox, kind === 'team' ? activity.tasks : []),
  }

  const hasPanel = (id: SidebarTabId) => !panelTabs || panelTabs.includes(id)

  const select = (next: SidebarTabId) => {
    onSelectTab?.(next)
    // Personal Meetings, Goals and Activity are pages, not panels, and Home is
    // the main chat (its panel lists the other chats beside it).
    const personalHref = kind !== 'personal' ? null : next === 'activity' ? '/(app)/activity' : next === 'home' ? '/(app)' : null
    const href = hrefForTab(next) ?? personalHref
    // A personal Home is the main chat itself: a side chat is under the Home tab but not "at" it.
    const atTarget = kind === 'personal' && next === 'home' ? isMainChatPath(pathname) : tabForPathname(pathname) === next
    const offPage = !!href && !atTarget
    if (next === tab && !offPage) {
      if (hasPanel(next)) setPanelHidden((hidden) => !hidden)
      return
    }
    setTab(next)
    setPanelHidden(false)
    if (offPage) router.push(href as any)
  }

  return (
    <View className="h-full flex-row">
      <IconRail tabs={available} active={tab} badges={badges} onSelect={select} showAdmin={showAdmin} switcher={switcher} invites={invites} onSearch={onSearch} />
      {!panelHidden && hasPanel(tab) && <View className="h-full w-64 border-r border-border bg-card">{renderPanel(tab, () => setPanelHidden(true))}</View>}
    </View>
  )
}
