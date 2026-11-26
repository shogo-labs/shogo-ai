// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A hosted workspace's Analytics is read from the cloud, on the desktop too
 * (SHO-590 §C).
 *
 * Since SHO-590 the cloud meters a desktop's forwarded model calls to the
 * workspace the turn ran in, so the cloud's per-call ledger is what the panels
 * must read on *both* surfaces — otherwise the desktop and the cloud show two
 * different numbers for the same workspace, which is exactly the divergence
 * "Desktop and cloud must never diverge" forbids. The desktop keeps writing its
 * own rows (UsageEvent for the unpaired case, AgentCostMetric to be mirrored);
 * they are just no longer the answer while the cloud is the meter.
 *
 * Only a cloud-authed desktop that forwards its AI traffic gets here
 * (`isShogoCloudForwarding`), and only for a workspace the cloud marks as hosted
 * on this machine (`hostInstanceId`). Under BYOK / local-LLM the spend never
 * reaches the cloud, so local rows are the only — and correct — answer; an
 * unpaired desktop, or a workspace whose compute is the cloud's own, never
 * forwards either. Their Analytics is unchanged.
 *
 * The request is relayed verbatim (path, query, body) with the device key, and
 * a cloud failure is returned as an error rather than silently falling back to
 * local rows — a fallback would bring back the second answer this fixes.
 */

import type { Context, Next } from 'hono'
import { prisma } from '../lib/prisma'
import { isShogoCloudForwarding } from '../lib/cloud-forwarding'
import { copyResponseHeaders, forwardToUpstream } from '../lib/federated-upstream'

/**
 * The workspace families this answers for. `analytics` covers the dashboard,
 * usage log and its CSV; `cost-analytics` covers the Cost Optimizer reads.
 */
export const HOSTED_ANALYTICS_PATHS = [
  '/api/workspaces/:workspaceId/analytics/*',
  '/api/workspaces/:workspaceId/cost-analytics/*',
] as const

export function hostedAnalyticsUpstream() {
  return async (c: Context, next: Next) => {
    if (!isShogoCloudForwarding()) return next()

    const workspaceId = c.req.param('workspaceId')
    if (!workspaceId) return next()

    // A *hosted* workspace, and one this desktop actually has. `hostInstanceId`
    // is the cloud's mark that the workspace's turns run on a paired machine —
    // here. A local-only workspace, or one whose compute is the cloud's own,
    // keeps reading local rows, exactly as it does today.
    const local = await prisma.workspace
      .findUnique({ where: { id: workspaceId }, select: { id: true, hostInstanceId: true } })
      .catch(() => null)
    if (!local?.hostInstanceId) return next()

    try {
      const response = await forwardToUpstream(c, { signal: c.req.raw.signal })
      return new Response(response.body, {
        status: response.status,
        headers: copyResponseHeaders(response),
      })
    } catch (error: any) {
      return c.json(
        {
          error: {
            code: 'cloud_unreachable',
            message: error?.message || 'Unable to reach Shogo Cloud',
          },
        },
        502,
      )
    }
  }
}
