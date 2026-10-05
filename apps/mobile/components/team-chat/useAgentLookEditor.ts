// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Saves changes to an agent's buddy look. Shared by the agent profile screen
 * and the project settings page so both behave the same: the new look shows
 * straight away, one save is in flight at a time (picks made meanwhile collapse
 * into the newest), and a failed save rolls back to the last saved look.
 */
import { useCallback, useRef, useState } from 'react'
import { sameLook, type BuddyLook } from '@shogo/shared-app/buddy-look'
import { teamChatApi } from '../../lib/team-chat-api'
import { setAgentLookLocal } from '../../hooks/useTeamChat'

const api = teamChatApi()

/**
 * @param look      the look currently shown for the agent (already resolved)
 * @param savedLook the look stored on the server, from the agent's card
 */
export function useAgentLookEditor(
  workspaceId: string,
  projectId: string | null,
  look: BuddyLook,
  savedLook: BuddyLook | null,
) {
  const [error, setError] = useState('')
  const confirmed = useRef<BuddyLook | null | undefined>(undefined)
  const sending = useRef(false)
  const queued = useRef<{ look: BuddyLook | null } | null>(null)
  const lookRef = useRef(look)
  lookRef.current = look

  const flush = useCallback(() => {
    const next = queued.current
    if (!next || sending.current) return
    queued.current = null
    sending.current = true
    api.setAgentBuddyLook(workspaceId, projectId, next.look)
      .then(() => { confirmed.current = next.look })
      .catch(() => {
        if (queued.current) return
        setAgentLookLocal(workspaceId, projectId, confirmed.current ?? null)
        setError('Could not save this look. Try again.')
      })
      .finally(() => {
        sending.current = false
        flush()
      })
  }, [workspaceId, projectId])

  const save = useCallback((next: BuddyLook | null) => {
    if (confirmed.current === undefined) confirmed.current = savedLook
    if (next && sameLook(next, lookRef.current)) return
    setError('')
    setAgentLookLocal(workspaceId, projectId, next)
    queued.current = { look: next }
    flush()
  }, [workspaceId, projectId, savedLook, flush])

  return { save, error }
}
