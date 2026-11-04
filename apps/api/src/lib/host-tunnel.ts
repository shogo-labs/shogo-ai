// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The host-tunnel runtime (SHO-285): a workspace hosted on a paired desktop
 * runs its agent there, and the cloud reaches it the way it reaches a metal
 * runtime — through a URL.
 *
 * `resolveWorkspaceRuntimeUrl` answers a hosted workspace with
 * `http://127.0.0.1:<api port>/api/internal/host-tunnel/<secret>/<instance>/<base>`
 * where `<base>` is the desktop's own agent proxy for that runtime
 * (`/api/projects/<id>/agent-proxy` or `/api/workspaces/<id>/agent-proxy`).
 * Every caller that already does `fetch(`${url}/agent/chat`)` — project chat,
 * workspace chat, files, terminal, previews, agent calls — reaches the desktop
 * runtime without knowing it is one: the route below carries the request over
 * the existing instance tunnel (`sendTunnelRequest` / `sendTunnelStreamRequest`,
 * cross-pod via Redis) and the desktop's agent proxy hands it to its runtime.
 *
 * The URL is loopback-only and carries a per-process secret, so nothing outside
 * this API process can use it, and it only names instances that host something.
 * Both halves are enforced by the route rather than assumed: a request that did
 * not arrive over loopback (or that an ingress stamped a client IP on) gets the
 * plain 404 an unknown internal route gives, and the instance named in the path
 * may only reach a workspace it actually hosts. The URL is never handed to a
 * client — see `clientRuntimeUrl` — so the secret stays inside this process.
 */

import type { Context } from 'hono'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from './prisma'
import { hostedWorkspacesResolveHere } from './cloud-topology'

export const HOST_TUNNEL_PREFIX = '/api/internal/host-tunnel'

const SECRET = process.env.SHOGO_HOST_TUNNEL_SECRET || randomBytes(24).toString('hex')

/** How long a request waits for a sleeping desktop's tunnel before `host_offline`. */
const WAKE_DEADLINE_MS = Math.max(0, Number(process.env.SHOGO_HOST_WAKE_DEADLINE_MS ?? 5_000) || 0)

/** The workspace's host, cached briefly: every runtime resolve asks. */
const HOST_TTL_MS = 10_000
const hostCache = new Map<string, { hostInstanceId: string | null; at: number }>()

export async function hostOfWorkspace(workspaceId: string): Promise<string | null> {
  // Only a cloud runtime topology can host a workspace (see
  // `hostedWorkspacesResolveHere`): the desktop's own API and a unit-test
  // process have no cluster and no app database, and must not pay a database
  // read on every runtime resolve.
  if (!hostedWorkspacesResolveHere()) return null
  const cached = hostCache.get(workspaceId)
  if (cached && Date.now() - cached.at < HOST_TTL_MS) return cached.hostInstanceId
  let hostInstanceId: string | null
  try {
    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { hostInstanceId: true },
    })
    hostInstanceId = row?.hostInstanceId ?? null
  } catch {
    // Every runtime resolve asks this, and the answer is only an optimisation
    // of *where* to run. A lookup that cannot be answered means "no host I know
    // of", which is the same path a workspace with no host takes — never a
    // failed resolve. Left uncached so the next resolve asks again.
    return null
  }
  hostCache.set(workspaceId, { hostInstanceId, at: Date.now() })
  return hostInstanceId
}

export function _resetHostCacheForTests(): void {
  hostCache.clear()
}

function apiPort(): string {
  return process.env.API_PORT || process.env.PORT || '8002'
}

/** The runtime URL for a hosted workspace's runtime. */
export function hostTunnelRuntimeUrl(
  instanceId: string,
  target: { anchorProjectId?: string; workspaceId: string },
): string {
  const base = target.anchorProjectId
    ? `/api/projects/${encodeURIComponent(target.anchorProjectId)}/agent-proxy`
    : `/api/workspaces/${encodeURIComponent(target.workspaceId)}/agent-proxy`
  return `http://127.0.0.1:${apiPort()}${HOST_TUNNEL_PREFIX}/${SECRET}/${encodeURIComponent(instanceId)}${base}`
}

