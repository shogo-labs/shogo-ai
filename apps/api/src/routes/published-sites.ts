// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud half of desktop publishing (SHO-245): accept a bundle the user's
 * machine built and host it on `{subdomain}.shogo.one`.
 *
 * Authenticated by API key only — this is machine-to-machine, from the
 * desktop's API to ours. The key decides the workspace, so a key for workspace
 * A can never touch a host project in workspace B (see
 * `services/published-sites.service.ts`).
 *
 *   POST /api/published-sites/:sourceProjectId            publish / republish
 *   POST /api/published-sites/:sourceProjectId/unpublish  take it down
 *   GET  /api/published-sites/:sourceProjectId            current state
 *
 * The desktop calls these from `services/local-publish.service.ts`; the agent
 * never sees them (it calls the desktop's own publish route as usual).
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { resolveApiKeyForRequest } from '../lib/api-key-request'
import {
  getUploadedSiteState,
  publishUploadedSite,
  resolveHostProject,
  unpublishUploadedSite,
  updateUploadedSiteSettings,
  type UploadedSiteUpload,
} from '../services/published-sites.service'

function bearerKey(c: Context): string | null {
  const header = c.req.header('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/** Resolve the API key's workspace, or a 401 the desktop can turn into a sign-in prompt. */
async function authenticate(c: Context): Promise<{ workspaceId: string; userId: string } | Response> {
  const key = bearerKey(c)
  if (!key) {
    return c.json(
      { error: { code: 'cloud_signin_required', message: 'Sign in to Shogo Cloud to publish.' } },
      401,
    )
  }
  const resolved = await resolveApiKeyForRequest(c, key)
  if (!resolved) {
    return c.json(
      { error: { code: 'cloud_signin_required', message: 'This Shogo Cloud key is not valid. Sign in again to publish.' } },
      401,
    )
  }
  return { workspaceId: resolved.workspaceId, userId: resolved.userId }
}

/**
 * Resolve the hidden host project that owns this desktop project's published
 * site, or a JSON error response the desktop can relay as-is.
 *
 * Custom domains live on the host project (there are no domain rows on the
 * desktop's own project), so every domain route goes through here first —
 * which also means an unpublished desktop project gets `not_published`.
 */
async function resolveHost(
  c: Context,
  workspaceId: string,
  sourceProjectId: string,
): Promise<{ ok: true; hostProjectId: string } | { ok: false; response: Response }> {
  const resolved = await resolveHostProject(workspaceId, sourceProjectId, { create: false })
  if (!resolved.ok) {
    return {
      ok: false,
      response: c.json({ error: { code: resolved.code, message: resolved.message } }, resolved.status as any),
    }
  }
  return { ok: true, hostProjectId: resolved.project.id }
}

export function publishedSitesRoutes() {
  const router = new Hono()

  router.post('/published-sites/:sourceProjectId', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth

    let body: UploadedSiteUpload
    try {
      body = (await c.req.json()) as UploadedSiteUpload
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid JSON body' } }, 400)
    }

    const result = await publishUploadedSite({
      workspaceId: auth.workspaceId,
      sourceProjectId: c.req.param('sourceProjectId'),
      upload: body,
    })
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
    }
    return c.json({
      ok: true,
      url: result.url,
      subdomain: result.subdomain,
      publishedAt: result.publishedAt,
      accessLevel: result.accessLevel,
      hasPassword: result.hasPassword,
      hostProjectId: result.hostProjectId,
    })
  })

  router.patch('/published-sites/:sourceProjectId', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth

    let body: UploadedSiteUpload
    try {
      body = (await c.req.json()) as UploadedSiteUpload
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid JSON body' } }, 400)
    }

    const result = await updateUploadedSiteSettings({
      workspaceId: auth.workspaceId,
      sourceProjectId: c.req.param('sourceProjectId'),
      settings: {
        accessLevel: body.accessLevel,
        password: body.password,
        siteTitle: body.siteTitle,
        siteDescription: body.siteDescription,
      },
    })
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
    }
    return c.json({
      ok: true,
      subdomain: result.subdomain,
      accessLevel: result.accessLevel,
      hasPassword: result.hasPassword,
      siteTitle: result.siteTitle,
      siteDescription: result.siteDescription,
    })
  })

  router.post('/published-sites/:sourceProjectId/unpublish', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth

    const result = await unpublishUploadedSite({
      workspaceId: auth.workspaceId,
      sourceProjectId: c.req.param('sourceProjectId'),
    })
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
    }
    return c.json({ ok: true, success: true, hostProjectId: result.hostProjectId })
  })

  router.get('/published-sites/:sourceProjectId', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth

    const state = await getUploadedSiteState({
      workspaceId: auth.workspaceId,
      sourceProjectId: c.req.param('sourceProjectId'),
    })
    return c.json(state)
  })

  // ── Custom domains (SHO-304) ─────────────────────────────────────────────
  //
  // A desktop project's published site is hosted on a hidden host project in
  // the cloud, and custom domains belong to that host project. These resolve it
  // first, then reuse the exact handlers the cloud panel's own domain routes
  // call, so desktop and cloud never diverge.

  router.get('/published-sites/:sourceProjectId/domains', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const host = await resolveHost(c, auth.workspaceId, c.req.param('sourceProjectId'))
    if (!host.ok) return host.response

    const { listCustomDomains } = await import('./publish')
    const result = await listCustomDomains(host.hostProjectId)
    return c.json(result.body, result.status as any)
  })

  router.post('/published-sites/:sourceProjectId/domains', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const host = await resolveHost(c, auth.workspaceId, c.req.param('sourceProjectId'))
    if (!host.ok) return host.response

    let body: { hostname?: string }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid JSON body' } }, 400)
    }

    const { addCustomDomain } = await import('./publish')
    const result = await addCustomDomain(host.hostProjectId, typeof body?.hostname === 'string' ? body.hostname : '')
    return c.json(result.body, result.status as any)
  })

  router.post('/published-sites/:sourceProjectId/domains/:domainId/verify', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const host = await resolveHost(c, auth.workspaceId, c.req.param('sourceProjectId'))
    if (!host.ok) return host.response

    const { verifyCustomDomain } = await import('./publish')
    const result = await verifyCustomDomain(host.hostProjectId, c.req.param('domainId'))
    return c.json(result.body, result.status as any)
  })

  router.post('/published-sites/:sourceProjectId/domains/:domainId/retrigger', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const host = await resolveHost(c, auth.workspaceId, c.req.param('sourceProjectId'))
    if (!host.ok) return host.response

    const { retriggerCustomDomain } = await import('./publish')
    const result = await retriggerCustomDomain(host.hostProjectId, c.req.param('domainId'))
    return c.json(result.body, result.status as any)
  })

  router.patch('/published-sites/:sourceProjectId/domains/:domainId/primary', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const host = await resolveHost(c, auth.workspaceId, c.req.param('sourceProjectId'))
    if (!host.ok) return host.response

    const { setPrimaryCustomDomain } = await import('./publish')
    const result = await setPrimaryCustomDomain(host.hostProjectId, c.req.param('domainId'))
    return c.json(result.body, result.status as any)
  })

  router.delete('/published-sites/:sourceProjectId/domains/:domainId', async (c) => {
    const auth = await authenticate(c)
    if (auth instanceof Response) return auth
    const host = await resolveHost(c, auth.workspaceId, c.req.param('sourceProjectId'))
    if (!host.ok) return host.response

    const { deleteCustomDomain } = await import('./publish')
    const result = await deleteCustomDomain(host.hostProjectId, c.req.param('domainId'))
    return c.json(result.body, result.status as any)
  })

  return router
}

export default publishedSitesRoutes
