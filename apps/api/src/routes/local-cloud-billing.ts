// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-mode billing bridge.
 *
 * A local install has its own Better Auth user and workspace, but a linked
 * Shogo Cloud device key is scoped to a cloud workspace. These routes keep
 * the local UI on the local API while forwarding billing reads/writes to the
 * linked cloud workspace with that device key.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import {
  fetchUpstream,
  getUpstreamCredential,
  getUpstreamWorkspaceId,
} from '../lib/federated-upstream'
import { markCloudKeyRejectedIfConfirmed } from '../lib/cloud-key-state'
import { readLinkedCloudPlan } from '../lib/linked-cloud-plan'

type StoredKeyInfo = {
  workspace?: { id?: string; name?: string; slug?: string }
  user?: { id?: string; name?: string; email?: string }
}

async function readKeyInfo(): Promise<StoredKeyInfo | null> {
  try {
    const row = await (prisma as any).localConfig.findUnique({
      where: { key: 'SHOGO_KEY_INFO' },
    })
    if (!row?.value) return null
    return JSON.parse(row.value) as StoredKeyInfo
  } catch {
    return null
  }
}

async function readCloudWorkspace() {
  const info = await readKeyInfo()
  const workspaceId = await getUpstreamWorkspaceId()
  if (!workspaceId) return null
  return {
    id: workspaceId,
    name: info?.workspace?.name ?? null,
    slug: info?.workspace?.slug ?? null,
  }
}

async function upstreamJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({ error: `Cloud returned HTTP ${response.status}` }))
}

function cloudBillingUrls(workspaceId?: string) {
  const cloudUrl = getShogoCloudUrl()
  if (!workspaceId) return { cloudUrl }
  const workspace = encodeURIComponent(workspaceId)
  return {
    cloudUrl,
    manageUrl: `${cloudUrl}/settings?tab=billing&workspace=${workspace}`,
    upgradeUrl: `${cloudUrl}/billing?workspace=${workspace}`,
  }
}

export function localCloudBillingRoutes() {
  const router = new Hono()

  router.get('/local/cloud-billing/summary', async (c) => {
    const workspace = await readCloudWorkspace()
    if (!workspace) {
      return c.json({
        signedIn: false,
        ...cloudBillingUrls(),
      })
    }

    try {
      // Same read the chat stamp uses for the desktop plan (SHO-508), so the
      // card and the agent's account context can never disagree.
      const read = await readLinkedCloudPlan(workspace.id)
      const plan = read.body
      if (read.status === 401) {
        const cloudKeyRejected = await markCloudKeyRejectedIfConfirmed(
          'billing summary 401',
          await getUpstreamCredential(),
        )
        return c.json({
          signedIn: true,
          cloudKeyRejected,
          workspace: workspace,
          ...cloudBillingUrls(workspace.id),
          plan,
        }, 401)
      }
      if (!read.ok) {
        // Return 200 (not the upstream status) so the client still receives
        // the workspace + cloud URLs and can keep Upgrade / Manage working
        // while it shows the plan-load error. Only a confirmed 401 above is
        // surfaced as an HTTP error, since that drives the re-auth prompt.
        return c.json({
          signedIn: true,
          workspace,
          ...cloudBillingUrls(workspace.id),
          error: plan,
          upstreamStatus: read.status,
        })
      }

      const info = await readKeyInfo()
      return c.json({
        signedIn: true,
        cloudKeyRejected: false,
        email: info?.user?.email ?? null,
        workspace,
        ...cloudBillingUrls(workspace.id),
        plan,
      })
    } catch (error: any) {
      return c.json({
        signedIn: true,
        workspace,
        ...cloudBillingUrls(workspace.id),
        error: error?.message || 'Unable to reach Shogo Cloud',
      })
    }
  })

  router.post('/local/cloud-billing/usage-based-pricing', async (c) => {
    const workspace = await readCloudWorkspace()
    if (!workspace) {
      return c.json({
        error: { code: 'cloud_not_connected', message: 'Sign in to Shogo Cloud first.' },
      }, 401)
    }

    const body = await c.req.json().catch(() => ({}))
    const response = await fetchUpstream('/api/billing/usage-based-pricing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        workspaceId: workspace.id,
      }),
    })
    const result = await upstreamJson(response)
    return c.json(result, response.status as any)
  })

  /**
   * Forward a cloud billing call for the linked workspace (SHO-451).
   *
   * Desktop and cloud must never diverge: the summary card, plan change and
   * cancel/resume all run against the same cloud routes. A local install with
   * no linked workspace gets a typed `cloud_not_connected` error the UI can
   * show, never a blank card.
   */
  async function forwardBilling(
    c: any,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ) {
    const workspace = await readCloudWorkspace()
    if (!workspace) {
      return c.json({
        error: { code: 'cloud_not_connected', message: 'Sign in to Shogo Cloud first.' },
      }, 401)
    }
    try {
      const response = await fetchUpstream(
        path,
        method === 'GET'
          ? { method, search: `?workspaceId=${encodeURIComponent(workspace.id)}` }
          : {
              method,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...(body ?? {}), workspaceId: workspace.id }),
            },
      )
      const result = await upstreamJson(response)
      return c.json(result, response.status as any)
    } catch (error: any) {
      return c.json({
        error: {
          code: 'cloud_unreachable',
          message: error?.message || 'Unable to reach Shogo Cloud',
        },
      }, 502)
    }
  }

  router.get('/local/cloud-billing/billing-summary', async (c) =>
    forwardBilling(c, '/api/billing/summary', 'GET'),
  )

  router.post('/local/cloud-billing/change-plan/preview', async (c) =>
    forwardBilling(c, '/api/billing/change-plan/preview', 'POST', await c.req.json().catch(() => ({}))),
  )

  router.post('/local/cloud-billing/change-plan', async (c) =>
    forwardBilling(c, '/api/billing/change-plan', 'POST', await c.req.json().catch(() => ({}))),
  )

  router.post('/local/cloud-billing/cancel', async (c) =>
    forwardBilling(c, '/api/billing/cancel', 'POST', await c.req.json().catch(() => ({}))),
  )

  router.post('/local/cloud-billing/resume', async (c) =>
    forwardBilling(c, '/api/billing/resume', 'POST', await c.req.json().catch(() => ({}))),
  )

  return router
}
