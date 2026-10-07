// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One live view of workspace team chat for the whole navigation: the
 * conversation list, the realtime feeds that keep unread counts current, the
 * shortcuts, and the "new conversation" flow.
 *
 * It is mounted once, above the rail and its panels, so the rail's badges stay
 * live whichever tab is open and the panels simply read from it. When native
 * team chat is off for the workspace, `enabled` is false and the lists are
 * empty.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'expo-router'
import { nativeChatVisible, type ConversationSummary, type Mentionables } from '../../lib/team-chat-api'
import type { SidebarGroups } from '../../lib/team-chat-state'
import { setChatBadgeCount } from '../../lib/team-chat-badge'
import { useWorkspaceChatMode } from '../../hooks/useWorkspaceChatMode'
import { invalidateConversationList, useConversationList, useMentionables, useMyUserId } from '../../hooks/useTeamChat'
import { useInboxFeed, useInboxUnread, useStatusFeed } from '../../hooks/useChatPrefs'
import { usePresenceFeed } from '../../hooks/usePresence'
import { useDraftsFeed, useSavedFeed } from '../../hooks/useChatItems'
import { useCustomEmojiFeed } from '../../hooks/useCustomEmoji'
import { ShortcutsHelp, useChatShortcuts } from '../../hooks/useChatShortcuts'
import { NewConversationModal, type NewConversationMode } from './NewConversationModal'
import { conversationHref } from './ConversationRows'
import { usePhoneLayout } from '../../lib/native-phone-layout'

export interface TeamChatCounts {
  /** Mentions in channels. */
  channels: number
  /** Unread in direct messages, people and agents together. */
  dms: number
  /** Unread inbox items. */
  inbox: number
}

export interface TeamChatNav {
  enabled: boolean
  workspaceId: string | null
  list: ConversationSummary[]
  groups: SidebarGroups
  counts: TeamChatCounts
  /** The conversation open in the route, if any. */
  activeId: string | null
  me: string | null
  mentionables: Mentionables | null
  openConversation: (c: ConversationSummary) => void
  startCreate: (mode: NewConversationMode) => void
  openShortcuts: () => void
}

const EMPTY_GROUPS: SidebarGroups = { starred: [], channels: [], directMessages: [], agents: [] }

const DISABLED: TeamChatNav = {
  enabled: false,
  workspaceId: null,
  list: [],
  groups: EMPTY_GROUPS,
  counts: { channels: 0, dms: 0, inbox: 0 },
  activeId: null,
  me: null,
  mentionables: null,
  openConversation: () => {},
  startCreate: () => {},
  openShortcuts: () => {},
}

const Context = createContext<TeamChatNav>(DISABLED)

export function useTeamChatNav(): TeamChatNav {
  return useContext(Context)
}

/** Unread counts for the rail and dock badges. Pure so it can be tested. */
export function countUnread(list: ConversationSummary[], inboxUnread: number): TeamChatCounts {
  let channels = 0
  let dms = 0
  for (const c of list) {
    if (c.archivedAt || c.muted) continue
    if (c.kind === 'dm' || c.kind === 'group_dm') dms += c.unreadCount
    else channels += c.mentionCount
  }
  return { channels, dms, inbox: inboxUnread }
}

export interface TeamChatSidebarProviderProps {
  workspaceId: string | null | undefined
  /** Called after navigating, so a drawer can close. */
  onNavPress?: () => void
  children: ReactNode
}

/** True below a provider, so a nested one (the sidebar inside the layout) defers to it. */
const Mounted = createContext(false)

export function TeamChatSidebarProvider(props: TeamChatSidebarProviderProps) {
  const nested = useContext(Mounted)
  if (nested) return <>{props.children}</>
  return <RootProvider {...props} />
}

function RootProvider({ workspaceId, onNavPress, children }: TeamChatSidebarProviderProps) {
  const { config } = useWorkspaceChatMode(workspaceId)
  const enabled = !!workspaceId && nativeChatVisible(config?.mode)
  const [live, setLive] = useState<TeamChatNav | null>(null)
  const value = enabled && live ? live : DISABLED

  // The feeds live in a sibling so that turning chat on or off never remounts
  // the navigation rendered as `children`.
  return (
    <>
      <Mounted.Provider value>
        <Context.Provider value={value}>{children}</Context.Provider>
      </Mounted.Provider>
      {enabled && workspaceId ? <Feeds workspaceId={workspaceId} onNavPress={onNavPress} publish={setLive} /> : null}
    </>
  )
}

function Feeds({
  workspaceId,
  onNavPress,
  publish,
}: {
  workspaceId: string
  onNavPress?: () => void
  publish: (nav: TeamChatNav | null) => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const me = useMyUserId()
  const mentionables = useMentionables(workspaceId)
  const { groups, list } = useConversationList(workspaceId)
  const [creating, setCreating] = useState<NewConversationMode | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  useStatusFeed(workspaceId)
  usePresenceFeed(workspaceId)
  useInboxFeed(workspaceId)
  useSavedFeed(workspaceId)
  useDraftsFeed(workspaceId)
  useCustomEmojiFeed(workspaceId)
  const inboxUnread = useInboxUnread(workspaceId)

  const rawActive = pathname.match(/\/c\/([^/?]+)/)?.[1]
  const activeId = rawActive ? decodeURIComponent(rawActive) : null
  const counts = useMemo(() => countUnread(list, inboxUnread), [list, inboxUnread])
  useEffect(() => setChatBadgeCount(counts.dms + counts.inbox), [counts.dms, counts.inbox])
  useEffect(() => () => setChatBadgeCount(0), [])

  const ordered = useMemo(() => {
    const seen = new Set<string>()
    return [...groups.starred, ...groups.channels, ...groups.directMessages, ...groups.agents].filter((c) => !seen.has(c.id) && seen.add(c.id))
  }, [groups])
  const shortcuts = useChatShortcuts({ ordered, activeId, hrefFor: conversationHref })

  const openConversation = useCallback(
    (c: ConversationSummary) => {
      router.push(conversationHref(c.id) as any)
      onNavPress?.()
    },
    [router, onNavPress],
  )
  // Phones get a full-screen route instead of a modal.
  const phone = usePhoneLayout()
  const startCreate = useCallback(
    (mode: NewConversationMode) => {
      if (phone) {
        router.push({ pathname: '/(app)/c/new', params: { mode } } as any)
        onNavPress?.()
      } else {
        setCreating(mode)
      }
    },
    [phone, router, onNavPress],
  )
  const openShortcuts = useCallback(() => setHelpOpen(true), [])

  useEffect(() => {
    publish({ enabled: true, workspaceId, list, groups, counts, activeId, me, mentionables, openConversation, startCreate, openShortcuts })
  }, [publish, workspaceId, list, groups, counts, activeId, me, mentionables, openConversation, startCreate, openShortcuts])
  useEffect(() => () => publish(null), [publish])

  return (
    <>
      <ShortcutsHelp
        visible={helpOpen || shortcuts.helpOpen}
        onClose={() => {
          setHelpOpen(false)
          shortcuts.closeHelp()
        }}
      />
      {creating && !phone && (
        <NewConversationModal
          workspaceId={workspaceId}
          mode={creating}
          mentionables={mentionables}
          me={me}
          onClose={() => setCreating(null)}
          onCreated={(c) => {
            setCreating(null)
            invalidateConversationList(workspaceId)
            openConversation(c)
          }}
        />
      )}
    </>
  )
}
