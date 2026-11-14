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

/**
 * The tools whose cross-workspace call may be approved (SHO-389). Mirrors
 * `CROSS_WORKSPACE_WRITE_TOOLS` in `packages/agent-runtime/src/cross-workspace.ts`
 * — the runtime decides what prompts, this decides what can be *minted*, so a
 * runtime that asks nicely for `schedule_delete` is refused with
 * `cross_workspace_unsupported` instead of being handed an approval. The
 * destructive and administrative tools are absent on purpose: they never cross
 * a workspace boundary, even with a person's yes.
 */
export const CROSS_WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'work_item_create',
  'work_item_update',
  'work_item_move',
  'work_item_comment',
  'work_item_link',
  'work_item_bulk_update',
  'team_chat_post',
  'team_chat_update',
  'team_chat_doc_update',
  'schedule_create',
  'schedule_update',
  'trigger_update',
  'agent_run_stop',
  'project_call',
])

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

/**
 * The person a forwarded cross-workspace call was made for (SHO-389).
 *
 * A desktop that relays a call to a cloud workspace has already proved who it
 * is for — it holds the person's ticket and their owned Personal workspace, and
 * it spends the approval. The cloud cannot re-verify that ticket (different
 * signing secret), so the desktop names the person in two headers instead. They
 * are only believed when the caller authenticated with a **workspace device
 * key** (the `Authorization: Bearer shogo_sk_…` a signed-in desktop uses) *and*
 * names a Personal workspace that person actually owns — so a runtime token,
 * which an agent can read, cannot use them to impersonate anybody.
 */
export const CROSS_WORKSPACE_FROM_HEADER = 'X-Cross-Workspace-From'
export const CROSS_WORKSPACE_REQUESTER_HEADER = 'X-Cross-Workspace-Requester'

export async function relayedCrossWorkspaceRequester(c: {
  req: { header: (n: string) => string | undefined }
}): Promise<string | null> {
  if (!c.req.header('Authorization')?.startsWith('Bearer shogo_sk_')) return null
  const from = c.req.header(CROSS_WORKSPACE_FROM_HEADER)
  const userId = c.req.header(CROSS_WORKSPACE_REQUESTER_HEADER)
  if (!from || !userId) return null
  const caller = await db.workspace
    .findUnique({ where: { id: from }, select: { kind: true, personalOwnerId: true } })
    .catch(() => null)
  if (caller?.kind !== 'personal' || caller.personalOwnerId !== userId) return null
  return userId
}

/** Membership facts for a person in a target workspace (the person's own view). */
export async function targetWorkspaceAccess(userId: string, targetWorkspaceId: string): Promise<AccessContext> {
  return loadAccess({ userId, via: 'session' }, { workspaceId: targetWorkspaceId })
}

/** Where a target workspace's data actually lives, from this instance's view. */
export type TargetHome =
  /** This instance holds the workspace: answer it here. */
  | { kind: 'local' }
  /** A signed-in desktop's cloud workspace: relay with its device key. */
  | { kind: 'cloud'; key: string }
  /** The workspace exists here but its compute is a paired desktop. */
  | { kind: 'desktop'; hostInstanceId: string }
  /** This instance can't reach it, and says why. */
  | { kind: 'unreachable'; code: 'cloud_signed_out' | 'cloud_unreachable' | 'not_a_member'; message: string }

/**
 * Which instance can answer a call for `targetWorkspaceId` (SHO-389).
 *
 * This matters because the person's membership cannot be read from the wrong
 * database: a signed-in desktop holds no rows for its cloud workspaces ("Nothing
 * from those workspaces is copied into SQLite"), so `loadAccess` there answered
 * `not_a_member` for a workspace the person plainly belongs to. For a cloud
 * workspace the desktop holds, the cloud-issued **per-workspace device key is
 * the membership proof** — the cloud only hands a key over for a workspace the
 * person is in — and the cloud re-checks its own rows when it runs the call.
 */
export async function resolveTargetHome(targetWorkspaceId: string): Promise<TargetHome> {
  const row = await db.workspace
    .findUnique({ where: { id: targetWorkspaceId }, select: { hostInstanceId: true } })
    .catch(() => null)
  if (row && !row.hostInstanceId) return { kind: 'local' }
  if (row?.hostInstanceId) return { kind: 'desktop', hostInstanceId: row.hostInstanceId }

  if (process.env.SHOGO_LOCAL_MODE !== 'true') {
    return {
      kind: 'unreachable',
      code: 'not_a_member',
      message: 'That workspace does not exist, or you are not a member of it.',
    }
  }

  const { listCloudWorkspaces } = await import('../services/cloud-workspaces')
  const cloud = await listCloudWorkspaces().catch(() => null)
  const entry = cloud?.workspaces.find((w) => w.id === targetWorkspaceId)
  if (entry) {
    return cloud?.reachable === false
      ? {
          kind: 'unreachable',
          code: 'cloud_unreachable',
          message: "Shogo Cloud can't be reached right now, so that workspace can't be read. Try again once you're back online.",
        }
      : { kind: 'cloud', key: entry.key }
  }
  if (!cloud?.user) {
    return {
      kind: 'unreachable',
      code: 'cloud_signed_out',
      message:
        'That workspace lives in Shogo Cloud and this machine is not signed in to it. Sign in to reach your cloud workspaces.',
    }
  }
  return {
    kind: 'unreachable',
    code: 'not_a_member',
    message: 'You are not a member of that workspace, so it is not reachable from here.',
  }
}
