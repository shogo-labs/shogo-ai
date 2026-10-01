// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which sidebar tab a route belongs to, and which tab the person last picked
 * in each workspace. Pure helpers; `useSidebarTab` wires them to React.
 */
import { Platform } from 'react-native'
import type { SidebarTabId } from '@shogo/shared-app'
import { safeGetItem, safeSetItem } from './safe-storage'

const TAB_KEY = 'shogo:sidebar-tab:'

/** Just enough of a conversation to place its route. */
export interface TabConversation {
  id: string
  kind: 'public' | 'private' | 'dm' | 'group_dm' | 'activity'
}

const strip = (pathname: string) => pathname.replace(/^\/\(app\)/, '').replace(/\/+$/, '') || '/'

/**
 * The tab a pathname belongs to, or null when the route is not tied to one
 * (settings, billing, ...), in which case the current tab stays.
 */
export function tabForPathname(pathname: string, conversations: TabConversation[] = []): SidebarTabId | null {
  const path = strip(pathname)
  if (path === '/') return 'home'
  const chat = path.match(/^\/c(?:\/([^/?]+))?\/?$/)
  if (chat) {
    const segment = chat[1] ? decodeURIComponent(chat[1]) : null
    if (!segment) return 'channels' // browse channels
    if (segment === 'inbox') return 'activity'
    if (segment === 'later') return 'home'
    if (segment === 'dms') return 'dms'
    if (segment === 'search' || segment === 'settings') return 'channels'
    const conversation = conversations.find((c) => c.id === segment)
    if (!conversation) return null
    return conversation.kind === 'dm' || conversation.kind === 'group_dm' ? 'dms' : 'channels'
  }
  if (/^\/(projects|project-chat|project-surface|new-project)(\/|$)/.test(path)) return 'projects'
  if (/^\/activity(\/|$)/.test(path)) return 'activity'
  if (/^\/meetings(\/|$)/.test(path)) return 'meetings'
  if (/^\/goals(\/|$)/.test(path)) return 'goals'
  if (/^\/(tasks|canvases|marketplace|files)(\/|$)/.test(path)) return 'more'
  return null
}

/** Where a tab goes when tapped, for tabs that are a page rather than a panel. */
export function hrefForTab(tab: SidebarTabId): string | null {
  switch (tab) {
    case 'meetings':
      return '/(app)/meetings'
    case 'goals':
      return '/(app)/goals'
    default:
      return null
  }
}

/** The tab to show: the stored one if this workspace offers it, else the first. */
export function resolveTab(stored: string | null | undefined, available: SidebarTabId[]): SidebarTabId {
  if (stored && (available as string[]).includes(stored)) return stored as SidebarTabId
  return available[0] ?? 'home'
}

const isWeb = Platform.OS === 'web' && typeof window !== 'undefined'
const memory = new Map<string, string>()

export function getStoredTab(workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null
  return isWeb ? safeGetItem(TAB_KEY + workspaceId) : memory.get(workspaceId) ?? null
}

export function setStoredTab(workspaceId: string | null | undefined, tab: SidebarTabId): void {
  if (!workspaceId) return
  if (isWeb) safeSetItem(TAB_KEY + workspaceId, tab)
  else memory.set(workspaceId, tab)
}
