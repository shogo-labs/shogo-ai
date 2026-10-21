// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One load / update / delete path for the signed-in user's workspace-agent
 * chats. Home, the phone drawer and the side-chats screen all read and mutate
 * through this hook, so a rename in one place lands everywhere and there is a
 * single `listWorkspaceSessions` call site.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useChatSessionCollection,
  useDomainActions,
  useDomainHttp,
} from '../contexts/domain'
import { api } from '../lib/api'
import { chatActivityEvents, chatSessionEvents } from '../lib/chat-session-events'
import { sortSideChats, type SideChatItem } from '../lib/side-chats'

export type WorkspaceChat = SideChatItem & {
  workspaceId?: string
  isPrimary?: boolean
  messageCount?: number
}

type CreateWorkspaceChatOpts = Parameters<typeof api.createWorkspaceSession>[2]

export type WorkspaceChatChanges = {
  name?: string
  isPinned?: boolean
  isArchived?: boolean
}

export function useWorkspaceChats(workspaceId: string | undefined) {
  const http = useDomainHttp()
  const actions = useDomainActions()
  const chatSessions = useChatSessionCollection()
  const [sessions, setSessions] = useState<WorkspaceChat[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set())
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const refresh = useCallback(async () => {
    if (!workspaceId) return
    try {
      const all = await api.listWorkspaceSessions(http, workspaceId)
      setSessions(all)
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [http, workspaceId])

  useEffect(() => {
    setSessions([])
    setLoading(true)
  }, [workspaceId])

  // A chat created / renamed / archived anywhere (this hook, the agent screen,
  // another window) refreshes every list through this one subscription.
  useEffect(() => {
    if (!workspaceId) return
    return chatSessionEvents.subscribe((event) => {
      if (!event.refresh || event.workspaceId !== workspaceId) return
      void refresh()
    })
  }, [refresh, workspaceId])

  // The open workspace chat's live streaming / new-activity state, broadcast by
  // WorkspaceAgentChatScreen. Same signal the project tree rows use.
  useEffect(() => {
    setStreamingIds(new Set())
    setCompletedIds(new Set())
    if (!workspaceId) return
    return chatActivityEvents.subscribe((event) => {
      if (event.workspaceId !== workspaceId) return
      setStreamingIds(new Set(event.streamingSessionIds))
      setCompletedIds(new Set(event.completedSessionIds))
    })
  }, [workspaceId])

  const ensureLoaded = useCallback(
    async (sessionId: string) => {
      if (!chatSessions.get(sessionId)) await chatSessions.loadById(sessionId)
    },
    [chatSessions],
  )

  const updateChat = useCallback(
    async (sessionId: string, changes: WorkspaceChatChanges) => {
      const previous = sessionsRef.current
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, ...changes } : session,
        ),
      )
      try {
        await ensureLoaded(sessionId)
        await actions.updateChatSession(sessionId, changes)
        if (workspaceId) {
          chatSessionEvents.emit({ workspaceId, refresh: true })
        }
      } catch {
        setSessions(previous)
        void refresh()
      }
    },
    [actions, ensureLoaded, refresh, workspaceId],
  )

  const deleteChat = useCallback(
    async (sessionId: string) => {
      const previous = sessionsRef.current
      setSessions((current) =>
        current.filter((session) => session.id !== sessionId),
      )
      try {
        await actions.deleteChatSession(sessionId)
      } catch {
        setSessions(previous)
        void refresh()
      }
    },
    [actions, refresh],
  )

  /** Create a chat, prepend it optimistically, and hand the row to the caller. */
  const createChat = useCallback(
    async (fields: CreateWorkspaceChatOpts = {}): Promise<WorkspaceChat | null> => {
      if (!workspaceId || creating) return null
      setCreating(true)
      try {
        const session = await api.createWorkspaceSession(http, workspaceId, fields)
        // Stamp the row so it ranks as the most recent chat even if the server
        // response omits timestamps; sortSideChats would otherwise push it last.
        const now = new Date().toISOString()
        const row: WorkspaceChat = {
          ...session,
          createdAt: session.createdAt ?? now,
          lastActiveAt: session.lastActiveAt ?? now,
        }
        setSessions((current) => [
          row,
          ...current.filter((item) => item.id !== session.id),
        ])
        return row
      } catch {
        return null
      } finally {
        setCreating(false)
      }
    },
    [creating, http, workspaceId],
  )

  const active = useMemo(
    () => sortSideChats(sessions.filter((session) => !session.isArchived)),
    [sessions],
  )
  const archived = useMemo(
    () => sortSideChats(sessions.filter((session) => session.isArchived)),
    [sessions],
  )

  return {
    sessions,
    active,
    archived,
    loading,
    creating,
    streamingIds,
    completedIds,
    refresh,
    createChat,
    updateChat,
    deleteChat,
  }
}
