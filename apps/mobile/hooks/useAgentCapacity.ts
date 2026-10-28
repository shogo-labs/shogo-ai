// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How many agent replies may work at once in a workspace, and how many are
 * waiting right now. Settings edits it; the limit banner reads the same numbers,
 * so both agree with what the dispatcher is actually admitting.
 *
 * The counts are live: the slot queue publishes `agent.capacity` on every move
 * (throttled to 1/s) and this hook applies it, so the banner appears the moment
 * the limit is hit instead of up to a poll later. The HTTP call is what knows
 * the plan, the ceiling and whether you may change it — it runs on mount and
 * again when the socket comes back, since a dropped connection is the one way a
 * count can go stale.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { teamChatApi, type AgentCapacity } from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'

const api = teamChatApi()

export function useAgentCapacity(workspaceId: string | null | undefined) {
  const [capacity, setCapacity] = useState<AgentCapacity | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setCapacity(null)
      return
    }
    try {
      const next = await api.agentCapacity(workspaceId)
      if (alive.current) {
        setCapacity(next)
        setError(null)
      }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : 'Could not load agent capacity')
    }
  }, [workspaceId])

  const realtime = useTeamChatEvents(workspaceId ?? null, (event) => {
    if (event.type !== 'agent.capacity') return
    if (event.workspaceId !== workspaceId) return
    setCapacity((prev) =>
      prev
        ? { ...prev, limit: event.limit, running: event.running, parked: event.parked, queued: event.queued }
        : prev,
    )
  })

  // Mount, and again after a drop: the counts move while the socket is down.
  useEffect(() => {
    if (!workspaceId) return
    void refresh()
  }, [workspaceId, refresh])

  const firstOpen = useRef(true)
  useEffect(() => {
    if (realtime !== 'open') return
    if (firstOpen.current) {
      // The mount read already covered the first connect.
      firstOpen.current = false
      return
    }
    void refresh()
  }, [realtime, refresh])

  const setConcurrency = useCallback(
    async (agentReplyConcurrency: number | null) => {
      if (!workspaceId) return null
      setSaving(true)
      try {
        const next = await api.setAgentCapacity(workspaceId, agentReplyConcurrency)
        if (alive.current) {
          setCapacity(next)
          setError(null)
        }
        return next
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : 'Could not save the limit')
        return null
      } finally {
        if (alive.current) setSaving(false)
      }
    },
    [workspaceId],
  )

  return { capacity, error, saving, realtime, refresh, setConcurrency }
}
