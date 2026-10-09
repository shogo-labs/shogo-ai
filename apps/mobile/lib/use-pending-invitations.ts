// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * usePendingInvitations — the signed-in user's received (pending/expired)
 * invitations plus accept / decline actions.
 *
 * Shared by the sidebar Inbox, the Notifications screen and the
 * `/invitations/:id/accept` route so all three stay in sync via
 * `invitationEvents`.
 */
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/auth'
import {
  useDomainActions,
  useDomainHttp,
  useWorkspaceCollection,
} from '../contexts/domain'
import { api } from './api'
import { invitationEvents } from './invitation-events'

export type InviteProcessingState = {
  id: string
  action: 'accept' | 'decline'
} | null

export function usePendingInvitations() {
  const { user } = useAuth()
  const http = useDomainHttp()
  const actions = useDomainActions()
  const workspaces = useWorkspaceCollection()

  const [pendingInvites, setPendingInvites] = useState<any[]>([])
  const [processingInvite, setProcessingInvite] = useState<InviteProcessingState>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadInvites = useCallback(() => {
    if (!http || !user?.email) return Promise.resolve()
    return api
      .getReceivedInvitations(http, user.email)
      .then(setPendingInvites)
      .catch((e) => console.error('[usePendingInvitations] Failed to load invitations:', e))
      .finally(() => setIsLoading(false))
  }, [http, user?.email])

  /** Resolves true when the invitation was accepted. */
  const acceptInvite = useCallback(
    async (invite: any): Promise<boolean> => {
      setProcessingInvite({ id: invite.id, action: 'accept' })
      let ok = false
      try {
        await actions.acceptInvitation(invite.id, user?.id || '', {
          workspaceId: invite.workspaceId,
          role: invite.role,
          projectId: invite.projectId,
        })
        setPendingInvites((prev) => prev.filter((item: any) => item.id !== invite.id))
        ok = true
      } catch (e) {
        console.error('[usePendingInvitations] Failed to accept invitation:', e)
      }
      loadInvites()
      invitationEvents.emit()
      workspaces
        .loadAll()
        .catch((e: unknown) =>
          console.error('[usePendingInvitations] Failed to reload workspaces:', e),
        )
      setProcessingInvite(null)
      return ok
    },
    [actions, loadInvites, user?.id, workspaces],
  )

  /** Resolves true when the invitation was declined. */
  const declineInvite = useCallback(
    async (invite: any): Promise<boolean> => {
      setProcessingInvite({ id: invite.id, action: 'decline' })
      let ok = false
      try {
        await actions.declineInvitation(invite.id)
        setPendingInvites((prev) => prev.filter((item: any) => item.id !== invite.id))
        ok = true
      } catch (e) {
        console.error('[usePendingInvitations] Failed to decline invitation:', e)
      }
      loadInvites()
      invitationEvents.emit()
      setProcessingInvite(null)
      return ok
    },
    [actions, loadInvites],
  )

  useEffect(() => {
    void loadInvites()
  }, [loadInvites])

  useEffect(() => invitationEvents.subscribe(() => void loadInvites()), [loadInvites])

  return { pendingInvites, processingInvite, isLoading, loadInvites, acceptInvite, declineInvite }
}
