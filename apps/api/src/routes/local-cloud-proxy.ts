// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop as a live client of the user's cloud workspaces (like Slack
 * desktop): their team workspaces, and their cloud Personal workspace in
 * place of the local one so desktop and mobile share it.
 *
 *   GET  /api/local/cloud-workspaces       — which cloud workspaces this
 *                                             desktop can open, and as whom
 *   POST /api/local/cloud-workspaces/sync  — pick up newly joined ones now
 *   ALL  /api/cloud/:workspaceId/<path>    — relayed to cloud `/api/<path>`
 *                                             with that workspace's key,
 *                                             streaming bodies untouched
 *
 * Cloud workspaces are also merged into `GET /api/workspaces` so they show in
 * the switcher, and `GET /api/workspaces/:id` for one is answered from cloud.
 * `/api/cloud/:workspaceId/workspaces/:workspaceId/rt` is relayed as a
 * WebSocket (typing, presence, live events).
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { copyResponseHeaders, forwardToUpstream } from '../lib/federated-upstream'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import {
  cloudWorkspaceKey,
  cloudWorkspaceUser,
  listCloudWorkspaces,
  markCloudReachable,
  syncCloudWorkspaces,
} from '../services/cloud-workspaces'

const PREFIX = '/api/cloud/'

function cloudRow(w: { id: string; name: string; slug: string | null; kind: 'personal' | 'team' }) {
  const now = Date.now()
  return { id: w.id, name: w.name, slug: w.slug ?? w.id, kind: w.kind, source: 'cloud', createdAt: now, updatedAt: now }
}

const publicEntry = ({ id, name, slug, kind }: { id: string; name: string; slug: string | null; kind: string }) => ({ id, name, slug, kind })

function noKey(c: Context): Response {
  const signedIn = !!process.env.SHOGO_API_KEY
  return c.json(
    signedIn
      ? { error: { code: 'unknown_cloud_workspace', message: 'This desktop is not signed in to that cloud workspace' } }
      : { error: { code: 'cloud_signed_out', message: 'Sign in to Shogo Cloud to open this workspace' } },
    signedIn ? 404 : 401,
  )
}

/** Local user id/email → the cloud account's, for values the UI sends. */
export type IdentityMap = Map<string, string>

export async function cloudIdentityMap(localUser: { id: string; email: string | null } | null): Promise<IdentityMap> {
  const map: IdentityMap = new Map()
  const cloud = await cloudWorkspaceUser()
  if (!cloud || !localUser) return map
  if (localUser.id !== cloud.id) map.set(localUser.id, cloud.id)
  if (localUser.email && cloud.email && localUser.email.toLowerCase() !== cloud.email.toLowerCase()) {
    map.set(localUser.email, cloud.email)
    map.set(localUser.email.toLowerCase(), cloud.email)
  }
  return map
}

function translate(value: unknown, map: IdentityMap): unknown {
  if (typeof value === 'string') return map.get(value) ?? value
  if (Array.isArray(value)) return value.map((v) => translate(v, map))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, translate(v, map)]))
  }
  return value
}

/**
 * Screens send `useAuth().user` (the local account) as filters and owners;
 * cloud only knows the cloud account, so swap exact matches in the path,
 * querystring and JSON body.
 */
export async function translateRequest(
  c: Context,
  upstreamPath: string,
  map: IdentityMap,
): Promise<{ path: string; search: string; body?: BodyInit }> {
  const url = new URL(c.req.url)
  if (map.size === 0) return { path: upstreamPath, search: url.search }
  const path = upstreamPath
    .split('/')
    .map((seg) => {
      const decoded = (() => { try { return decodeURIComponent(seg) } catch { return seg } })()
      const hit = map.get(decoded)
      return hit ? encodeURIComponent(hit) : seg
    })
    .join('/')
  const params = new URLSearchParams(url.search)
  let changed = false
  for (const [k, v] of [...params]) {
    const hit = map.get(v)
    if (hit) { params.set(k, hit); changed = true }
  }
  const search = changed ? `?${params}` : url.search
  let body: BodyInit | undefined
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('content-type')?.includes('application/json')) {
    const text = await c.req.raw.text()
    try {
      body = JSON.stringify(translate(JSON.parse(text), map))
    } catch {
      body = text
    }
  }
  return { path, search, body }
}

async function relay(c: Context, workspaceId: string, upstreamPath: string, map: IdentityMap = new Map()): Promise<Response> {
  const key = await cloudWorkspaceKey(workspaceId)
  if (!key) return noKey(c)
  let resp: Response
  try {
    const { path, search, body } = await translateRequest(c, upstreamPath, map)
    resp = await forwardToUpstream(c, { path, search, body, apiKey: key, signal: c.req.raw.signal })
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

export interface CloudSocketRelayData {
  kind: 'cloud-rt-relay'
  url: string
  key: string
  upstream?: WebSocket
  pending?: Array<string | BufferSource>
  closed?: boolean
}

export function isCloudSocketRelayData(data: unknown): data is CloudSocketRelayData {
  return !!data && typeof data === 'object' && (data as any).kind === 'cloud-rt-relay'
}

/** Close codes a server may send on; anything else becomes 1011. */
function relayCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code < 5000) ? code : 1011
}

