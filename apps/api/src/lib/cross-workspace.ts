// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The cross-workspace half of the internal-runtime auth (SHO-389).
 *
 * The Personal workspace's agent may read, and with the person's approval
 * write, the person's *other* workspaces. A runtime token is a capability for
 * one workspace, so this cannot be done by loosening
 * `authorizeWorkspaceScope` — it is a separate, person-scoped grant with four
 * conditions, all of which have to hold (`authorizeCrossWorkspaceTarget`):
 *
 *   1. the caller is a `workspace` runtime token, and its workspace is the
 *      person's `kind: personal` one;
 *   2. the request carries a genuine requester ticket for that personal
 *      workspace, and its user owns it;
 *   3. that person is a member of the target workspace, with the permission the
 *      route already requires (read, or the matching write);
 *   4. a write also names an approved, unspent approval whose target, tool and
 *      arguments-hash match this request. The approval is spent on use.
 *
 * The approval is recorded on the side that runs the write (a desktop's write
 * to a cloud workspace mints and spends it in the cloud, through
 * `relayToCloud`), so the row and the spend check always live together.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { prisma } from './prisma'
import { loadAccess, type AccessContext } from './authz/access'

const db = prisma as any

export const CROSS_WORKSPACE_APPROVAL_HEADER = 'X-Cross-Workspace-Approval'
export const CROSS_WORKSPACE_TOOL_HEADER = 'X-Cross-Workspace-Tool'
export const CROSS_WORKSPACE_ARGS_HEADER = 'X-Cross-Workspace-Args-Hash'

/**
 * How long an approval stays usable. Long enough for the runtime's own request
 * to reach the API (it mints and spends within one tool call), short enough
 * that a leaked id is worthless by the time anyone finds it.
 */
export const CROSS_WORKSPACE_APPROVAL_TTL_MS = 10 * 60_000

export type CrossWorkspaceFailureCode =
  | 'unauthorized'
  | 'cross_workspace_forbidden'
  | 'requester_ticket_required'
  | 'not_personal_owner'
  | 'not_a_member'
  | 'approval_required'
  | 'cloud_signed_out'
  | 'cloud_unreachable'
  | 'desktop_offline'

export interface CrossWorkspaceFailure {
  ok: false
  status: 401 | 403 | 502
  code: CrossWorkspaceFailureCode
  message: string
}

/**
 * Stable hash of the arguments a person was shown, so an approval cannot be
 * spent on a different call. Keys are sorted, so `{a,b}` and `{b,a}` match.
 */
export function argsHash(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** Mint the approval a runtime asks for after the person said yes. */
export async function mintCrossWorkspaceApproval(input: {
  callerWorkspaceId: string
  targetWorkspaceId: string
  tool: string
  argsHash: string
  requesterUserId: string
  ttlMs?: number
}): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? CROSS_WORKSPACE_APPROVAL_TTL_MS))
  const row = await db.crossWorkspaceApproval.create({
    data: {
      callerWorkspaceId: input.callerWorkspaceId,
      targetWorkspaceId: input.targetWorkspaceId,
      tool: input.tool,
      argsHash: input.argsHash,
      requesterUserId: input.requesterUserId,
      status: 'pending',
      expiresAt,
    },
    select: { id: true },
  })
  return { id: row.id, expiresAt }
}

export type SpendResult = { ok: true } | CrossWorkspaceFailure

/**
 * Spend an approval on the one request that carries it. Single use: a second
 * request with the same id is refused, and an approval granted for another
 * tool, another target or other arguments is refused too.
 */
export async function spendCrossWorkspaceApproval(input: {
  approvalId: string | null | undefined
  targetWorkspaceId: string
  tool: string | null | undefined
  argsHash: string | null | undefined
}): Promise<SpendResult> {
  if (!input.approvalId) {
    return {
      ok: false,
      status: 403,
      code: 'approval_required',
      message:
        'Writing to another workspace needs the person to approve this exact call first. Ask for approval, then retry the write.',
    }
  }
  const row = await db.crossWorkspaceApproval.findUnique({ where: { id: input.approvalId } })
  const refused = (message: string): SpendResult => ({ ok: false, status: 403, code: 'approval_required', message })
  if (!row) return refused('That approval does not exist. Ask again for this write.')
  if (row.targetWorkspaceId !== input.targetWorkspaceId) {
    return refused('That approval was granted for a different workspace. Ask again for this write.')
  }
  if (row.status !== 'pending') return refused('That approval was already used or has expired. Ask again for this write.')
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.crossWorkspaceApproval
      .update({ where: { id: row.id }, data: { status: 'expired' } })
      .catch(() => undefined)
    return refused('That approval expired. Ask again for this write.')
  }
  if ((input.tool ?? '') !== row.tool) {
    return refused('That approval was granted for a different tool call. Ask again for this write.')
  }
  if (!sameHash(input.argsHash, row.argsHash)) {
    return refused('That approval was granted for different arguments. Ask again for this write.')
  }
  // Conditional update: two concurrent requests cannot both spend it.
  const spent = await db.crossWorkspaceApproval.updateMany({
    where: { id: row.id, status: 'pending' },
    data: { status: 'spent', spentAt: new Date() },
  })
  if (!spent?.count) return refused('That approval was already used. Ask again for this write.')
  return { ok: true }
}

function sameHash(given: string | null | undefined, stored: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(stored)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** One row per cross-workspace call that ran. Never throws. */
export async function recordCrossWorkspaceCall(input: {
  callerWorkspaceId: string
  targetWorkspaceId: string
  tool: string
  userId: string | null
  write: boolean
  approvalId?: string | null
}): Promise<void> {
  await db.crossWorkspaceAudit
    .create({
      data: {
        callerWorkspaceId: input.callerWorkspaceId,
        targetWorkspaceId: input.targetWorkspaceId,
        tool: input.tool,
        userId: input.userId,
        kind: input.write ? 'write' : 'read',
        approvalId: input.approvalId ?? null,
      },
    })
    .catch(() => undefined)
}

/**
 * Does the person's own membership in the target cover this call? Reads need
 * `workspace:read`; writes need `workspace:update`, the same permission the
 * session-authenticated version of the route asks for. A non-member is refused
 * whatever permission is asked for — that is the acceptance rule.
 */
export function targetAccessAllows(access: AccessContext, write: boolean): boolean {
  if (access.isSuperAdmin) return true
  if (!access.workspaceRole) return false
  return access.permissions.has(write ? 'workspace:update' : 'workspace:read')
}

/** Membership facts for a person in a target workspace (the person's own view). */
export async function targetWorkspaceAccess(userId: string, targetWorkspaceId: string): Promise<AccessContext> {
  return loadAccess({ userId, via: 'session' }, { workspaceId: targetWorkspaceId })
}
