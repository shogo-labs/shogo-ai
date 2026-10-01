// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useEffect, useState } from 'react'
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
  const [tab, setTabState] = useState<SidebarTabId>(() => resolveTab(getStoredTab(workspaceId), available))

  // A different workspace brings its own remembered tab and tab set.
  const availableKey = available.join('|')
  useEffect(() => {
    setTabState(resolveTab(getStoredTab(workspaceId), available))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, availableKey])

  const hasConversations = conversations.length > 0
  useEffect(() => {
    const fromRoute = tabForPathname(pathname, conversations)
    if (fromRoute && available.includes(fromRoute)) {
      setTabState(fromRoute)
      setStoredTab(workspaceId, fromRoute)
    }
    // Conversations only place a /c/<id> route: re-sync once the list first
    // arrives, but not on every unread-count update after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, workspaceId, availableKey, hasConversations])

  const setTab = useCallback(
    (next: SidebarTabId) => {
      setTabState(next)
      setStoredTab(workspaceId, next)
    },
    [workspaceId],
  )

  return [tab, setTab] as const
}
