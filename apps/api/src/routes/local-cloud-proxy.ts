// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop as a live client of cloud team workspaces (like Slack desktop).
 *
 *   GET  /api/local/cloud-workspaces       — which cloud workspaces this
 *                                             desktop can open, and as whom
 *   POST /api/local/cloud-workspaces/sync  — pick up newly joined ones now
 *   ALL  /api/cloud/:workspaceId/<path>    — relayed to cloud `/api/<path>`
 *                                             with that workspace's key,
 *                                             streaming bodies untouched
 *
 * Cloud workspaces are also appended to `GET /api/workspaces` so they show in
 * the switcher, and `GET /api/workspaces/:id` for one is answered from cloud.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { copyResponseHeaders, forwardToUpstream } from '../lib/federated-upstream'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import {
  cloudWorkspaceKey,
  listCloudWorkspaces,
  markCloudReachable,
  syncCloudWorkspaces,
} from '../services/cloud-workspaces'

const PREFIX = '/api/cloud/'

function cloudRow(w: { id: string; name: string; slug: string | null }) {
  const now = Date.now()
  return { id: w.id, name: w.name, slug: w.slug ?? w.id, kind: 'team', source: 'cloud', createdAt: now, updatedAt: now }
}

async function relay(c: Context, workspaceId: string, upstreamPath: string): Promise<Response> {
  const key = await cloudWorkspaceKey(workspaceId)
  if (!key) {
    const signedIn = !!process.env.SHOGO_API_KEY
    return c.json(
      signedIn
        ? { error: { code: 'unknown_cloud_workspace', message: 'This desktop is not signed in to that cloud workspace' } }
        : { error: { code: 'cloud_signed_out', message: 'Sign in to Shogo Cloud to open this workspace' } },
      signedIn ? 404 : 401,
    )
  }
  let resp: Response
  try {
    resp = await forwardToUpstream(c, { path: upstreamPath, apiKey: key, signal: c.req.raw.signal })
  } catch (err: any) {
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 })
    markCloudReachable(false)
    return c.json({ error: { code: 'cloud_unreachable', message: `Can't reach Shogo Cloud: ${err?.message ?? err}` } }, 502)
  }
  markCloudReachable(true)
  if (resp.status === 401 || resp.status === 403) void syncCloudWorkspaces()
  const headers = new Headers(copyResponseHeaders(resp))
  // Cloud's session cookies would land on the desktop origin and clobber the
  // local session.
  headers.delete('set-cookie')
  return new Response(resp.body, { status: resp.status, headers })
}

/** Appends cloud workspaces to the local workspace list. */
export const cloudWorkspaceListMiddleware: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.req.method !== 'GET' || c.res.status !== 200) return
  const { workspaces } = await listCloudWorkspaces()
  if (!workspaces.length) return
  const body = await c.res.clone().json().catch(() => null)
  if (!body || !Array.isArray(body.items)) return
  const known = new Set(body.items.map((w: any) => w.id))
  const extra = workspaces.filter((w) => !known.has(w.id)).map(cloudRow)
  const headers = new Headers(c.res.headers)
  headers.delete('content-length')
  c.res = new Response(JSON.stringify({ ...body, items: [...body.items, ...extra], total: (body.total ?? body.items.length) + extra.length }), {
    status: 200,
    headers,
  })
}

export function localCloudWorkspaceRoutes(opts: { resolveUserId: (c: Context) => Promise<string | null> }): Hono {
  const router = new Hono()

  const requireUser: MiddlewareHandler = async (c, next) => {
    if (!(await opts.resolveUserId(c))) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    return next()
  }
  router.use('/local/cloud-workspaces', requireUser)
  router.use('/local/cloud-workspaces/*', requireUser)
  router.use('/cloud/*', requireUser)

  router.get('/local/cloud-workspaces', async (c) => {
    const { user, workspaces, reachable } = await listCloudWorkspaces()
    return c.json({
      signedIn: !!process.env.SHOGO_API_KEY,
      cloudUrl: getShogoCloudUrl(),
      reachable,
      user,
      workspaces: workspaces.map(({ id, name, slug }) => ({ id, name, slug })),
    })
  })

  router.post('/local/cloud-workspaces/sync', async (c) => {
    await syncCloudWorkspaces()
    const { workspaces, reachable } = await listCloudWorkspaces()
    return c.json({ reachable, workspaces: workspaces.map(({ id, name, slug }) => ({ id, name, slug })) })
  })

  router.get('/workspaces/:id', async (c, next) => {
    const id = c.req.param('id')
    if (!(await cloudWorkspaceKey(id))) return next()
    if (!(await opts.resolveUserId(c))) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    return relay(c, id, `/api/workspaces/${id}`)
  })

  router.all('/cloud/:workspaceId/*', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const rest = c.req.path.slice(PREFIX.length + workspaceId.length)
    if (!rest.startsWith('/')) return c.json({ error: { code: 'bad_path', message: 'Missing path' } }, 400)
    return relay(c, workspaceId, `/api${rest}`)
  })

  return router
}
