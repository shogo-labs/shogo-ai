import * as billingService from "../services/billing.service"
import { getPublishedPlanCaps } from "../config/usage-plans"
import { isPublishMetalAuthoritative } from "./publish-substrate-config"

/**
 * What publishing can do for this workspace, from the same sources the publish
 * route enforces — the plan's published-app caps (`usage-plans.ts`) and the
 * substrate seam (`publish-substrate-config.ts`). The agent renders it as the
 * one "Publishing:" line in its account context, so a claim like "up to five
 * replicas" or "staging available" is only ever made where it is true
 * (SHO-362). When SHO-308's rollout flips the substrate, the line changes by
 * itself — no prompt edit.
 */
export interface PublishHostingStamp {
  substrate: 'metal' | 'knative'
  alwaysOn: boolean
  /** `null` = unlimited. */
  maxReplicas: number | null
  staging: boolean
}

export function buildPublishHostingStamp(
  planId: string | null | undefined,
  alwaysOnAllowance: number,
): PublishHostingStamp {
  const substrate = isPublishMetalAuthoritative() ? 'metal' : 'knative'
  const caps = getPublishedPlanCaps(planId)
  return {
    substrate,
    // `Infinity` is the local-mode / unlimited-enterprise allowance.
    alwaysOn: alwaysOnAllowance > 0,
    // Metal serves a published app from one instance and does not scale; the
    // plan's replica cap only applies where replicas exist at all.
    maxReplicas: substrate === 'metal' ? 1 : caps.maxReplicas,
    // A staging environment is a second Knative service with its own database;
    // metal has no equivalent, so never advertise one there.
    staging: substrate === 'knative' && caps.staging,
  }
}

/**
 * Tell the runtime the workspace's plan, whether it may publish to a
 * subdomain, and what publishing can actually do here, so the agent can tell
 * the user about the Pro-plan publish gate BEFORE doing deploy work instead of
 * discovering it from a failed `publish`.
 *
 * Mutates `parsedBody` in place. Best-effort: a billing lookup failure leaves
 * every field unset and the chat proceeds.
 */
export async function stampWorkspacePlan(
  parsedBody: { planId?: unknown; canPublishSubdomain?: unknown; publishHosting?: unknown },
  workspaceId: string,
): Promise<void> {
  try {
    const [planId, canPublish, alwaysOnAllowance] = await Promise.all([
      billingService.getEffectivePlanId(workspaceId),
      billingService.canPublishSubdomain(workspaceId),
      billingService.getAlwaysOnAllowanceForWorkspace(workspaceId),
    ])
    parsedBody.planId = planId
    parsedBody.canPublishSubdomain = canPublish
    parsedBody.publishHosting = buildPublishHostingStamp(planId, alwaysOnAllowance)
  } catch (err: any) {
    delete parsedBody.planId
    delete parsedBody.canPublishSubdomain
    delete parsedBody.publishHosting
    console.warn(`[stampWorkspacePlan] plan lookup failed for ${workspaceId}:`, err?.message ?? err)
  }
}