/**
 * Pipes a desktop client's team chat socket to the cloud's, authenticated
 * with the workspace's key. Frames sent before cloud answers are queued.
 */
export const cloudSocketRelayHandlers = {
  open(ws: any) {
    const data = ws.data as CloudSocketRelayData
    data.pending = []
    let upstream: WebSocket
    try {
      upstream = new WebSocket(data.url, { headers: { Authorization: `Bearer ${data.key}` } } as any)
    } catch {
      ws.close(1011, 'cloud_unreachable')
      return
    }
    data.upstream = upstream
    upstream.onopen = () => {
      markCloudReachable(true)
      for (const frame of data.pending ?? []) upstream.send(frame)
      data.pending = []
    }
    upstream.onmessage = (ev) => {
      try {
        ws.send(ev.data)
      } catch {
        // Client closing; its close handler tears the upstream down.
      }
    }
    upstream.onclose = (ev) => {
      if (data.closed) return
      data.closed = true
      try {
        ws.close(relayCloseCode(ev.code), ev.reason)
      } catch {}
    }
  },
  message(ws: any, message: string | BufferSource) {
    const data = ws.data as CloudSocketRelayData
    if (data.upstream?.readyState === WebSocket.OPEN) data.upstream.send(message)
    else data.pending?.push(message)
  },
  close(ws: any) {
    const data = ws.data as CloudSocketRelayData
    data.closed = true
    try {
      data.upstream?.close()
    } catch {}
  },
}

/**
 * Merges cloud workspaces into the local workspace list. A cloud Personal
 * workspace replaces the local one while signed in; the local one (and its
 * data) is back after sign-out.
 */
export const cloudWorkspaceListMiddleware: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.req.method !== 'GET' || c.res.status !== 200) return
  const { workspaces } = await listCloudWorkspaces()
  if (!workspaces.length) return
  const body = await c.res.clone().json().catch(() => null)
  if (!body || !Array.isArray(body.items)) return
  const hasCloudPersonal = workspaces.some((w) => w.kind === 'personal')
  const local = hasCloudPersonal ? body.items.filter((w: any) => w.kind !== 'personal') : body.items
  const known = new Set(local.map((w: any) => w.id))
  const extra = workspaces.filter((w) => !known.has(w.id)).map(cloudRow)
  const personal = extra.filter((w) => w.kind === 'personal')
  const items = [...personal, ...local, ...extra.filter((w) => w.kind !== 'personal')]
  const headers = new Headers(c.res.headers)
  headers.delete('content-length')
  const total = (body.total ?? body.items.length) - (body.items.length - local.length) + extra.length
  c.res = new Response(JSON.stringify({ ...body, items, total }), {
    status: 200,
    headers,
  })
}

export function localCloudWorkspaceRoutes(opts: {
  resolveUserId: (c: Context) => Promise<string | null>
  resolveUserEmail?: (userId: string) => Promise<string | null>
}): Hono {
  const router = new Hono()

  const identityFor = async (c: Context): Promise<IdentityMap> => {
    const id = await opts.resolveUserId(c)
    if (!id) return new Map()
    const email = (await opts.resolveUserEmail?.(id).catch(() => null)) ?? null
    return cloudIdentityMap({ id, email })
  }

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
      workspaces: workspaces.map(publicEntry),
    })
  })

  router.post('/local/cloud-workspaces/sync', async (c) => {
    await syncCloudWorkspaces()
    const { workspaces, reachable } = await listCloudWorkspaces()
    return c.json({ reachable, workspaces: workspaces.map(publicEntry) })
  })

  router.get('/workspaces/:id', async (c, next) => {
    const id = c.req.param('id')
    if (!(await cloudWorkspaceKey(id))) return next()
    if (!(await opts.resolveUserId(c))) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    return relay(c, id, `/api/workspaces/${id}`)
  })

  router.get('/cloud/:workspaceId/workspaces/:inner/rt', async (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return next()
    const workspaceId = c.req.param('workspaceId')
    if (c.req.param('inner') !== workspaceId) {
      return c.json({ error: { code: 'bad_path', message: 'Workspace mismatch' } }, 400)
    }
    const key = await cloudWorkspaceKey(workspaceId)
    if (!key) return noKey(c)
    const server = c.env as any
    if (!server?.upgrade) return c.json({ error: { code: 'upgrade_required', message: 'WebSocket upgrade required' } }, 426)
    const url = `${getShogoCloudUrl().replace(/^http/, 'ws')}/api/workspaces/${encodeURIComponent(workspaceId)}/rt`
    const data: CloudSocketRelayData = { kind: 'cloud-rt-relay', url, key }
    if (server.upgrade(c.req.raw, { data })) return new Response(null)
    return c.json({ error: { code: 'upgrade_failed', message: 'WebSocket upgrade failed' } }, 500)
  })

  router.all('/cloud/:workspaceId/*', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const rest = c.req.path.slice(PREFIX.length + workspaceId.length)
    if (!rest.startsWith('/')) return c.json({ error: { code: 'bad_path', message: 'Missing path' } }, 400)
    return relay(c, workspaceId, `/api${rest}`, await identityFor(c))
  })

  return router
}
