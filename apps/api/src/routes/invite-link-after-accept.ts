// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The cloud composer's `afterAccept` for `POST /invite-links/:token/accept`.
 *
 * It lives beside the route (not inline in `server.ts`) so the same handler the
 * app runs is the one the join-mail tests drive — the project-link regression in
 * SHO-51 round 1 slipped through because only a copy was covered.
 */

import type { InviteLinkAccepted } from './invite-link-accept'

export interface InviteLinkAfterAcceptDeps {
  /** Stripe active-seat sync; the desktop composer passes a no-op. */
  syncSeats: (workspaceId: string) => Promise<unknown>
  /** DB handle for tests; defaults to the app client. */
  prisma?: any
}

export function createInviteLinkAfterAccept(deps: InviteLinkAfterAcceptDeps) {
  return async ({ link, userId, workspaceId, member }: InviteLinkAccepted): Promise<void> => {
    // Workspace-level acceptance bumps the seat quantity; project guests don't bill seats.
    if (workspaceId && !member.projectId) {
      deps.syncSeats(workspaceId).catch((err: any) =>
        console.error('[Billing] invite-link accept seat sync failed:', err?.message ?? err),
      )
    }

    // A project link grants a project-scoped row only: no member.joined event, so
    // the workspace join mail never runs for it and the creator's one "accepted"
    // mail comes from here. Workspace links mail from onWorkspaceMemberJoined.
    if (link.projectId) {
      const { notifyProjectLinkAccepted } = await import('../services/join-notifications')
      await notifyProjectLinkAccepted({ link, userId }, deps.prisma)
    }
  }
}
