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

  /**
   * POST /api/internal/projects/:projectId/publish/ops — the `ops_action` half
   * of the agent's `publish` tool (SHO-308 §5).
   *
   * Desktop publishing has no Knative substrate: the site is built and hosted
   * by Shogo Cloud, and there is exactly one copy of it. So `status`/`list`
   * answer from the local publish row (same fields the publish panel reads) and
   * every action that would need revisions, replicas, environments, logs,
   * metrics or cost says `cloud_only` instead of 404ing — the agent gets a
   * reason it can act on rather than a bare "route not found".
   */
  router.post('/internal/projects/:projectId/publish/ops', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeRuntime(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

    let body: { action?: string; environment?: string }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid JSON body' } }, 400)
    }

    const action = String(body?.action ?? '').trim()
    const environment = body?.environment === 'staging' ? 'staging' : 'production'

    // Reporting production's state to a caller that asked about staging would
    // be a lie, so the environment check comes before the action.
    if (environment === 'staging') {
      return c.json(
        {
          error: {
            code: 'cloud_only',
            message:
              'Staging environments run on the Knative substrate, which this desktop app does not have. Nothing was changed.',
          },
        },
        409,
      )
    }

    if (action === 'status' || action === 'list') {
      const state = await publishStateBody(projectId)
      if (!state.ok) {
        return c.json({ error: { code: state.code, message: state.message } }, state.status as any)
      }
      const subdomain = state.subdomain ?? null
      const env = {
        name: 'production' as const,
        subdomain,
        url: subdomain ? `https://${subdomain}.${state.publishDomain}` : null,
        publishStatus: state.publishStatus ?? null,
        publishError: state.publishError ?? null,
        publishedAt: state.publishedAt ?? null,
      }
      return c.json({
        ok: true,
        substrate: 'local',
        // One replica by definition: Cloud builds and serves the single copy.
        environment: env,
        environments: [env],
        replicas: { ready: subdomain ? 1 : 0, total: subdomain ? 1 : 0, desired: subdomain ? 1 : null },
        revision: null,
        pods: [],
        currentDeployment: null,
      })
    }

    return c.json(
      {
        error: {
          code: 'cloud_only',
          message: `\`${action || 'this action'}\` acts on the published hosting (replicas, revisions, environments, logs, metrics, cost). This app is published from Shogo Desktop, which serves one copy built by Shogo Cloud, so there is nothing here to ${
            action === 'scale' || action === 'rollback' || action === 'redeploy' || action === 'promote'
              ? 'change'
              : 'read'
          }. Nothing was changed. To scale it, roll it back, tail its logs or see per-environment cost, sync the project to Shogo Cloud and use the Deployment tab there.`,
        },
      },
      409,
    )
  })

  return router
}

export default localPublishRoutes
