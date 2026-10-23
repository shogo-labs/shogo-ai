// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How many agent replies may be *working at once* in a workspace.
 *
 * The number is an admission rule for new runs (see `agent-reply-slots.ts`), so
 * it is resolved at every admission and cached only briefly: a change applies
 * without a restart, and raising it drains the queue straight away.
 *
 * Precedence:
 *   1. `SHOGO_CHANNEL_AGENT_CONCURRENCY` — an ops override that wins on both
 *      surfaces (desktop and cloud) and becomes the ceiling.
 *   2. The workspace's own `agentReplyConcurrency`, which an admin may lower.
 *   3. The maximum: 24 on desktop (no plan), the plan's tier in the cloud,
 *      pooled from the parent workspace for a child.
 */

import { prisma } from '../lib/prisma'
import { isLocalMode } from '../lib/federated-upstream'
import {
  AGENT_REPLY_CONCURRENCY,
  LOCAL_AGENT_REPLY_CONCURRENCY,
  type PlanId,
} from '../config/usage-plans'

const db = prisma as any

/** The highest value an admin may set on desktop, where there is no plan ceiling. */
export const LOCAL_AGENT_REPLY_CONCURRENCY_MAX = 100

/** A plan/subscription change is picked up within this window even without an explicit invalidation. */
const CACHE_TTL_MS = 60_000

export interface AgentReplyCapacity {
  /** Slots a new run is admitted against right now. */
  limit: number
  /** The most this workspace may be configured to. */
  max: number
  /** What a workspace with no explicit setting gets. */
  defaultLimit: number
  /** The workspace's own setting, or null when it uses the default. */
  configured: number | null
  source: 'plan' | 'local'
  planId: PlanId
}

const cache = new Map<string, { at: number; value: AgentReplyCapacity }>()

/** Drop the cached capacity (all workspaces when none is named). */
export function invalidateAgentReplyCapacity(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId)
  else cache.clear()
}

/** Ops override, or null when unset. */
export function agentReplyConcurrencyOverride(): number | null {
  const value = Number(process.env.SHOGO_CHANNEL_AGENT_CONCURRENCY)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

export async function resolveAgentReplyCapacity(workspaceId: string): Promise<AgentReplyCapacity> {
  const hit = cache.get(workspaceId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const override = agentReplyConcurrencyOverride()
  const local = isLocalMode()
  let planId: PlanId = 'free'
  let max = local ? LOCAL_AGENT_REPLY_CONCURRENCY_MAX : AGENT_REPLY_CONCURRENCY.free
  if (!local) {
    const { getEffectivePlanId } = await import('./billing.service')
    planId = (await getEffectivePlanId(workspaceId).catch(() => 'free')) as PlanId
    max = AGENT_REPLY_CONCURRENCY[planId] ?? AGENT_REPLY_CONCURRENCY.free
  }
  // The ops override is the ceiling on both surfaces, so a workspace setting can
  // never push past what the machine was told to run.
  if (override) max = override
  const defaultLimit = local ? Math.min(LOCAL_AGENT_REPLY_CONCURRENCY, max) : max

  const row = await db.workspace
    .findUnique({ where: { id: workspaceId }, select: { agentReplyConcurrency: true } })
    .catch(() => null)
  const configured = typeof row?.agentReplyConcurrency === 'number' ? row.agentReplyConcurrency : null
  const limit = Math.max(1, Math.min(configured ?? defaultLimit, max))

  const value: AgentReplyCapacity = {
    limit,
    max,
    defaultLimit,
    configured,
    source: local ? 'local' : 'plan',
    planId,
  }
  cache.set(workspaceId, { at: Date.now(), value })
  return value
}

/** Just the number, for the admission path. */
export async function resolveAgentReplyLimit(workspaceId: string): Promise<number> {
  return (await resolveAgentReplyCapacity(workspaceId)).limit
}
