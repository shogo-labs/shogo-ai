// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who an agent tool is acting as.
 *
 * The runtime authenticates with its own token, which only proves "this pod
 * belongs to this workspace". The person comes from the signed requester
 * ticket the API issued when the turn started. A `userId` in the request
 * body is a claim the runtime (or the agent's shell) can set, so it is
 * trusted only for cluster-internal service accounts, or while enforcement
 * is still shadow/off.
 */

import type { Context } from 'hono'
import { prisma } from '../prisma'
import { REQUESTER_TICKET_HEADER, verifyRequesterTicketInWorkspace } from '../requester-ticket'
import type { Principal } from './access'
import { getRbacMode } from './mode'

/** Same shape as `InternalIdentity`, without importing the route module. */
export type AgentCaller =
  | { kind: 'sa' }
  | { kind: 'project'; projectId: string }
  | { kind: 'workspace'; workspaceId: string }

export interface AgentActor {
  principal: Principal
  source: 'ticket' | 'creator' | 'claim'
  /**
   * Service-account call with no person attached. Cluster-internal callers
   * stay unscoped; they are not a workspace member.
   */
  unscoped?: boolean
}

function claimedUser(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Resolve the person behind an internal agent call.
 *
 *   1. A valid ticket for this workspace wins, and the claimed userId is ignored.
 *   2. A project runtime with no ticket (heartbeats) acts as the project's creator.
 *   3. A service account with no ticket acts as the claimed userId, or unscoped
 *      when it names nobody.
 *   4. A workspace runtime with no ticket may use the claimed userId only while
 *      enforcement is off or shadow (logged as `agent_claim_untrusted`). When
 *      enforcement is on, there is no actor.
 *
 * Never falls back to the workspace owner.
 */
export async function resolveAgentActor(
  c: Context,
  identity: AgentCaller,
  opts: {
    workspaceId: string
    claimedUserId?: unknown
    /** Test seam. Production uses the database. */
    lookupProjectWorkspace?: (projectId: string) => Promise<string | null>
    lookupProjectCreator?: (projectId: string) => Promise<string | null>
  },
): Promise<AgentActor | null> {
  const ticket = await verifyRequesterTicketInWorkspace(
    c.req.header(REQUESTER_TICKET_HEADER),
    opts.workspaceId,
    Date.now(),
    opts.lookupProjectWorkspace,
  )
  if (ticket) {
    return { principal: { userId: ticket.userId, via: 'session', isAuthenticated: true }, source: 'ticket' }
  }

  if (identity.kind === 'project') {
    const createdBy = opts.lookupProjectCreator
      ? await opts.lookupProjectCreator(identity.projectId)
      : ((await prisma.project.findUnique({
          where: { id: identity.projectId },
          select: { createdBy: true },
        })) as { createdBy: string | null } | null)?.createdBy ?? null
    if (!createdBy) return null
    return { principal: { userId: createdBy, via: 'session', isAuthenticated: true }, source: 'creator' }
  }

  const claimed = claimedUser(opts.claimedUserId)
  if (identity.kind === 'sa') {
    if (!claimed) return { principal: {}, source: 'claim', unscoped: true }
    return { principal: { userId: claimed, via: 'session', isAuthenticated: true }, source: 'claim' }
  }

  const mode = await getRbacMode()
  if (mode === 'on' || !claimed) return null
  console.warn('[rbac] agent_claim_untrusted', { workspaceId: opts.workspaceId, userId: claimed, mode })
  return { principal: { userId: claimed, via: 'session', isAuthenticated: true }, source: 'claim' }
}
