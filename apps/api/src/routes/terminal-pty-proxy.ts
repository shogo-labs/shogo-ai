// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { auth } from '../auth'
import { prisma } from '../lib/prisma'
import { getProjectPodUrl } from '../lib/knative-project-manager'
import { deriveRuntimeToken } from '../lib/runtime-token'

export interface TerminalPtyProxyData {
  kind: 'terminal-pty-proxy'
  projectId: string
  upstreamUrl: string
  runtimeToken: string
  upstream?: WebSocket
  upstreamOpen: boolean
  clientClosed: boolean
  queue: Array<string | Buffer>
  queuedBytes: number
}

type ProxySocket = WebSocket & { data?: TerminalPtyProxyData }

const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST
const PREOPEN_QUEUE_LIMIT_BYTES = 64 * 1024

async function resolveAgentRuntimeBaseUrl(projectId: string): Promise<string | Response> {
  if (isKubernetes()) {
    try {
      return await getProjectPodUrl(projectId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = /not ready|not found|starting/i.test(message) ? 503 : 502
      return new Response(status === 503 ? 'Project runtime is starting' : 'Failed to resolve project runtime', {
        status,
        headers: status === 503 ? { 'Retry-After': '5' } : undefined,
      })
    }
  }

  const { getRuntimeManager } = await import('../lib/runtime')
  const manager = getRuntimeManager()
  let runtime = manager.status(projectId)
  if (!runtime || !runtime.agentPort) {
    try {
      runtime = await manager.start(projectId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(message || 'Failed to start project runtime', {
        status: 503,
        headers: { 'Retry-After': '5' },
      })
    }
  }
  if (!runtime?.agentPort) {
    return new Response('Project runtime is starting', { status: 503, headers: { 'Retry-After': '5' } })
  }
  return `http://localhost:${runtime.agentPort}`
}

export async function prepareTerminalPtyUpgrade(req: Request): Promise<TerminalPtyProxyData | Response | null> {
  const url = new URL(req.url)
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/terminal\/pty$/)
  if (!match) return null
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('WebSocket upgrade required', { status: 426 })
  }
  if (process.env.SHOGO_LOCAL_MODE !== 'true') {
    return new Response('PTY terminal is only available in Shogo Desktop', { status: 404 })
  }
  const originError = validateOrigin(req)
  if (originError) return originError

  const projectId = decodeURIComponent(match[1] || '')
  const authResult = await authorizeProjectRequest(req, projectId)
  if (authResult) return authResult

  const podUrl = await resolveAgentRuntimeBaseUrl(projectId)
  if (podUrl instanceof Response) return podUrl

  const upstreamUrl = toWebSocketUrl(`${podUrl}/terminal/pty`)
  return {
    kind: 'terminal-pty-proxy',
    projectId,
    upstreamUrl,
    runtimeToken: deriveRuntimeToken(projectId),
    upstreamOpen: false,
    clientClosed: false,
    queue: [],
    queuedBytes: 0,
  }
}

export function handleTerminalPtyProxyOpen(ws: ProxySocket): void {
  const data = ws.data
  if (!data) {
    ws.close(1011, 'Missing proxy data')
    return
  }
  let upstream: WebSocket
  try {
    upstream = createUpstreamWebSocket(data.upstreamUrl, { 'x-runtime-token': data.runtimeToken })
  } catch {
    ws.close(1011, 'PTY upstream WebSocket unsupported')
    return
  }
  data.upstream = upstream

  upstream.onopen = () => {
    data.upstreamOpen = true
    for (const queued of data.queue.splice(0)) upstream.send(queued as any)
    data.queuedBytes = 0
  }
  upstream.onmessage = (event) => {
    if (data.clientClosed) return
    ws.send(event.data as any)
  }
  upstream.onerror = () => {
    if (!data.clientClosed) ws.close(1011, 'PTY upstream error')
  }
  upstream.onclose = (event) => {
    if (!data.clientClosed) ws.close(event.code || 1011, event.reason || 'PTY upstream closed')
  }
}

export function handleTerminalPtyProxyMessage(ws: ProxySocket, raw: string | Buffer): void {
  const data = ws.data
  if (!data?.upstream) return
  if (data.upstreamOpen && data.upstream.readyState === WebSocket.OPEN) {
    data.upstream.send(raw as any)
    return
  }
  const rawBytes = frameByteLength(raw)
  if (data.queuedBytes + rawBytes > PREOPEN_QUEUE_LIMIT_BYTES) {
    ws.send(JSON.stringify({ type: 'error', message: 'PTY upstream is not ready; input buffer limit exceeded' }))
    ws.close(1013, 'PTY upstream not ready')
    return
  }
  data.queue.push(raw)
  data.queuedBytes += rawBytes
}

export function handleTerminalPtyProxyClose(ws: ProxySocket): void {
  const data = ws.data
  if (!data) return
  data.clientClosed = true
  data.queue.length = 0
  data.queuedBytes = 0
  try {
    data.upstream?.close()
  } catch {
    // Best-effort upstream cleanup.
  }
}

async function authorizeProjectRequest(req: Request, projectId: string): Promise<Response | null> {
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })
  if (!project) return new Response('Project not found', { status: 404 })

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  })
  if (user?.role === 'super_admin') return null

  const member = await prisma.member.findFirst({
    where: { userId: session.user.id, workspaceId: project.workspaceId },
    select: { id: true },
  })
  return member ? null : new Response('Forbidden', { status: 403 })
}

function validateOrigin(req: Request): Response | null {
  const origin = req.headers.get('origin')
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!origin) {
    if (process.env.NODE_ENV === 'production' && allowed.length > 0) {
      return new Response('Forbidden origin', { status: 403 })
    }
    return null
  }
  if (allowed.length === 0 || allowed.includes(origin)) return null
  if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return null
  }
  return new Response('Forbidden origin', { status: 403 })
}

function toWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function frameByteLength(frame: string | Buffer): number {
  return typeof frame === 'string' ? Buffer.byteLength(frame, 'utf8') : frame.byteLength
}

function createUpstreamWebSocket(url: string, headers: Record<string, string>): WebSocket {
  if (typeof Bun !== 'undefined') {
    return new WebSocket(url, { headers } as unknown as ConstructorParameters<typeof WebSocket>[1])
  }
  throw new Error('PTY upstream WebSocket headers require Bun runtime')
}