/**
 * The runtime URL to hand a client, or `null` when there is none it may have.
 * A hosted workspace's runtime URL is this process's own loopback address plus
 * the tunnel secret, so it only ever travels between functions in this API —
 * routes that answer a browser or the mobile app ask this and report `mode`
 * instead (`host-tunnel`), letting the client use the ordinary agent proxy.
 */
export function clientRuntimeUrl(resolved: { mode: string; url?: string | null }): string | null {
  return resolved.mode === 'host-tunnel' ? null : resolved.url ?? null
}

export class HostOfflineError extends Error {
  readonly code = 'host_offline'
  constructor(readonly instanceId: string, readonly hostName: string | null) {
    super(`${hostName || 'The desktop hosting this workspace'} is offline`)
    this.name = 'HostOfflineError'
  }
}

const STREAMING_SUFFIXES = ['/agent/chat', '/agent/quick-actions', '/agent/logs/stream']

function isStreaming(method: string, path: string, accept: string | undefined): boolean {
  if (accept?.includes('text/event-stream')) return true
  const clean = path.split('?')[0]
  if (clean.endsWith('/agent/logs/stream')) return method === 'GET'
  return method === 'POST' && STREAMING_SUFFIXES.some((suffix) => clean.endsWith(suffix))
}

// `x-billing-user-id` is deliberately not forwarded: the only user a hosted
// workspace may bill is the desktop's owner, which this handler knows, so the
// caller does not get to name it.
const FORWARD_HEADERS = ['content-type', 'accept', 'x-chat-session-id', 'last-event-id']
const DROP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection', 'set-cookie', 'content-length', 'content-encoding'])

/** The only paths a tunnel request may carry: a runtime's own agent proxy. */
const TUNNEL_TARGET_PATH = /^\/api\/(projects|workspaces)\/([^/]+)\/agent-proxy(\/.*)?$/

/** The desktop-tools call a paired machine makes against its own Personal. */
const DEVICE_TOOLS_SUFFIX = '/agent/remote/tool'

export interface TunnelTarget {
  kind: 'project' | 'workspace'
  id: string
  /** Whatever the request asks of that proxy (`/agent/chat`, …). */
  rest: string
}

/** `null` for any path that is not a runtime agent proxy — never forwarded. */
export function parseTunnelTarget(base: string): TunnelTarget | null {
  const m = TUNNEL_TARGET_PATH.exec(base.split('?')[0])
  if (!m) return null
  try {
    return {
      kind: m[1] === 'projects' ? 'project' : 'workspace',
      id: decodeURIComponent(m[2]),
      rest: m[3] ?? '',
    }
  } catch {
    return null
  }
}

/** The plain-text 404 an unknown `/api/internal/*` route answers with. */
function unknownRoute(): Response {
  return new Response('404 Not Found', { status: 404 })
}

function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false
  const addr = address.trim().toLowerCase()
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
}

/**
 * The socket's view of who called. A legitimate caller fetched
 * `http://127.0.0.1:<api port>` — this same process — so it is loopback;
 * anything else reached the public origin instead.
 */
function requestPeerAddress(c: Context): string | null {
  const server = c.env as { requestIP?: (req: Request) => { address?: string } | null } | undefined
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? null
  } catch {
    return null
  }
}

