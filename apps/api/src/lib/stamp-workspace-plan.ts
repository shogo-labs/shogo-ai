import * as billingService from "../services/billing.service"

/**
 * Tell the runtime the workspace's plan and whether it may publish to a
 * subdomain, so the agent can tell the user about the Pro-plan publish gate
 * BEFORE doing deploy work instead of discovering it from a failed `publish`.
 *
 * Mutates `parsedBody` in place. Best-effort: a billing lookup failure leaves
 * both fields unset and the chat proceeds.
 */
export async function stampWorkspacePlan(
  parsedBody: { planId?: unknown; canPublishSubdomain?: unknown },
  workspaceId: string,
): Promise<void> {
  try {
    const [planId, canPublish] = await Promise.all([
      billingService.getEffectivePlanId(workspaceId),
      billingService.canPublishSubdomain(workspaceId),
    ])
    parsedBody.planId = planId
    parsedBody.canPublishSubdomain = canPublish
  } catch (err: any) {
    delete parsedBody.planId
    delete parsedBody.canPublishSubdomain
    console.warn(`[stampWorkspacePlan] plan lookup failed for ${workspaceId}:`, err?.message ?? err)
  }
}
