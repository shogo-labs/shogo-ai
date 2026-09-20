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
  getUpstreamWorkspaceId,
} from '../lib/federated-upstream'
import { markCloudKeyRejected } from './local-auth'

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
      const response = await fetchUpstream('/api/billing/workspace-plan', {
        method: 'GET',
        search: `?workspaceId=${encodeURIComponent(workspace.id)}`,
      })
      const plan = await upstreamJson(response)
      if (response.status === 401) {
        markCloudKeyRejected('billing summary 401')
        return c.json({
          signedIn: true,
          cloudKeyRejected: true,
          workspace: workspace,
          ...cloudBillingUrls(workspace.id),
          plan,
        }, 401)
      }
      if (!response.ok) {
        return c.json({
          signedIn: true,
          workspace,
          ...cloudBillingUrls(workspace.id),
          error: plan,
        }, response.status as any)
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
      }, 502)
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
    if (response.status === 401) {
      markCloudKeyRejected('billing usage-based-pricing 401')
    }
    return c.json(result, response.status as any)
  })

  return router
}
