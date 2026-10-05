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

export type IdentityMap = Map<string, string>

/**
 * The desktop UI knows the user by their local account everywhere
 * (`useAuth().user`); cloud knows them by their cloud account. Requests swap
 * local → cloud (id and email); replies, events and socket frames swap the
 * cloud id back so the UI only ever sees one id for "me". Emails aren't
 * swapped back: the local one is often a placeholder.
 */
export interface Identity {
  toCloud: IdentityMap
  toLocal: IdentityMap
}

export const NO_IDENTITY: Identity = { toCloud: new Map(), toLocal: new Map() }

export async function cloudIdentity(localUser: { id: string; email: string | null } | null): Promise<Identity> {
  const cloud = await cloudWorkspaceUser()
  if (!cloud || !localUser) return NO_IDENTITY
  const toCloud: IdentityMap = new Map()
  const toLocal: IdentityMap = new Map()
  if (localUser.id !== cloud.id) {
    toCloud.set(localUser.id, cloud.id)
    toLocal.set(cloud.id, localUser.id)
  }
  if (localUser.email && cloud.email && localUser.email.toLowerCase() !== cloud.email.toLowerCase()) {
    toCloud.set(localUser.email, cloud.email)
    toCloud.set(localUser.email.toLowerCase(), cloud.email)
  }
  return { toCloud, toLocal }
}

function translate(value: unknown, map: IdentityMap): unknown {
  if (typeof value === 'string') return map.get(value) ?? value
  if (Array.isArray(value)) return value.map((v) => translate(v, map))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [map.get(k) ?? k, translate(v, map)]))
  }
  return value
}

function mentions(text: string, map: IdentityMap): boolean {
  for (const k of map.keys()) if (text.includes(k)) return true
  return false
}

/** Swaps ids inside a JSON text; anything that isn't JSON passes through. */
export function translateJsonText(text: string, map: IdentityMap): string {
  if (map.size === 0 || !mentions(text, map)) return text
  try {
    return JSON.stringify(translate(JSON.parse(text), map))
  } catch {
    return text
  }
}

/** Swaps ids in each `data:` line of a server-sent event stream. */
function translateEventStream(body: ReadableStream<Uint8Array>, map: IdentityMap): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ''
  const line = (l: string) => {
    const m = /^data: ?(.*)$/.exec(l)
    return m ? `data: ${translateJsonText(m[1]!, map)}` : l
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        if (lines.length) controller.enqueue(encoder.encode(lines.map(line).join('\n') + '\n'))
      },
      flush(controller) {
        buffered += decoder.decode()
        if (buffered) controller.enqueue(encoder.encode(line(buffered)))
      },
    }),
  )
}

async function translateResponseBody(resp: Response, map: IdentityMap): Promise<BodyInit | null> {
  if (map.size === 0 || !resp.body) return resp.body
  const type = resp.headers.get('content-type') ?? ''
  if (type.includes('text/event-stream')) return translateEventStream(resp.body, map)
  if (type.includes('application/json')) return translateJsonText(await resp.text(), map)
  return resp.body
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

async function relay(c: Context, workspaceId: string, upstreamPath: string, identity: Identity = NO_IDENTITY): Promise<Response> {
  const key = await cloudWorkspaceKey(workspaceId)
  if (!key) return noKey(c)
  let resp: Response
  try {
    const { path, search, body } = await translateRequest(c, upstreamPath, identity.toCloud)
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
  return new Response(await translateResponseBody(resp, identity.toLocal), { status: resp.status, headers })
}

export interface CloudSocketRelayData {
  kind: 'cloud-rt-relay'
  url: string
  key: string
  identity?: Identity
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
        ws.send(typeof ev.data === 'string' ? translateJsonText(ev.data, data.identity?.toLocal ?? NO_IDENTITY.toLocal) : ev.data)
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
  message(ws: any, raw: string | BufferSource) {
    const data = ws.data as CloudSocketRelayData
    const message = typeof raw === 'string' ? translateJsonText(raw, data.identity?.toCloud ?? NO_IDENTITY.toCloud) : raw
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
 * Appends cloud workspaces to the local workspace list: local ones first,
 * then cloud (cloud Personal first among those). Local workspaces, Personal
 * included, stay listed while signed in.
 */
export const cloudWorkspaceListMiddleware: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.req.method !== 'GET' || c.res.status !== 200) return
  const { workspaces } = await listCloudWorkspaces()
  if (!workspaces.length) return
  const body = await c.res.clone().json().catch(() => null)
  if (!body || !Array.isArray(body.items)) return
  const local = body.items
  const known = new Set(local.map((w: any) => w.id))
  const extra = workspaces.filter((w) => !known.has(w.id)).map(cloudRow)
  const items = [
    ...local,
    ...extra.filter((w) => w.kind === 'personal'),
    ...extra.filter((w) => w.kind !== 'personal'),
  ]
  const headers = new Headers(c.res.headers)
  headers.delete('content-length')
  const total = (body.total ?? body.items.length) + extra.length
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

  const identityFor = async (c: Context): Promise<Identity> => {
    const id = await opts.resolveUserId(c)
    if (!id) return NO_IDENTITY
    const email = (await opts.resolveUserEmail?.(id).catch(() => null)) ?? null
    return cloudIdentity({ id, email })
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
    return relay(c, id, `/api/workspaces/${id}`, await identityFor(c))
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
    const data: CloudSocketRelayData = { kind: 'cloud-rt-relay', url, key, identity: await identityFor(c) }
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
