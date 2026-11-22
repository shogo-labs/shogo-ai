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
  substrate: 'metal' | 'knative' | 'desktop'
  alwaysOn: boolean
  /** `null` = unlimited. */
  maxReplicas: number | null
  staging: boolean
}

/**
 * Desktop (`SHOGO_LOCAL_MODE`) has no hosting pipeline of its own: a publish
 * builds the bundle locally and uploads it to Shogo Cloud as a **static** site
 * (`services/local-publish.service.ts`), and a server-backed project is refused
 * with `server_backed_requires_cloud_project`. So none of the cloud
 * capabilities are true there, and the stamp must say so — otherwise the agent
 * promises always-on, replicas and staging on a machine that has none of them
 * (QA round 1 on SHO-362).
 */
function isDesktopMode(): boolean {
  return process.env.SHOGO_LOCAL_MODE === 'true'
}

export function buildPublishHostingStamp(
  planId: string | null | undefined,
  alwaysOnAllowance: number,
): PublishHostingStamp {
  if (isDesktopMode()) {
    return { substrate: 'desktop', alwaysOn: false, maxReplicas: 1, staging: false }
  }
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
 * On desktop the plan comes from the linked cloud workspace
 * (`getPlanStamp`), never from the local rows that can only answer `free`, and
 * `desktopUnlimited` says this machine has no plan limits at all — without it
 * an agent reads "Workspace plan: Free" and refuses heartbeats, models and
 * schedules that work here (SHO-508). Unlinked desktop stamps no `planId` at
 * all rather than a wrong one.
 *
 * Mutates `parsedBody` in place. Best-effort: a billing lookup failure leaves
 * every field unset and the chat proceeds.
 */
export async function stampWorkspacePlan(
  parsedBody: {
    planId?: unknown
    desktopUnlimited?: unknown
    canPublishSubdomain?: unknown
    publishHosting?: unknown
  },
  workspaceId: string,
): Promise<void> {
  // `null` = desktop, no known plan; `undefined` = the lookup failed.
  let planId: string | null | undefined
  try {
    const [stamp, canPublish] = await Promise.all([
      billingService.getPlanStamp(workspaceId),
      billingService.canPublishSubdomain(workspaceId),
    ])
    planId = stamp.planId
    if (stamp.planId) parsedBody.planId = stamp.planId
    else delete parsedBody.planId
    if (stamp.desktopUnlimited) parsedBody.desktopUnlimited = true
    else delete parsedBody.desktopUnlimited
    parsedBody.canPublishSubdomain = canPublish
  } catch (err: any) {
    delete parsedBody.planId
    delete parsedBody.desktopUnlimited
    delete parsedBody.canPublishSubdomain
    console.warn(`[stampWorkspacePlan] plan lookup failed for ${workspaceId}:`, err?.message ?? err)
  }

  // The hosting line is additive, so it gets its own try: the always-on
  // allowance reads subscriptions and grants, and a failure there must not
  // strip `planId` / `canPublishSubdomain` from a turn that was otherwise
  // stamped fine. Sequential, not `Promise.all` — when both lookups reject,
  // the loser of the race is an unhandled rejection that bun reports as a
  // failed test in every suite that mocks a partial prisma.
  try {
    // A failed plan lookup is retried here so a billing outage keeps the
    // hosting line off too, as before.
    const effectivePlanId = planId === undefined
      ? (await billingService.getPlanStamp(workspaceId)).planId
      : planId
    const alwaysOnAllowance = await billingService.getAlwaysOnAllowanceForWorkspace(workspaceId)
    parsedBody.publishHosting = buildPublishHostingStamp(effectivePlanId, alwaysOnAllowance)
  } catch (err: any) {
    delete parsedBody.publishHosting
    console.warn(`[stampWorkspacePlan] hosting lookup failed for ${workspaceId}:`, err?.message ?? err)
  }
}