function secretMatches(given: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(SECRET)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** The instance-tunnel transport (the real one lives in `routes/instances`). */
type TunnelTransport = {
  ensureTunnelConnected: (instanceId: string, deadlineMs: number) => Promise<boolean>
  sendTunnelRequest: (instanceId: string, payload: any) => Promise<{ status: number; headers?: Record<string, string>; body?: string }>
  sendTunnelStreamRequest: (instanceId: string, payload: any, onChunk: (chunk: any) => void) => { cancel: () => void }
  generateRequestId: () => string
}

export interface HostTunnelOptions {
  /** Test seam: the peer address, when there is no socket to ask. */
  _peerAddress?: string | null
  /** Test seam: "which desktop hosts this workspace". */
  _hostOf?: (workspaceId: string) => Promise<string | null>
  /** Test seam: the instance-tunnel transport. */
  _tunnel?: TunnelTransport
}

async function targetWorkspaceId(target: TunnelTarget): Promise<string | null> {
  if (target.kind === 'workspace') return target.id
  const project = await prisma.project.findUnique({
    where: { id: target.id },
    select: { workspaceId: true },
  })
  return project?.workspaceId ?? null
}

/**
 * A tunnel URL names one instance; that instance may only reach a workspace it
 * hosts. The one exception is the device-tools call (SHO-285): a paired machine
 * runs a tool against its owner's Personal workspace, which is never hosted.
 */
async function instanceServesTarget(
  instanceId: string,
  instanceUserId: string,
  target: TunnelTarget,
  hostOf: (workspaceId: string) => Promise<string | null>,
): Promise<boolean> {
  const workspaceId = await targetWorkspaceId(target)
  if (!workspaceId) return false
  if ((await hostOf(workspaceId)) === instanceId) return true
  if (target.kind === 'workspace' && target.rest === DEVICE_TOOLS_SUFFIX) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { kind: true, personalOwnerId: true },
    })
    return workspace?.kind === 'personal' && workspace.personalOwnerId === instanceUserId
  }
  return false
}

/** `ALL /api/internal/host-tunnel/:secret/:instanceId/*` — see the module doc. */
export async function handleHostTunnel(c: Context, opts: HostTunnelOptions = {}): Promise<Response> {
  // Loopback and no ingress stamps: this route is reachable from the public
  // origin too, and a request that arrives from there is not one of ours.
  const peer = opts._peerAddress !== undefined ? opts._peerAddress : requestPeerAddress(c)
  if (!isLoopbackAddress(peer)) return unknownRoute()
  if (c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip')) return unknownRoute()

  const match = c.req.path.match(/^\/api\/internal\/host-tunnel\/([^/]+)\/([^/]+)(\/.*)$/)
  if (!match || !secretMatches(match[1])) return unknownRoute()

  const target = parseTunnelTarget(match[3])
  if (!target) return unknownRoute()

  const instanceId = decodeURIComponent(match[2])
  const path = `${match[3]}${new URL(c.req.url).search}`

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, name: true, userId: true },
  })
  if (!instance?.userId) return unknownRoute()

  const hostOf = opts._hostOf ?? hostOfWorkspace
  if (!(await instanceServesTarget(instanceId, instance.userId, target, hostOf))) {
    return c.json({ error: { code: 'forbidden', message: 'This host does not serve that workspace' } }, 403)
  }

  const tunnel: TunnelTransport =
    opts._tunnel ?? ((await import('../routes/instances')) as unknown as TunnelTransport)
  const { ensureTunnelConnected, sendTunnelRequest, sendTunnelStreamRequest, generateRequestId } = tunnel
  if (!(await ensureTunnelConnected(instanceId, WAKE_DEADLINE_MS))) {
    const err = new HostOfflineError(instanceId, instance.name)
    return c.json({ error: { code: err.code, message: err.message, instanceId, retryable: true } }, 503)
  }

  const method = c.req.method
  const headers: Record<string, string> = {
    // One user (SHO-285): the desktop's user is the host's owner.
    'x-tunnel-auth-user-id': instance.userId,
  }
  for (const name of FORWARD_HEADERS) {
    const value = c.req.header(name)
    if (value) headers[name] = value
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.text()

  if (isStreaming(method, path, c.req.header('accept'))) {
    const requestId = generateRequestId()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const { cancel } = sendTunnelStreamRequest(
          instanceId,
          { type: 'request', requestId, method, path, headers, body },
          (chunk) => {
            if (chunk.type === 'stream-chunk' && chunk.data) {
              controller.enqueue(new TextEncoder().encode(chunk.data))
            } else if (chunk.type === 'stream-end') {
              try { controller.close() } catch { /* already closed */ }
            } else if (chunk.type === 'stream-error') {
              controller.error(new Error(chunk.error || 'Stream error'))
            }
          },
        )
        c.req.raw.signal?.addEventListener(
          'abort',
          () => {
            cancel()
            try { controller.close() } catch { /* already closed */ }
          },
          { once: true },
        )
      },
    })
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' },
    })
  }

  try {
    const resp = await sendTunnelRequest(instanceId, {
      type: 'request',
      requestId: generateRequestId(),
      method,
      path,
      headers,
      body,
    })
    const out = new Headers()
    for (const [key, value] of Object.entries(resp.headers ?? {})) {
      if (value && !DROP_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value)
    }
    if (!out.has('content-type')) out.set('content-type', 'application/json')
    return new Response(resp.body || '', { status: resp.status, headers: out })
  } catch (err: any) {
    const offline = /offline/i.test(err?.message ?? '')
    const status = offline ? 503 : 502
    const code = offline ? 'host_offline' : 'host_tunnel_error'
    return c.json({ error: { code, message: err?.message ?? 'Host tunnel failed', instanceId, retryable: true } }, status)
  }
}

