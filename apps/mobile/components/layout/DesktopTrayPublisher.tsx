// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keeps the menu-bar dropdown current while a window is open. Renders nothing.
 *
 * One publisher per window: it gathers the person's chats, the live statuses the
 * island already knows, and the window's own "unopened reply" sets, builds the
 * model (lib/desktop-tray.ts) and publishes it only when it changed. Main picks
 * the focused window's model, so two windows never fight over the dropdown.
 */
import { useEffect, useRef, useState } from 'react'
import { Platform, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceChats } from '../../hooks/useWorkspaceChats'
import { useDomainHttp } from '../../contexts/domain'
import {
  buildTrayModel,
  type TrayIslandSession,
  type TrayModel,
  type TrayRecentChat,
} from '../../lib/desktop-tray'
import { getCompletedChatIds, getDesktopIslandSnapshot } from '../../lib/desktop-island'
import { workspaceActivity } from '../../lib/workspace-activity'
import { chatSessionEvents } from '../../lib/chat-session-events'
import { WEB_WIDE_MIN_WIDTH } from '../../lib/native-phone-layout'

/** How often the sources that push no event (recent chats, island statuses)
 * are re-read. Every poll shares `workspaceActivity`'s one-request-per-window
 * cache, so this is not a second poll of the same endpoint. */
export const TRAY_POLL_MS = 10_000

type TrayAction = { type: 'new-chat' } | { type: 'clear-notifications' }

interface DesktopTrayBridge {
  trayUpdate?: (model: TrayModel) => void
  onTrayAction?: (callback: (action: TrayAction) => void) => (() => void) | void
}

function getBridge(): DesktopTrayBridge | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  const desktop = (window as unknown as { shogoDesktop?: DesktopTrayBridge }).shogoDesktop
  return typeof desktop?.trayUpdate === 'function' ? desktop : null
}

/** The island's registered sessions, in the shape the model wants. */
function islandSessionsForTray(): TrayIslandSession[] {
  const snapshot = getDesktopIslandSnapshot()
  return snapshot.sessions.map((session) => ({
    sessionId: session.sessionId,
    projectId: session.projectId,
    title: session.title,
    status: session.status,
    projectName: session.projectName,
  }))
}

export function DesktopTrayPublisher() {
  const desktop = getBridge()
  const enabled = desktop !== null
  const router = useRouter()
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const chats = useWorkspaceChats(workspaceId)
  const { width } = useWindowDimensions()
  const wide = Platform.OS !== 'web' || width >= WEB_WIDE_MIN_WIDTH
  const [recentChats, setRecentChats] = useState<TrayRecentChat[]>([])
  const [islandSessions, setIslandSessions] = useState<TrayIslandSession[]>([])
  const [completedProjectIds, setCompletedProjectIds] = useState<string[]>([])
  const lastPublished = useRef<string | null>(null)
  // The workspace agent's own name, from the same payload the rows come from.
  const workspaceAgentName = recentChats.find((chat) => chat.projectId === null)?.agentName ?? undefined

  // Recent chats and the island's statuses only change on a poll, so ask for
  // them on a timer rather than on every render.
  useEffect(() => {
    if (!enabled || !workspaceId) return
    let live = true
    const read = async (): Promise<void> => {
      // A hidden window must not fetch (the request cache answers with nothing)
      // and must not blank the rows it already published: the dropdown is most
      // likely to be open exactly when the window is hidden.
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      if (!hidden) {
        const recent = await workspaceActivity
          .recentAgentChats(http, workspaceId, { limit: 25, perAgent: false, includePinned: true })
          .catch(() => null)
        if (!live) return
        if (recent) setRecentChats(recent)
      }
      setIslandSessions(islandSessionsForTray())
      setCompletedProjectIds([...getCompletedChatIds()])
    }
    void read()
    const timer = setInterval(() => {
      void read()
    }, TRAY_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [enabled, http, workspaceId])

  // A chat that starts or finishes a turn pushes no poll, so re-read the
  // island on the same activity events the sidebar mirrors.
  useEffect(() => {
    if (!enabled) return
    const sync = (): void => {
      setIslandSessions(islandSessionsForTray())
      setCompletedProjectIds([...getCompletedChatIds()])
    }
    return chatSessionEvents.subscribe(sync)
  }, [enabled])

  // "Clear All Notifications" has to reach the rows this window published, not
  // just the sidebar's: a project chat's blue dot lived here until the next
  // 10 s poll. Dropped locally rather than by re-reading the island, so the
  // result does not depend on which clear listener ran first.
  useEffect(() => {
    if (!enabled) return
    return chatSessionEvents.subscribeClearCompletions(() => {
      setCompletedProjectIds([])
      setIslandSessions((current) =>
        current.some((session) => session.status === 'done')
          ? current.map((session) => (session.status === 'done' ? { ...session, status: 'idle' as const } : session))
          : current,
      )
    })
  }, [enabled])

  useEffect(() => {
    if (!enabled || !desktop) return
    const model = buildTrayModel({
      workspaceChats: chats.sessions,
      recentChats,
      islandSessions,
      streamingIds: [...chats.streamingIds],
      completedIds: [...chats.completedIds],
      completedProjectSessionIds: completedProjectIds,
      workspaceAgentName,
      wide,
    })
    const json = JSON.stringify(model)
    if (json === lastPublished.current) return
    lastPublished.current = json
    desktop.trayUpdate?.(model)
  }, [
    enabled,
    desktop,
    chats.sessions,
    chats.streamingIds,
    chats.completedIds,
    recentChats,
    islandSessions,
    completedProjectIds,
    workspaceAgentName,
    wide,
  ])

  // Actions only the app can carry out. Clearing goes through the one event
  // every unopened-reply set listens to; a new chat reuses the sidebar's own
  // create-then-open path.
  useEffect(() => {
    if (!desktop?.onTrayAction) return
    const unsubscribe = desktop.onTrayAction((action) => {
      if (action.type === 'clear-notifications') {
        chatSessionEvents.clearChatCompletions()
        return
      }
      void chats.createChat().then((session) => {
        if (!session) return
        if (workspaceId) chatSessionEvents.emit({ workspaceId, refresh: true })
        router.push({ pathname: '/(app)/agent', params: { chatSessionId: session.id } } as never)
      })
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [desktop, chats.createChat, router, workspaceId])

  return null
}
