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
 * Which workspace the call is for, when the URL names a *project* instead
 * (`project_call`). Set by the runtime's gate from the `workspace` the agent
 * asked for; it grants nothing on its own — the ticket, personal ownership,
 * target membership and the approval are still each required.
 */
export const CROSS_WORKSPACE_TARGET_HEADER = 'X-Cross-Workspace-Target'

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

/**
 * The cloud half of a workspace hosted on a paired desktop (SHO-493).
 *
 * A hosted workspace's boards, cards and chat live in **that desktop's
 * SQLite**, so answering the call from Postgres would give wrong or empty
 * answers. The call is forwarded over the host's instance tunnel instead, to
 * the same `/api/internal/workspaces/<id>/…` path on the desktop's local API.
 *
 * `X-Cross-Workspace-Hosted-From` is what marks such a request on the desktop
 * side. It names the Personal workspace the person was acting in. It grants
 * nothing on its own: the tunnel-stamped user, the desktop holding the
 * workspace and a membership check against that SQLite are all still required
 * (see `hostedForward`).
 */
export const CROSS_WORKSPACE_HOSTED_FROM_HEADER = 'X-Cross-Workspace-Hosted-From'

/** The only path shape a forwarded call is accepted on. */
const HOSTED_FORWARD_PATH = /^\/api\/internal\/workspaces\/([^/]+)(?:\/|$)/

/** Context slot `hostedForward` leaves its answer in, so one request reads it once. */
export const HOSTED_FORWARD_KEY = 'crossWorkspaceHostedForward'

export interface HostedForward {
  /** The workspace this desktop holds and the call acts in. */
  workspaceId: string
  /** The person the call is made for; the row it writes is attributed to them. */
  requesterUserId: string
}

/**
 * Is this request the cloud's forwarded call for a workspace this desktop holds?
 *
 * Deliberately narrow, and only true on a desktop: local mode, both headers, a
 * `/api/internal/workspaces/<id>/…` path, a workspace in this SQLite, and a
 * requester who is a member here with the permission the method implies. That
 * trusts exactly what `middleware/auth.ts` step 3 already trusts — a
 * tunnel-stamped user — and is never true in cloud mode or on any other path.
 *
 * The approval is *not* re-checked: it was spent in the cloud, where its row
 * lives, before the call was forwarded.
 */
export async function hostedForward(c: {
  req: { header: (name: string) => string | undefined; path: string; method: string }
  get?: (key: string) => unknown
  set?: (key: string, value: unknown) => void
}): Promise<HostedForward | null> {
  const cached = c.get?.(HOSTED_FORWARD_KEY)
  if (cached !== undefined) return cached as HostedForward | null
  const resolved = await resolveHostedForward(c)
  try {
    c.set?.(HOSTED_FORWARD_KEY, resolved)
  } catch {
    /* a plain test stub without set() */
  }
  return resolved
}

async function resolveHostedForward(c: {
  req: { header: (name: string) => string | undefined; path: string; method: string }
}): Promise<HostedForward | null> {
  if (process.env.SHOGO_LOCAL_MODE !== 'true') return null
  const from = c.req.header(CROSS_WORKSPACE_HOSTED_FROM_HEADER)
  const tunnelUserId = c.req.header('x-tunnel-auth-user-id')
  if (!from || !tunnelUserId) return null
  const match = HOSTED_FORWARD_PATH.exec(c.req.path)
  if (!match) return null
  let workspaceId: string
  try {
    workspaceId = decodeURIComponent(match[1])
  } catch {
    return null
  }

  const held = await db.workspace
    .findUnique({ where: { id: workspaceId }, select: { id: true } })
    .catch(() => null)
  if (!held) return null

  // The cloud names the person from the ticket it verified. Believe that only
  // for a user this desktop knows; otherwise the tunnel's own user is the most
  // this side can honestly claim.
  const claimed = c.req.header(CROSS_WORKSPACE_REQUESTER_HEADER)
  const known = claimed
    ? await db.user.findUnique({ where: { id: claimed }, select: { id: true } }).catch(() => null)
    : null
  const requesterUserId = known?.id ?? tunnelUserId

  const write = c.req.method !== 'GET' && c.req.method !== 'HEAD'
  const access = await targetWorkspaceAccess(requesterUserId, workspaceId).catch(() => null)
  if (!access || !targetAccessAllows(access, write)) return null
  return { workspaceId, requesterUserId }
}

/**
 * `authenticate` for the desktop's internal router (SHO-493): a request the
 * cloud forwarded for a workspace this desktop hosts authenticates as that
 * workspace's runtime. Everything else — every other path, every cloud-mode
 * API, any request missing a header — falls through to the runtime token.
 */
