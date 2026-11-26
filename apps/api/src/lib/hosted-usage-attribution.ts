// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where a desktop's forwarded model call is *attributed* (SHO-590).
 *
 * A paired desktop runs a hosted workspace's agent turns on its own machine and
 * forwards every model call to the cloud ai-proxy with the device key. The key
 * is scoped to the *paying* workspace (the one that registered the machine), so
 * without a hint the cloud meters the call there: `projectId: null`, no chat, no
 * person — and the hosted workspace's Analytics reads almost nothing while the
 * paying workspace's reads everyone's desktop spend as "no project".
 *
 * The fix is attribution only. Who pays does not move: the wallet still comes
 * from `resolveBillingWorkspaceId(hostedWorkspace)` and the gates still run
 * against the key's workspace. This module decides whether a device key may name
 * a hosted workspace on the way in, and refuses everything it cannot prove.
 *
 * The desktop sends three headers (see `cloudPassthroughHeaders`):
 *   x-shogo-workspace-id  the workspace the turn ran in (hosted by that machine)
 *   x-shogo-project-id    its project, when the turn belongs to a real one
 *   x-shogo-member-id     the person the turn was for
 *
 * A hint is accepted only when all of these hold:
 *   • the key is a **device** key (`kind: 'device'`, minted by the desktop login);
 *   • the named workspace is hosted (`hostInstanceId` set) by an `Instance` that
 *     belongs to the key's workspace and the key's user — the same binding
 *     `resolveBillingWorkspaceId` trusts before it lends a plan or wallet;
 *   • the key's user is still a member of the hosted workspace;
 *   • any named project belongs to that workspace;
 *   • any named person is a member of that workspace.
 *
 * Anything else is ignored (and logged once per key and reason) so the call
 * records exactly as it did before.
 *
 * `api_keys.deviceId` and `instances.deviceId` are different id spaces in
 * production, so nothing here binds on a device id.
 */

import { prisma } from './prisma'

/** The workspace the turn ran in. */
export const USAGE_WORKSPACE_HEADER = 'x-shogo-workspace-id'
/** The hosted workspace's project, when the call belongs to a real one. */
export const USAGE_PROJECT_HEADER = 'x-shogo-project-id'
/** The person the turn was for. */
export const USAGE_MEMBER_HEADER = 'x-shogo-member-id'

export interface HostedUsageAttribution {
  /** Hosted workspace the usage belongs to. */
  workspaceId: string
  /** Real project inside it, or null for the workspace agent. */
  projectId: string | null
  /** The person who sent the turn, or null when unknown. */
  memberId: string | null
}

/** What the key resolves to, as `resolveApiKey` reports it. */
export interface DeviceKeyFacts {
  workspaceId: string
  userId: string
  kind: string
  deviceId?: string | null
}

export type AttributionRejection =
  | 'not_device_key'
  | 'unknown_workspace'
  | 'not_hosted'
  | 'unknown_instance'
  | 'instance_workspace_mismatch'
  | 'instance_user_mismatch'
  | 'not_member'
  | 'project_not_in_workspace'
  | 'member_not_in_workspace'

export type AttributionResult =
  | { ok: true; attribution: HostedUsageAttribution }
  | { ok: false; reason: AttributionRejection }

/**
 * Attribution is stable for a machine (a workspace, its host instance and the
 * person do not change under a turn), and the desktop sends the same hints on
 * every proxied call — up to ~1,500 a day for one machine. So the decision is
 * memoised briefly instead of costing four reads per model call. A rejected
 * hint is cached too, otherwise a stale desktop would query on every call; the
 * TTL is short enough that a fixed pairing recovers on its own.
 */
const CACHE_TTL_MS = 60_000
const CACHE_LIMIT = 500
type CacheEntry = { result: AttributionResult; expiresAt: number }
const cache = new Map<string, CacheEntry>()

/** Test seam: forget every memoised decision. */
export function _resetHostedUsageAttributionCache(): void {
  cache.clear()
  loggedRejections.clear()
}

const loggedRejections = new Set<string>()

function cacheKey(facts: DeviceKeyFacts, hints: { workspaceId: string; projectId: string | null; memberId: string | null }): string {
  return [
    facts.userId,
    facts.workspaceId,
    facts.kind,
    facts.deviceId ?? '',
    hints.workspaceId,
    hints.projectId ?? '',
    hints.memberId ?? '',
  ].join('\u0000')
}

/**
 * Log one rejection per key and reason. The key itself is never logged — the
 * fingerprint is the user/workspace it belongs to.
 */
