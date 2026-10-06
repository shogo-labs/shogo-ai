// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The approvals agents are waiting on in this workspace. Polls while the
 * screen showing it is focused, and drops a card the moment it is answered
 * from anywhere in the app.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { subscribeApprovalDecided } from '../lib/approval-decision'
import { teamChatApi, type PendingApproval } from '../lib/team-chat-api'

const POLL_MS = 5_000
const api = teamChatApi()

export function usePendingApprovals(workspaceId: string | null | undefined, opts: { polling?: boolean; enabled?: boolean } = {}) {
  const { polling = true, enabled = true } = opts
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (!workspaceId || !enabled || inFlight.current) return
    inFlight.current = true
    try {
      setApprovals(await api.pendingApprovals(workspaceId))
    } catch {
      // Keep what we have; the next poll tries again.
    } finally {
      inFlight.current = false
    }
  }, [workspaceId, enabled])

  useEffect(() => {
    setApprovals([])
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!polling || !workspaceId || !enabled) return
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [polling, workspaceId, enabled, refresh])

  useEffect(
    () =>
      subscribeApprovalDecided(({ messageId }) => {
        setApprovals((current) => current.filter((a) => a.messageId !== messageId))
        void refresh()
      }),
    [refresh],
  )

  return { approvals, refresh }
}
