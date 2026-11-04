// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop publish routes (SHO-245).
 *
 * One service, two entry points — exactly like the cloud's publish stack:
 *
 *   - `/api/projects/:id/publish` (+ unpublish/republish/PATCH): the publish
 *     panel. Session-authenticated and project-scoped by `createApp`'s guards.
 *   - `/api/internal/projects/:id/publish`: the agent's `publish` tool, which
 *     calls back from the runtime with `x-runtime-token`.
 *
 * Both go through `services/local-publish.service.ts`, so the panel and the
 * agent can never disagree about what is live.
 *
 * Before this existed, `createLocalApp()` mounted no publish routes at all and
 * the agent's tool got a bare `HTTP 404`.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { prisma } from '../lib/prisma'
import { authenticateRuntimeToken } from './internal-runtime-auth'
import { getUpstreamCredential } from '../lib/federated-upstream'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import {
  localPublishProject,
  localPublishState,
  localRepublishProject,
  localUnpublishProject,
  localUpdatePublishSettings,
  type LocalPublishOptions,
} from '../services/local-publish.service'

/** Shape the panel and the agent's `getPublishState` both read. */
async function publishStateBody(projectId: string) {
  const state = await localPublishState(projectId)
  if (!state.ok) return state
  return {
    ok: true as const,
    published: !!state.subdomain,
    subdomain: state.subdomain ?? null,
    publishedAt: state.publishedAt ?? null,
    accessLevel: state.accessLevel ?? null,
    hasPassword: state.hasPassword,
    publishStatus: state.publishStatus ?? null,
    siteTitle: state.siteTitle,
    siteDescription: state.siteDescription,
    publishError: state.publishError,
    cloudConnected: state.cloudConnected,
    cloudHostProjectId: state.cloudHostProjectId,
    publishDomain: state.publishDomain,
  }
}

/**
 * The cloud owns subdomain uniqueness (the desktop's own rows only cover the
 * projects on this machine), so ask it — and fall back to the local rows when
 * the cloud can't be reached rather than claiming a name is free.
 */
