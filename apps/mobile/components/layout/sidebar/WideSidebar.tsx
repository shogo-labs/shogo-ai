// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop navigation: the icon rail plus the list panel for the selected tab.
 * Tapping the selected tab again hides or shows the panel; the rail stays.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import type { SidebarTabId } from '@shogo/shared-app'
import { useAgentActivity } from '../../../hooks/useAgentActivity'
import { useSidebarTab } from '../../../hooks/useSidebarTab'
import { activityBadge } from '../../../lib/activity-feed'
import { hrefForTab, isMainChatPath, tabForPathname } from '../../../lib/sidebar-tab'
import { useTeamChatNav } from '../../team-chat/TeamChatSidebarProvider'
import { IconRail } from './IconRail'
import { useReportWidePanel } from './WidePanelContext'

// Leaf import: the `@shogo/shared-app` barrel also loads the domain SDK.
import { TEAM_CHAT_TABS } from '../../../../../packages/shared-app/src/hooks/useWorkspaceExperience'

/** The tabs this workspace shows: team chat tabs only while team chat is on. */
export function visibleTabs(tabs: SidebarTabId[], chatEnabled: boolean): SidebarTabId[] {
  return tabs.filter((t) => chatEnabled || !TEAM_CHAT_TABS.includes(t))
}

/** A tab's own page, used when a page-owned panel (Settings) hands off to a tab. */
const TAB_ROUTES: Partial<Record<SidebarTabId, string>> = {
  channels: '/(app)/c',
  dms: '/(app)/c/dms',
  activity: '/(app)/activity',
  projects: '/(app)/projects',
  more: '/(app)/more',
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
  /**
   * A page-owned panel that replaces the tab panels while it is set (Settings
   * navigation on /settings). No rail tab is selected then, and picking one
   * leaves the page for that tab. `hidePanel` collapses it to the rail.
   */
  panelOverride?: (hidePanel: () => void) => ReactNode
}

export function WideSidebar({ workspaceId, tabs, kind, showAdmin, switcher, invites, onSearch, onSelectTab, panelTabs, renderPanel, panelOverride }: WideSidebarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const chat = useTeamChatNav()
  const available = visibleTabs(tabs, chat.enabled)
  const [tab, setTab] = useSidebarTab(workspaceId, available, pathname, chat.list)
  const [panelHidden, setPanelHidden] = useState(false)
  const activity = useAgentActivity({ light: true })
  const overridden = !!panelOverride

  // Entering an override page opens its panel, even if the last one was hidden.
  useEffect(() => {
    if (overridden) setPanelHidden(false)
  }, [overridden])

  const badges: Partial<Record<SidebarTabId, number>> = {
    channels: chat.counts.channels,
    dms: chat.counts.dms,
    activity: activityBadge(chat.counts.inbox, kind === 'team' ? activity.tasks : []),
  }

  const hasPanel = (id: SidebarTabId) => !panelTabs || panelTabs.includes(id)
  const panelShown = !panelHidden && (overridden || hasPanel(tab))
  useReportWidePanel(panelShown)

  // Personal Meetings, Goals and Activity are pages, not panels, and Home is
  // the main chat (its panel lists the other chats beside it).
  const pageHref = (next: SidebarTabId) => hrefForTab(next) ?? (kind !== 'personal' ? null : next === 'activity' ? '/(app)/activity' : next === 'home' ? '/(app)' : null)

  const select = (next: SidebarTabId) => {
    onSelectTab?.(next)
    if (overridden) {
      // Leave the override page for the tab's own route, if it has one.
      setTab(next)
      setPanelHidden(false)
      router.push((pageHref(next) ?? TAB_ROUTES[next] ?? '/(app)') as any)
      return
    }
    const href = pageHref(next)
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
      <IconRail tabs={available} active={overridden ? null : tab} badges={badges} onSelect={select} showAdmin={showAdmin} switcher={switcher} invites={invites} onSearch={onSearch} />
      {panelShown && (
        <View className="my-1.5 ml-1.5 w-64 overflow-hidden rounded-l-xl border-y border-l border-r border-sidebar-border bg-sidebar-panel">
          {panelOverride ? panelOverride(() => setPanelHidden(true)) : renderPanel(tab, () => setPanelHidden(true))}
        </View>
      )}
    </View>
  )
}
