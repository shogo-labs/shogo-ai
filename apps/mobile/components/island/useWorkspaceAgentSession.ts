// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace-agent chats as the island sees them: the agent's identity, the
 * recent-chat list the inbox shows, and the lazily created session a blank
 * notch chat turns into on its first send.
 */

import { useCallback, useEffect, useState } from "react"
import { useDomainHttp } from "../../contexts/domain"
import { api, type PersonalAgentProfile } from "../../lib/api"
import { DEFAULT_AGENT_NAME } from "./island-view"
import type { WorkspaceAgentChat } from "./workspace-agent-rows"

function toMillis(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") return new Date(value).getTime() || 0
  return 0
}

/** The workspace agent's display name, falling back to "Shogo". */
export function useWorkspaceAgentName(workspaceId: string | undefined): string {
  const http = useDomainHttp()
  const [profile, setProfile] = useState<PersonalAgentProfile | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    void api
      .getAgentProfile(http, workspaceId)
      .then((next) => !cancelled && setProfile(next))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [http, workspaceId])

  return profile?.name?.trim() || DEFAULT_AGENT_NAME
}

/** Recent workspace-agent chats, newest first. Refetches when `refreshTick`
 * changes so a chat created from the island shows up in the inbox. */
export function useWorkspaceAgentChats(
  workspaceId: string | undefined,
  enabled: boolean,
  refreshTick = 0,
): { chats: WorkspaceAgentChat[]; loading: boolean; error: string | null } {
  const http = useDomainHttp()
  const [chats, setChats] = useState<WorkspaceAgentChat[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !workspaceId) return
    let cancelled = false
    setLoading(true)
    void api
      .listWorkspaceSessions(http, workspaceId)
      .then((sessions) => {
        if (cancelled) return
        setError(null)
        setChats(
          sessions
            .filter((session) => !session.isArchived)
            .map((session) => ({
              id: session.id,
              title: session.name?.trim() || session.inferredName?.trim() || "New chat",
              activity: Math.max(toMillis(session.lastActiveAt), toMillis(session.createdAt)),
            })),
        )
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [enabled, http, refreshTick, workspaceId])

  return { chats, loading, error }
}

/** Creates the session a blank notch chat needs, at first send. */
export function useWorkspaceAgentSessionCreator(
  workspaceId: string | undefined,
): () => Promise<{ id: string }> {
  const http = useDomainHttp()

  return useCallback(async () => {
    if (!workspaceId) throw new Error("Workspace unavailable")
    const session = await api.createWorkspaceSession(http, workspaceId, {
      inferredName: "New chat",
    })
    return { id: session.id }
  }, [http, workspaceId])
}