async function checkSubdomain(subdomain: string): Promise<{ available: boolean; reason?: string }> {
  const cloudKey = await getUpstreamCredential()
  if (cloudKey) {
    try {
      const res = await fetch(
        `${getShogoCloudUrl().replace(/\/$/, '')}/api/subdomains/${encodeURIComponent(subdomain)}/check`,
        {
          headers: { authorization: `Bearer ${cloudKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      )
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { available?: boolean; reason?: string } | null
        if (body && typeof body.available === 'boolean') {
          return { available: body.available, ...(body.reason ? { reason: body.reason } : {}) }
        }
      }
    } catch {
      // Fall through to the local check.
    }
  }
  const taken = await prisma.project.findUnique({
    where: { publishedSubdomain: subdomain },
    select: { id: true },
  })
  return taken
    ? { available: false, reason: 'Subdomain is already in use' }
    : { available: true }
}

/**
 * Forward a custom-domain request to Shogo Cloud.
 *
 * On desktop the published site lives on a hidden host project in the cloud, and
 * that host project owns the domain rows — so the desktop's panel and the
 * agent's `publish` tool both proxy to the cloud's `/published-sites/.../domains`
 * routes with the stored cloud credential, exactly like publish itself. No
 * credential means the user isn't signed in to cloud, which surfaces as
 * `cloud_signin_required` so the UI can prompt.
 */
async function cloudDomainsRequest(
  sourceProjectId: string,
  method: string,
  subpath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const cloudKey = await getUpstreamCredential()
  if (!cloudKey) {
    return {
      status: 401,
      body: {
        error: {
          code: 'cloud_signin_required',
          message: 'Custom domains need a Shogo Cloud account. Sign in to Shogo Cloud in Settings, then try again.',
        },
      },
    }
  }

  const base = getShogoCloudUrl().replace(/\/$/, '')
  const url =
    `${base}/api/published-sites/${encodeURIComponent(sourceProjectId)}/domains` +
    (subpath ? `/${subpath.split('/').map(encodeURIComponent).join('/')}` : '')

  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${cloudKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const json = await res.json().catch(() => null)
    return {
      status: res.status,
      body: json ?? { error: { code: 'cloud_error', message: `Shogo Cloud returned HTTP ${res.status}` } },
    }
  } catch (err: any) {
    return {
      status: 502,
      body: {
        error: {
          code: 'cloud_unreachable',
          message: err?.message ?? 'Could not reach Shogo Cloud. Check your connection and try again.',
        },
      },
    }
  }
}

export function localPublishRoutes(): Hono {
  const router = new Hono()

  // ── Publish panel (session auth + project access, enforced by createApp) ──

  router.get('/subdomains/:subdomain/check', async (c) => {
    try {
      return c.json(await checkSubdomain(c.req.param('subdomain').toLowerCase()), 200)
    } catch (err: any) {
      return c.json({ error: { code: 'check_failed', message: err?.message ?? 'Check failed' } }, 500)
    }
  })

  router.get('/projects/:projectId/publish', async (c) => {
    const state = await publishStateBody(c.req.param('projectId'))
    if (!state.ok) {
      return c.json({ error: { code: state.code, message: state.message } }, state.status as any)
    }
    return c.json(state, 200)
  })

  router.post('/projects/:projectId/publish', async (c) => {
    let body: LocalPublishOptions
    try {
      body = await c.req.json<LocalPublishOptions>()
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid JSON body' } }, 400)
    }
    const result = await localPublishProject(c.req.param('projectId'), body ?? {})
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
    }
    return c.json(
      {
        url: result.url,
        subdomain: result.subdomain,
        publishedAt: result.publishedAt,
        accessLevel: result.accessLevel,
        hasPassword: result.hasPassword,
      },
      200,
    )
  })

  router.patch('/projects/:projectId/publish', async (c) => {
    let body: LocalPublishOptions
    try {
      body = await c.req.json<LocalPublishOptions>()
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid JSON body' } }, 400)
    }
    const result = await localUpdatePublishSettings(c.req.param('projectId'), body ?? {})
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
    }
    return c.json(
      {
        url: result.url,
        subdomain: result.subdomain,
        accessLevel: result.accessLevel,
        hasPassword: result.hasPassword,
      },
      200,
    )
  })

  router.post('/projects/:projectId/unpublish', async (c) => {
    const result = await localUnpublishProject(c.req.param('projectId'))
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
    }
    return c.json({ success: true }, 200)
  })

  router.post('/projects/:projectId/republish', async (c) => {
    const result = await localRepublishProject(c.req.param('projectId'))
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
    }
    return c.json(
      {
        url: result.url,
        subdomain: result.subdomain,
        publishedAt: result.publishedAt,
        accessLevel: result.accessLevel,
        hasPassword: result.hasPassword,
      },
      200,
    )
  })

  // ── Custom domains (panel) ───────────────────────────────────────────────
  // Proxied to the cloud host project, which owns the domain rows (SHO-304).

  router.get('/projects/:projectId/domains', async (c) => {
    const r = await cloudDomainsRequest(c.req.param('projectId'), 'GET', '')
    return c.json(r.body, r.status as any)
  })

  router.post('/projects/:projectId/domains', async (c) => {
    const body = await c.req.json().catch(() => null)
    const r = await cloudDomainsRequest(c.req.param('projectId'), 'POST', '', body ?? {})
    return c.json(r.body, r.status as any)
  })

  router.post('/projects/:projectId/domains/:domainId/verify', async (c) => {
    const r = await cloudDomainsRequest(
      c.req.param('projectId'), 'POST', `${c.req.param('domainId')}/verify`,
    )
    return c.json(r.body, r.status as any)
  })

  router.post('/projects/:projectId/domains/:domainId/retrigger', async (c) => {
    const r = await cloudDomainsRequest(
      c.req.param('projectId'), 'POST', `${c.req.param('domainId')}/retrigger`,
    )
    return c.json(r.body, r.status as any)
  })

  router.patch('/projects/:projectId/domains/:domainId/primary', async (c) => {
    const r = await cloudDomainsRequest(
      c.req.param('projectId'), 'PATCH', `${c.req.param('domainId')}/primary`,
    )
    return c.json(r.body, r.status as any)
  })

  router.delete('/projects/:projectId/domains/:domainId', async (c) => {
    const r = await cloudDomainsRequest(
      c.req.param('projectId'), 'DELETE', c.req.param('domainId'),
    )
    return c.json(r.body, r.status as any)
  })

  // ── Agent tool (runtime token) ───────────────────────────────────────────

  async function authorizeRuntime(c: Context, projectId: string): Promise<boolean> {
    return (await authenticateRuntimeToken(c, projectId)) !== null
  }

  router.get('/internal/projects/:projectId/publish', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeRuntime(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const state = await publishStateBody(projectId)
    if (!state.ok) {
      return c.json({ error: { code: state.code, message: state.message } }, state.status as any)
    }
    return c.json(state)
  })

  router.post('/internal/projects/:projectId/publish', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeRuntime(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

    let body: LocalPublishOptions
    try {
      body = (await c.req.json()) as LocalPublishOptions
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid JSON body' } }, 400)
    }
    if (!body?.subdomain || typeof body.subdomain !== 'string') {
      return c.json({ error: { code: 'subdomain_required', message: 'subdomain is required' } }, 400)
    }

    const result = await localPublishProject(projectId, body)
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
    })
  })

  // ── Custom domains (agent tool, runtime token) ───────────────────────────

  router.get('/internal/projects/:projectId/domains', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeRuntime(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const r = await cloudDomainsRequest(projectId, 'GET', '')
    return c.json(r.body, r.status as any)
  })

  router.post('/internal/projects/:projectId/domains', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeRuntime(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const body = await c.req.json().catch(() => null)
    const r = await cloudDomainsRequest(projectId, 'POST', '', body ?? {})
    return c.json(r.body, r.status as any)
  })

  router.post('/internal/projects/:projectId/domains/:domainId/verify', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeRuntime(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const r = await cloudDomainsRequest(projectId, 'POST', `${c.req.param('domainId')}/verify`)
    return c.json(r.body, r.status as any)
  })

  router.post('/internal/projects/:projectId/domains/:domainId/retrigger', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeRuntime(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const r = await cloudDomainsRequest(projectId, 'POST', `${c.req.param('domainId')}/retrigger`)
    return c.json(r.body, r.status as any)
  })

  router.patch('/internal/projects/:projectId/domains/:domainId/primary', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeRuntime(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const r = await cloudDomainsRequest(projectId, 'PATCH', `${c.req.param('domainId')}/primary`)
    return c.json(r.body, r.status as any)
  })

  router.delete('/internal/projects/:projectId/domains/:domainId', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeRuntime(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const r = await cloudDomainsRequest(projectId, 'DELETE', c.req.param('domainId'))
    return c.json(r.body, r.status as any)
  })

  return router
}

export default localPublishRoutes
