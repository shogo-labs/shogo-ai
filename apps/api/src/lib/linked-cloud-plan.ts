// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The plan of the Shogo Cloud workspace a desktop install is signed into
 * (SHO-508).
 *
 * A local install (`SHOGO_LOCAL_MODE=true`) has no `Subscription` row and no
 * grants, so every billing read that resolves the plan from local rows answers
 * `free` — even when the desktop is signed into a paid cloud account. The plan
 * that is actually true there is the *cloud* one, and the billing bridge
 * (`routes/local-cloud-billing.ts`) already forwards exactly that read. This
 * module owns it so there is one source, with two policies on top:
 *
 *  - `readLinkedCloudPlan` — one upstream read per call; transport errors are
 *    thrown so a route can report them (the billing summary does).
 *  - `getLinkedCloudPlanId` — the cached, never-throwing view used on the chat
 *    stamp path, where a cloud round-trip on every turn (or a failure inside
 *    one) is not acceptable.
 */
import { fetchUpstream, getUpstreamWorkspaceId } from './federated-upstream'
import { normalizePlanId, type PlanId } from '../config/usage-plans'

export interface LinkedCloudPlanRead {
  workspaceId: string
  status: number
  ok: boolean
  /** The upstream body, forwarded as-is by the caller (it carries errors too). */
  body: unknown
  /** The tier from `body.planId`, or `null` when the body carries no usable one. */
  planId: PlanId | null
}

/**
 * Resolve the cloud plan for the linked cloud workspace. Throws only on a
 * transport failure — an error status is returned, because the summary route
 * reports those to the client itself (401 drives the re-auth prompt).
 */
export async function readLinkedCloudPlan(
  workspaceId: string,
  opts: { timeoutMs?: number } = {},
): Promise<LinkedCloudPlanRead> {
  const init: RequestInit & { search?: string } = {
    method: 'GET',
    search: `?workspaceId=${encodeURIComponent(workspaceId)}`,
  }
  if (opts.timeoutMs) init.signal = AbortSignal.timeout(opts.timeoutMs)

  const response = await fetchUpstream('/api/billing/workspace-plan', init)
  const body = await response.json().catch(() => ({ error: `Cloud returned HTTP ${response.status}` }))
  return {
    workspaceId,
    status: response.status,
    ok: response.ok,
    body,
    planId: readPlanId(body),
  }
}

function readPlanId(body: unknown): PlanId | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const planId = (body as { planId?: unknown }).planId
  return normalizePlanId(typeof planId === 'string' ? planId : null)
}

/**
 * How long a successful read is trusted. `getEffectivePlanId` sits on the chat
 * stamp path, so this must not turn every turn into a cloud round-trip.
 */
const CACHE_TTL_MS = 5 * 60 * 1000
/**
 * How soon a failed read is retried. The last good plan keeps being served in
 * the meantime, so a blip never downgrades the agent's account context, but a
 * recovery shows up within a minute rather than a whole cache window.
 */
const FAILURE_TTL_MS = 60 * 1000
/** The stamp path may never wait on the cloud for long. */
const READ_TIMEOUT_MS = 2_000

let cached: { workspaceId: string; planId: PlanId | null; expiresAt: number } | null = null
let inflight: Promise<PlanId | null> | null = null

/** Test-only: drop the cache. */
export function _resetLinkedCloudPlanCache(): void {
  cached = null
  inflight = null
}

/**
 * The linked cloud plan tier, or `null` when this desktop is not linked, the
 * cloud knows no plan, or the last read failed with nothing good to fall back
 * to. Never throws and never waits more than ~2s: this runs while a chat turn
 * is being stamped.
 */
export async function getLinkedCloudPlanId(): Promise<PlanId | null> {
  try {
    const workspaceId = await getUpstreamWorkspaceId()
    if (!workspaceId) {
      cached = null
      return null
    }
    if (cached?.workspaceId === workspaceId && cached.expiresAt > Date.now()) {
      return cached.planId
    }
    // One read at a time: a burst of chat turns must not fan out into a burst
    // of upstream calls.
    inflight ??= readOnce(workspaceId).finally(() => {
      inflight = null
    })
    return await inflight
  } catch (err: any) {
    console.warn(`[linked-cloud-plan] plan read failed:`, err?.message ?? err)
    return cached?.planId ?? null
  }
}

async function readOnce(workspaceId: string): Promise<PlanId | null> {
  let planId: PlanId | null = null
  let ok = false
  try {
    const read = await readLinkedCloudPlan(workspaceId, { timeoutMs: READ_TIMEOUT_MS })
    ok = read.ok
    planId = read.planId
    if (!ok) {
      console.warn(`[linked-cloud-plan] upstream answered HTTP ${read.status}; keeping the last known plan`)
    }
  } catch (err: any) {
    console.warn(`[linked-cloud-plan] upstream unreachable:`, err?.message ?? err)
  }

  if (ok) {
    cached = { workspaceId, planId, expiresAt: Date.now() + CACHE_TTL_MS }
    return planId
  }
  const lastGood = cached?.workspaceId === workspaceId ? cached.planId : null
  cached = { workspaceId, planId: lastGood, expiresAt: Date.now() + FAILURE_TTL_MS }
  return lastGood
}
