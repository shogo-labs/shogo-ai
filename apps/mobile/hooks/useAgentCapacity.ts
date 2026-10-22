// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How many agent replies may work at once in a workspace, and how many are
 * waiting right now. Settings edits it; the limit banner reads the same numbers,
 * so both agree with what the dispatcher is actually admitting.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { teamChatApi, type AgentCapacity } from '../lib/team-chat-api'

const api = teamChatApi()

export function useAgentCapacity(
  workspaceId: string | null | undefined,
  options: { pollMs?: number } = {},
) {
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

  useEffect(() => {
    if (!workspaceId) return
    void refresh()
    if (!options.pollMs) return
    const timer = setInterval(() => void refresh(), options.pollMs)
    return () => clearInterval(timer)
  }, [workspaceId, options.pollMs, refresh])

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

  return { capacity, error, saving, refresh, setConcurrency }
}