export async function authenticateHostedForward(
  c: any,
  projectId?: string,
): Promise<import('../routes/internal-runtime-auth').InternalIdentity | null> {
  // Never on a project-scoped route: `project_call` into a hosted workspace is
  // not part of this, and the forward only ever names a workspace path.
  if (projectId) return null
  const forward = await hostedForward(c)
  return forward ? { kind: 'workspace', workspaceId: forward.workspaceId } : null
}

export interface ForwardToHostInput {
  /** The paired desktop whose compute the workspace lives on. */
  hostInstanceId: string
  /** The person the call is made for (the verified ticket's user). */
  requesterUserId: string
  /** The Personal workspace the person was acting in. */
  callerWorkspaceId: string
  /** The tool the runtime gated, carried for the desktop's audit line. */
  tool?: string | null
}

export interface ForwardToHostOptions {
  /** Test seam: the instance-tunnel transport. */
  _tunnel?: import('./host-tunnel').TunnelTransport
  /** Test seam: how long to wait for a sleeping desktop. */
  _wakeDeadlineMs?: number
}

/**
 * Forward one cross-workspace call to the desktop that hosts the workspace
 * (SHO-493), and pass its answer back unchanged.
 *
 * The tunnel is woken first: an offline host is `503 device_offline` with its
 * name and last-seen time — the same shape `/devices/:instanceId/remote-tool`
 * answers — never a 200 with an empty body. A tunnel that dies mid-request is
 * `503 device_offline` when it says the machine is offline and `502
 * device_tunnel_error` otherwise.
 */
export async function forwardToHost(
  c: any,
  input: ForwardToHostInput,
  opts: ForwardToHostOptions = {},
): Promise<Response> {
  const instance = await db.instance
    .findUnique({
      where: { id: input.hostInstanceId },
      select: { id: true, name: true, userId: true, lastSeenAt: true },
    })
    .catch(() => null)
  const offline = () =>
    deviceOffline(c, input.hostInstanceId, instance?.name ?? null, instance?.lastSeenAt ?? null)

  if (!instance?.userId) return offline()

  let tunnel: import('./host-tunnel').TunnelTransport
  try {
    tunnel = opts._tunnel ?? ((await import('../routes/instances')) as unknown as import('./host-tunnel').TunnelTransport)
  } catch {
    return offline()
  }
  const { hostWakeDeadlineMs } = await import('./host-tunnel')
  const deadline = opts._wakeDeadlineMs ?? hostWakeDeadlineMs()
  if (!(await tunnel.ensureTunnelConnected(input.hostInstanceId, deadline).catch(() => false))) return offline()

  const method = c.req.method
  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.text()
  const headers: Record<string, string> = {
    // One user: the desktop belongs to the person whose tunnel this is.
    'x-tunnel-auth-user-id': instance.userId,
    [CROSS_WORKSPACE_HOSTED_FROM_HEADER]: input.callerWorkspaceId,
    [CROSS_WORKSPACE_REQUESTER_HEADER]: input.requesterUserId,
  }
  if (input.tool) headers[CROSS_WORKSPACE_TOOL_HEADER] = input.tool
  if (body !== undefined) headers['content-type'] = c.req.header('content-type') ?? 'application/json'

  try {
    const resp = await tunnel.sendTunnelRequest(input.hostInstanceId, {
      type: 'request',
      requestId: tunnel.generateRequestId(),
      method,
      path: c.req.path + new URL(c.req.url).search,
      headers,
      body,
    })
    const { DROP_RESPONSE_HEADERS } = await import('./host-tunnel')
    const out = new Headers()
    for (const [key, value] of Object.entries(resp.headers ?? {})) {
      if (value && !DROP_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value)
    }
    if (!out.has('content-type')) out.set('content-type', 'application/json')
    return new Response(resp.body || '', { status: resp.status, headers: out })
  } catch (err: any) {
    if (/offline/i.test(err?.message ?? '')) return offline()
    return c.json(
      {
        error: {
          code: 'device_tunnel_error',
          message: err?.message ?? 'The desktop hosting that workspace could not be reached',
          instanceId: input.hostInstanceId,
          retryable: true,
        },
      },
      502,
    )
  }
}

/** The `device_offline` refusal, the same shape the device-tools route uses. */
function deviceOffline(c: any, instanceId: string, name: string | null, lastSeenAt: Date | null): Response {
  const seen = lastSeenAt ? new Date(lastSeenAt).toISOString() : null
  return c.json(
    {
      error: {
        code: 'device_offline',
        message: `${name || 'The desktop hosting that workspace'} is offline${seen ? ` (last seen ${seen})` : ''}`,
        instanceId,
        lastSeenAt: seen,
      },
    },
    503,
  )
}
