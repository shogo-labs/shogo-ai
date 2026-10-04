// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace agent's chat history: every non-primary, unarchived workspace
 * chat (most recent first) plus a way to start a new one. Shared by the
 * personal Home panel and the team Home panel so both list and create chats
 * the same way.
 */
import { useCallback, useMemo, useState } from 'react'
import { useDomainHttp } from '../contexts/domain'
import { api } from '../lib/api'
import { sortSideChats, type SideChatItem } from '../lib/side-chats'
import { useActiveWorkspace } from './useActiveWorkspace'

type SessionRow = SideChatItem & { isPrimary?: boolean; isArchived?: boolean; contextId?: string | null }

/**
 * Chats that belong in the history. Primary is the "main" chat (its own row),
 * archived chats are hidden, and project-pinned chats live in the projects
 * tree rather than here.
 */
export function selectChatHistory<T extends SessionRow>(sessions: T[]): T[] {
  return sortSideChats(sessions.filter((s) => !s.isPrimary && !s.isArchived && !s.contextId))
}

export function useWorkspaceChatHistory() {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      setSessions(await api.listWorkspaceSessions(http, workspaceId))
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [http, workspaceId])

  /** Create a chat and return its id, or null if it could not be created. */
  const createChat = useCallback(async (): Promise<string | null> => {
    if (!workspaceId || creating) return null
    setCreating(true)
    try {
      const session = await api.createWorkspaceSession(http, workspaceId, {})
      void reload()
      return session.id
    } catch {
      return null
    } finally {
      setCreating(false)
    }
  }, [http, workspaceId, creating, reload])

  const chats = useMemo(() => selectChatHistory(sessions), [sessions])

  return { chats, loading, creating, reload, createChat }
}