export interface OfflineQueueResult {
  queued: true
  queuedMessageId: string
  error: { code: 'host_offline'; message: string; instanceId: string }
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, any>>) : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (Array.isArray(message.parts)) {
      return message.parts
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('\n')
    }
    if (typeof message.content === 'string') return message.content
  }
  return typeof body.text === 'string' ? body.text : ''
}

/**
 * A send to a hosted workspace whose desktop is offline is queued, not refused
 * (SHO-285, Russell's answer on the card): the person's message is already
 * saved, so the turn goes on the session's queue under the same id. The queue
 * row syncs down when the desktop is back, and the desktop's own dispatcher runs
 * it there — the cloud dispatcher never runs a hosted workspace's queue.
 *
 * Returns null when the workspace is not hosted, or its desktop is reachable.
 */
export async function queueTurnIfHostOffline(params: {
  workspaceId: string
  sessionId: string | null | undefined
  userId: string | null | undefined
  userMessageId: string | null | undefined
  body: Record<string, unknown>
  _isOnline?: (instanceId: string) => Promise<boolean>
  /** Test-only override for "which desktop hosts this workspace". */
  _hostOf?: (workspaceId: string) => Promise<string | null>
}): Promise<OfflineQueueResult | null> {
  const hostOf = params._hostOf ?? hostOfWorkspace
  const hostInstanceId = await hostOf(params.workspaceId)
  if (!hostInstanceId || !params.sessionId || !params.userId) return null
  const isOnline =
    params._isOnline ??
    (async (id: string) => (await import('../routes/instances')).ensureTunnelConnected(id, WAKE_DEADLINE_MS))
  if (await isOnline(hostInstanceId)) return null

  const instance = await prisma.instance.findUnique({ where: { id: hostInstanceId }, select: { name: true } })
  const message = `${instance?.name || 'The desktop hosting this workspace'} is offline. Your message is queued and runs as soon as it is back.`
  const text = lastUserText(params.body)
  const { messages: _messages, ...rest } = params.body
  const latest = await prisma.chatQueuedMessage.findFirst({
    where: { sessionId: params.sessionId },
    orderBy: [{ position: 'desc' }, { createdAt: 'desc' }],
    select: { position: true },
  })
  const id = params.userMessageId || crypto.randomUUID()
  await prisma.chatQueuedMessage.upsert({
    where: { id },
    create: {
      id,
      sessionId: params.sessionId,
      userId: params.userId,
      position: (latest?.position ?? -1) + 1,
      status: 'pending',
      kind: 'user',
      content: text,
      parts: JSON.stringify([{ type: 'text', text }]),
      body: JSON.stringify({ ...rest, text, chatSessionId: params.sessionId }),
    },
    update: {},
  })
  return { queued: true, queuedMessageId: id, error: { code: 'host_offline', message, instanceId: hostInstanceId } }
}
