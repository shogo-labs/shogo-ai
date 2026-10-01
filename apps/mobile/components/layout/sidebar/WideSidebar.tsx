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
import { hrefForTab, tabForPathname } from '../../../lib/sidebar-tab'
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
  /** The panel for a tab. `hidePanel` collapses it to the rail. */
  renderPanel: (tab: SidebarTabId, hidePanel: () => void) => ReactNode
}

export function WideSidebar({ workspaceId, tabs, kind, showAdmin, renderPanel }: WideSidebarProps) {
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

  const select = (next: SidebarTabId) => {
    // Personal Meetings, Goals and Activity are pages, not panels.
    const href = hrefForTab(next) ?? (kind === 'personal' && next === 'activity' ? '/(app)/activity' : null)
    if (next === tab) {
      setPanelHidden((hidden) => !hidden)
      return
    }
    setTab(next)
    setPanelHidden(false)
    if (href && tabForPathname(pathname) !== next) router.push(href as any)
  }

  return (
    <View className="h-full flex-row">
      <IconRail tabs={available} active={tab} badges={badges} onSelect={select} showAdmin={showAdmin} />
      {!panelHidden && <View className="h-full w-64 border-r border-border bg-card">{renderPanel(tab, () => setPanelHidden(true))}</View>}
    </View>
  )
}