function logRejection(facts: DeviceKeyFacts, reason: AttributionRejection): void {
  const id = `${facts.userId}:${facts.workspaceId}:${facts.deviceId ?? ''}:${reason}`
  if (loggedRejections.has(id)) return
  if (loggedRejections.size >= CACHE_LIMIT) loggedRejections.clear()
  loggedRejections.add(id)
  console.warn(
    `[AI Proxy] ignoring desktop usage attribution hint (${reason}) — user ${facts.userId} workspace ${facts.workspaceId}`,
  )
}

/**
 * Decide whether `facts` (a resolved `shogo_sk_` key) may attribute usage to the
 * workspace/project/person a desktop named. Never throws: a lookup failure is a
 * rejection, so a broken hint can only ever fall back to today's recording.
 */
export async function resolveHostedUsageAttribution(
  facts: DeviceKeyFacts,
  hints: { workspaceId?: string | null; projectId?: string | null; memberId?: string | null },
): Promise<AttributionResult> {
  const workspaceId = typeof hints.workspaceId === 'string' ? hints.workspaceId.trim() : ''
  if (!workspaceId || workspaceId.length > 128) return reject(facts, 'unknown_workspace')

  const projectId = typeof hints.projectId === 'string' && hints.projectId.trim() ? hints.projectId.trim() : null
  const memberId = typeof hints.memberId === 'string' && hints.memberId.trim() ? hints.memberId.trim() : null
  const key = cacheKey(facts, { workspaceId, projectId, memberId })

  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.result

  let result: AttributionResult
  try {
    result = await decide(facts, { workspaceId, projectId, memberId })
  } catch (err) {
    console.warn('[AI Proxy] hosted usage attribution lookup failed:', (err as any)?.message ?? err)
    result = { ok: false, reason: 'unknown_workspace' }
  }

  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS })
  if (!result.ok) logRejection(facts, result.reason)
  return result
}

function reject(facts: DeviceKeyFacts, reason: AttributionRejection): AttributionResult {
  // A missing hint header is the normal case (every non-desktop caller) — not
  // worth a log line on every request.
  if (reason !== 'unknown_workspace') logRejection(facts, reason)
  return { ok: false, reason }
}

async function decide(
  facts: DeviceKeyFacts,
  hints: { workspaceId: string; projectId: string | null; memberId: string | null },
): Promise<AttributionResult> {
  if (facts.kind !== 'device') return { ok: false, reason: 'not_device_key' }

  const workspace = (await prisma.workspace.findUnique({
    where: { id: hints.workspaceId },
    select: { id: true, hostInstanceId: true },
  })) as { id: string; hostInstanceId: string | null } | null
  if (!workspace) return { ok: false, reason: 'unknown_workspace' }
  if (!workspace.hostInstanceId) return { ok: false, reason: 'not_hosted' }

  const instance = (await prisma.instance.findUnique({
    where: { id: workspace.hostInstanceId },
    select: { workspaceId: true, userId: true },
  })) as { workspaceId: string; userId: string | null } | null
  if (!instance) return { ok: false, reason: 'unknown_instance' }
  if (instance.workspaceId !== facts.workspaceId) return { ok: false, reason: 'instance_workspace_mismatch' }
  if (instance.userId !== facts.userId) return { ok: false, reason: 'instance_user_mismatch' }

  const keyMember = await prisma.member.findFirst({
    where: { workspaceId: hints.workspaceId, userId: facts.userId, projectId: null },
    select: { id: true },
  })
  if (!keyMember) return { ok: false, reason: 'not_member' }

  if (hints.projectId) {
    const project = (await prisma.project.findUnique({
      where: { id: hints.projectId },
      select: { workspaceId: true },
    })) as { workspaceId: string } | null
    if (!project || project.workspaceId !== hints.workspaceId) {
      return { ok: false, reason: 'project_not_in_workspace' }
    }
  }

  // The key's own user is already proven a member above; anyone else is checked.
  if (hints.memberId && hints.memberId !== facts.userId) {
    const person = await prisma.member.findFirst({
      where: { workspaceId: hints.workspaceId, userId: hints.memberId, projectId: null },
      select: { id: true },
    })
    if (!person) return { ok: false, reason: 'member_not_in_workspace' }
  }

  return {
    ok: true,
    attribution: {
      workspaceId: hints.workspaceId,
      projectId: hints.projectId,
      memberId: hints.memberId,
    },
  }
}

/**
 * Do these headers name the same hosted workspace `workspaceId`? Runs the same
 * binding for a tenant/analytics read (SHO-590 §C): the desktop answers a hosted
 * workspace's Analytics from the cloud, and the cloud must let the device key
 * that hosts it read it.
 */
export async function deviceKeyMayReadHostedWorkspace(
  facts: DeviceKeyFacts,
  workspaceId: string,
): Promise<boolean> {
  const result = await resolveHostedUsageAttribution(facts, { workspaceId })
  return result.ok
}
