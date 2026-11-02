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
 */

import type { Context } from 'hono'
import { randomBytes } from 'node:crypto'
import { prisma } from './prisma'

export const HOST_TUNNEL_PREFIX = '/api/internal/host-tunnel'

const SECRET = process.env.SHOGO_HOST_TUNNEL_SECRET || randomBytes(24).toString('hex')

/** How long a request waits for a sleeping desktop's tunnel before `host_offline`. */
const WAKE_DEADLINE_MS = Math.max(0, Number(process.env.SHOGO_HOST_WAKE_DEADLINE_MS ?? 5_000) || 0)

/** The workspace's host, cached briefly: every runtime resolve asks. */
const HOST_TTL_MS = 10_000
const hostCache = new Map<string, { hostInstanceId: string | null; at: number }>()

export async function hostOfWorkspace(workspaceId: string): Promise<string | null> {
  const cached = hostCache.get(workspaceId)
  if (cached && Date.now() - cached.at < HOST_TTL_MS) return cached.hostInstanceId
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { hostInstanceId: true },
  })
  const hostInstanceId = row?.hostInstanceId ?? null
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

const FORWARD_HEADERS = ['content-type', 'accept', 'x-chat-session-id', 'x-billing-user-id', 'last-event-id']
const DROP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection', 'set-cookie', 'content-length', 'content-encoding'])

/** `ALL /api/internal/host-tunnel/:secret/:instanceId/*` — see the module doc. */
export async function handleHostTunnel(c: Context): Promise<Response> {
  const match = c.req.path.match(/^\/api\/internal\/host-tunnel\/([^/]+)\/([^/]+)(\/.*)$/)
  if (!match || match[1] !== SECRET) {
    return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404)
  }
  const instanceId = decodeURIComponent(match[2])
  const path = `${match[3]}${new URL(c.req.url).search}`

  const instance = await prisma.instance.findUnique({
    where: { id: instanceId },
    select: { id: true, name: true, userId: true },
  })
  if (!instance?.userId) {
    return c.json({ error: { code: 'not_found', message: 'Host not found' } }, 404)
  }

  const { ensureTunnelConnected, sendTunnelRequest, sendTunnelStreamRequest, generateRequestId } = await import(
    '../routes/instances'
  )
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
}): Promise<OfflineQueueResult | null> {
  const hostInstanceId = await hostOfWorkspace(params.workspaceId)
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
