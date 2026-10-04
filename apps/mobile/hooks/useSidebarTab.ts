// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useLayoutEffect, useState } from 'react'
import type { SidebarTabId } from '@shogo/shared-app'
import { getStoredTab, resolveTab, setStoredTab, tabForPathname, type TabConversation } from '../lib/sidebar-tab'

/**
 * The selected sidebar tab. It follows the route when the route clearly
 * belongs to one tab, and otherwise keeps whatever the person picked last
 * (remembered per workspace).
 */
export function useSidebarTab(
  workspaceId: string | null | undefined,
  available: SidebarTabId[],
  pathname: string,
  conversations: TabConversation[],
) {
  // Start on the route's own tab: a cold load of /goals must not first paint the
  // remembered tab's panel and then swap it out.
  const routeTab = (): SidebarTabId | null => {
    const fromRoute = tabForPathname(pathname, conversations)
    return fromRoute && available.includes(fromRoute) ? fromRoute : null
  }
  const [tab, setTabState] = useState<SidebarTabId>(() => routeTab() ?? resolveTab(getStoredTab(workspaceId), available))

  // A different workspace brings its own remembered tab and tab set. Layout
  // effects so the corrected tab is what gets painted, not the stale one.
  const availableKey = available.join('|')
  useLayoutEffect(() => {
    setTabState(routeTab() ?? resolveTab(getStoredTab(workspaceId), available))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, availableKey])

  // Re-sync when the route's own conversation becomes known (e.g. a DM that was
  // just created), but not on every unread-count update after that.
  const routeConversationKind = conversations.find((c) => pathname.includes(c.id))?.kind ?? null
  const hasConversations = conversations.length > 0
  useLayoutEffect(() => {
    const fromRoute = routeTab()
    if (fromRoute) {
      setTabState(fromRoute)
      setStoredTab(workspaceId, fromRoute)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, workspaceId, availableKey, hasConversations, routeConversationKind])

  const setTab = useCallback(
    (next: SidebarTabId) => {
      setTabState(next)
      setStoredTab(workspaceId, next)
    },
    [workspaceId],
  )

  return [tab, setTab] as const
}
