// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Control — Instance Registry & Tunnel Proxy
 *
 * Enables cloud users to see and control their local Shogo instances.
 * Local instances poll via HTTP heartbeat; the cloud signals them to
 * open an on-demand WebSocket when a user needs interactive control.
 *
 * Endpoints:
 * - POST /api/instances/heartbeat         — Heartbeat from local instance (API key auth)
 * - POST /api/instances/viewer-active     — Signal that a user is viewing Remote Control
 * - POST /api/instances/:id/request-connect — Request an instance to open its WebSocket tunnel
 * - GET  /api/instances/ws                — WebSocket upgrade (API key auth from local instance)
 * - GET  /api/instances                   — List instances for workspace (session auth)
 * - GET  /api/instances/:id               — Instance details (session auth)
 * - PUT  /api/instances/:id               — Update instance name (session auth)
 * - DELETE /api/instances/:id             — Remove instance from registry (session auth)
 * - POST /api/instances/:id/proxy         — Proxy a request to local instance via tunnel
 * - POST /api/instances/:id/proxy/stream  — Proxy a streaming request via tunnel
 */

import { Hono } from 'hono'
import { prisma, InstanceKind } from '../lib/prisma'
import { groupMachinesByHostname, workspaceNamesById } from '../lib/machine-list'
import { hostingInstanceIds } from '../lib/hosted-workspace'
import { resolveInstanceIdentity, findIdentityRow, deviceIdFrom } from '../lib/instance-identity'
import { can } from '../lib/authz'
import { releaseHostedWorkspaces } from '../lib/machine-sync/ingest'
import { resolveApiKey } from './api-keys'
import { logRemoteAction, classifyAction } from './remote-audit'
import {
  initTunnelRedis,
  registerTunnelOwnership,
  unregisterTunnelOwnership,
  evictTunnelOwnership,
  refreshTunnelOwnership,
  getTunnelOwner,
  relayTunnelRequest,
  relayTunnelStreamRequest,
  setLocalTunnelHandlers,
  markViewerActiveRedis,
  isViewerActiveRedis,
  markControllerActiveRedis,
  getActiveControllersRedis,
  isTunnelConnectedAnywhere,
  getPodId,
  verifyPodAlive,
} from '../lib/tunnel-redis'
import { sendPushToInstance } from '../lib/push-notifications'
import {
  isWorkspaceDownloadPath,
  relayWorkspaceDownload,
  tunnelResponseBody,
} from '../lib/tunnel-body'
import { HOST_RETRY_AFTER_S, PROXY_TIMEOUT_MS, RELAY_TIMEOUT_MS } from '../lib/tunnel-timeouts'
import { hostOfWorkspace } from '../lib/host-tunnel'
import { isAgentStreamPath, isAgentStreamTunnelPath, stripAgentProxyWrapper } from '../lib/agent-stream-paths'
import { RelayTimeoutError } from '../lib/tunnel-errors'
import { openSession, closeSession, hasSession } from '../lib/proxy-billing-session'
import { trackChatStreamForBilling } from '../lib/chat-usage-tracker'
import { trackUsageFromStream } from './project-chat'
import {
  isFederatedEnabled,
  listCloudInstancesForWorkspace,
  lookupCloudInstance,
  forwardToUpstream,
  copyResponseHeaders,
  getUpstreamOrigin,
} from '../lib/federated-upstream'

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Map an x-shogo-kind header / body field to a Prisma enum value.
 *  Accepts both 'cli-worker' (wire) and 'cli_worker' (enum) — defaults
 *  to 'desktop' for unknown values so existing clients don't change shape. */
function parseInstanceKind(raw: string | null | undefined): InstanceKind {
  const v = (raw || '').toLowerCase().replace(/[-\s]/g, '_')
  if (v === 'cli_worker' || v === 'cliworker') return InstanceKind.cli_worker
  if (v === 'desktop') return InstanceKind.desktop
  return InstanceKind.desktop
}

/** Inverse of parseInstanceKind — render an enum value back onto the wire. */
export function formatInstanceKind(kind: InstanceKind): 'desktop' | 'cli-worker' {
  return kind === InstanceKind.cli_worker ? 'cli-worker' : 'desktop'
}

// ─── Constants ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_IDLE_S = 60
const POLL_INTERVAL_VIEWER_S = 5
const POLL_INTERVAL_WS_REQUESTED_S = 3
const WS_REQUEST_TTL_MS = 2 * 60 * 1000
const VIEWER_ACTIVE_TTL_MS = 2 * 60 * 1000
const STREAM_FIRST_CHUNK_TIMEOUT_MS = 90_000
const STREAM_IDLE_TIMEOUT_MS = 120_000
const STREAM_MAX_TIMEOUT_MS = 600_000
/**
 * The stream timeouts, read per request so a test can shrink them
 * (`SHOGO_TUNNEL_STREAM_*`) instead of waiting fifteen real minutes to prove a
 * live stream is never cut (SHO-546). Production never sets them.
 */
function streamTimeouts(): { firstChunk: number; idle: number; max: number } {
  const envMs = (name: string, fallback: number) => {
    const value = Number(process.env[name])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    firstChunk: envMs('SHOGO_TUNNEL_STREAM_FIRST_CHUNK_TIMEOUT_MS', STREAM_FIRST_CHUNK_TIMEOUT_MS),
    idle: envMs('SHOGO_TUNNEL_STREAM_IDLE_TIMEOUT_MS', STREAM_IDLE_TIMEOUT_MS),
    max: envMs('SHOGO_TUNNEL_STREAM_MAX_TIMEOUT_MS', STREAM_MAX_TIMEOUT_MS),
  }
}
const HEARTBEAT_INTERVAL_MS = 25_000
const TUNNEL_WAIT_TIMEOUT_MS = 10_000
const TUNNEL_WAIT_POLL_MS = 500
/**
 * Wake window for a desktop whose heartbeat is fresh (SHO-506). A desktop learns
 * the cloud wants its tunnel from its next heartbeat poll, so a wait shorter than
 * the time to that poll is a coin flip on whether the wake was seen at all.
 * `WAKE_MAX_WAIT_MS` is the worst case: an idle poll (`POLL_INTERVAL_IDLE_S`) plus
 * a margin for the last-seen write being throttled. `WAKE_MIN_WAIT_MS` keeps a
 * host that has just polled from being written off in milliseconds.
 */
const WAKE_MIN_WAIT_MS = 5_000
const WAKE_MAX_WAIT_MS = 75_000
const WAKE_HEARTBEAT_MARGIN_MS = 15_000
/** Suggested client retry, in seconds, for a host that is connecting (not offline). */
const WAKE_RETRY_AFTER_S = HOST_RETRY_AFTER_S

// ─── Viewer tracking (Redis-primary, in-memory fallback) ────────────────────

const activeViewers = new Map<string, number>()

export async function isViewerActive(workspaceId: string): Promise<boolean> {
  const redisResult = await isViewerActiveRedis(workspaceId)
  if (redisResult) return true

  const ts = activeViewers.get(workspaceId)
  if (!ts) return false
  if (Date.now() - ts > VIEWER_ACTIVE_TTL_MS) {
    activeViewers.delete(workspaceId)
    return false
  }
  return true
}

/**
 * Machine relay calls mark the viewer on every request, so a busy panel would
 * SET the same Redis key many times a second. The key lives 2 min; refreshing
 * it at most every 30 s per pod keeps it alive with a wide margin (PERF-6).
 */
const VIEWER_REFRESH_MS = 30_000

export async function markViewerActive(workspaceId: string) {
  const now = Date.now()
  const last = activeViewers.get(workspaceId)
  if (last !== undefined && now - last < VIEWER_REFRESH_MS) return
  activeViewers.set(workspaceId, now)
  await markViewerActiveRedis(workspaceId).catch((err) => {
    console.warn('[RemoteControl] markViewerActiveRedis failed:', (err as Error).message)
  })
}

// ─── Active controllers (Redis-primary, in-memory fallback) ─────────────────

interface ActiveController {
  userId: string
  sessionId?: string
  lastSeenAt: number
}

const activeControllers = new Map<string, Map<string, ActiveController>>()
const CONTROLLER_TTL_MS = 60_000

export async function markControllerActive(instanceId: string, userId: string, sessionId?: string) {
  if (!activeControllers.has(instanceId)) {
    activeControllers.set(instanceId, new Map())
  }
  const key = sessionId || userId
  activeControllers.get(instanceId)!.set(key, { userId, sessionId, lastSeenAt: Date.now() })
  await markControllerActiveRedis(instanceId, userId, sessionId).catch((err) => {
    console.warn('[RemoteControl] markControllerActiveRedis failed:', (err as Error).message)
  })
}

async function getActiveControllers(instanceId: string): Promise<ActiveController[]> {
  const redisControllers = await getActiveControllersRedis(instanceId).catch(() => [])
  if (redisControllers.length > 0) return redisControllers

  const map = activeControllers.get(instanceId)
  if (!map) return []
  const now = Date.now()
  const result: ActiveController[] = []
  for (const [key, ctrl] of map) {
    if (now - ctrl.lastSeenAt > CONTROLLER_TTL_MS) {
      map.delete(key)
    } else {
      result.push(ctrl)
    }
  }
  return result
}

// ─── In-memory tunnel registry ──────────────────────────────────────────────

interface TunnelConnection {
  /** Bun attaches `.data` to the socket; we keep the socket's last pong there. */
  ws: WebSocket & { data?: any }
  instanceId: string
  workspaceId: string
  pendingRequests: Map<string, {
    resolve: (value: TunnelResponse) => void
    reject: (reason: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>
  streamHandlers: Map<string, (chunk: TunnelStreamChunk) => void>
}

export interface TunnelRequest {
  type: 'request'
  requestId: string
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
  /** From /api/projects/:id/agent-proxy/... before path normalization; desktop uses this to start the right runtime. */
  projectId?: string
  /** From /api/workspaces/:id/agent-proxy/... before path normalization. */
  workspaceId?: string
  /** Response body encodings the cloud can decode. `['base64']` is what makes binary bodies survive. */
  acceptBodyEncoding?: string[]
}

export interface TunnelResponse {
  type: 'response'
  requestId: string
  status: number
  headers?: Record<string, string>
  body?: string
  /** Set when `body` is base64-encoded bytes rather than text. */
  bodyEncoding?: 'base64'
}

export interface TunnelStreamChunk {
  type: 'stream-chunk' | 'stream-end' | 'stream-error'
  requestId: string
  data?: string
  error?: string
}

interface TunnelHeartbeat {
  type: 'heartbeat'
  metadata?: Record<string, unknown>
}

type TunnelMessage = TunnelResponse | TunnelStreamChunk | TunnelHeartbeat | { type: 'pong' }

const tunnels = new Map<string, TunnelConnection>()

/**
 * Set once this pod has been told to shut down.
 *
 * A socket opened while a pod is going away is registered and then told to move
 * on immediately: the pod stays in its Service's endpoint list for a moment, so
 * a desktop can land here after the drain broadcast went out (SHO-565).
 */
let drainingTunnels = false

/** How long this pod expects to live after a drain — the `graceMs` it sends. */
const TUNNEL_DRAIN_GRACE_MS = Math.max(
  0,
  Number(process.env.SHOGO_TUNNEL_DRAIN_GRACE_MS ?? 30_000) || 0,
)

/**
 * Tell every open tunnel on this pod to move to another one (SHO-565).
 *
 * Called from the SIGTERM handler: the desktop opens a replacement on another
 * pod first, so the turn in flight is never cut by this pod going away. Returns
 * how many sockets were told.
 */
export function drainInstanceTunnels(): number {
  drainingTunnels = true
  const frame = JSON.stringify({ type: 'drain', graceMs: TUNNEL_DRAIN_GRACE_MS })
  let sent = 0
  for (const [instanceId, conn] of tunnels) {
    try {
      conn.ws.send(frame)
      sent++
    } catch (err) {
      console.warn(
        `[RemoteControl] drain frame to ${instanceId} failed:`,
        (err as Error).message,
      )
    }
  }
  console.log(`[RemoteControl] Told ${sent} tunnel(s) to rotate off this pod`)
  return sent
}

export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

// ─── Adaptive poll interval ─────────────────────────────────────────────────

async function computeNextPollIn(instanceId: string, workspaceId: string, wsRequestedAt: Date | null): Promise<number> {
  if (wsRequestedAt && Date.now() - wsRequestedAt.getTime() < WS_REQUEST_TTL_MS) {
    return POLL_INTERVAL_WS_REQUESTED_S
  }
  if (await isViewerActive(workspaceId)) {
    return POLL_INTERVAL_VIEWER_S
  }
  return POLL_INTERVAL_IDLE_S
}

function isWsRequested(wsRequestedAt: Date | null): boolean {
  return !!wsRequestedAt && Date.now() - wsRequestedAt.getTime() < WS_REQUEST_TTL_MS
}

/**
 * Strip the agent-proxy wrapper from a tunneled path, returning the clean agent
 * path (e.g. "/agent/quick-actions").
 *
 * Two wrappers exist: `/api/projects/:pid/agent-proxy` for a project chat and
 * `/api/workspaces/:wsId/agent-proxy` for a workspace chat (the personal
 * companion, and a paired desktop's own workspace). A workspace agent turn is
 * the same SSE stream as a project one, so both are unwrapped here — otherwise
 * `isStreamingRequest` says "not streaming" and the relay buffers the whole
 * turn instead of forwarding it.
 *
 * IMPORTANT: only strips query-free path segments. Callers must handle
 * query strings separately (append after normalization).
 */
export const normalizeTransparentProxyPath = stripAgentProxyWrapper

/**
 * Decide whether a request should use the streaming tunnel pipeline.
 *
 * `cleanPath` must already be normalized (no project-proxy wrapper, no
 * query string).  We intentionally do NOT call normalizeTransparentProxyPath
 * again here to avoid double-normalization bugs.
 */
export function isStreamingRequest(method: string, cleanPath: string): boolean {
  return isAgentStreamPath(method, cleanPath)
}

// ─── WebSocket handler (called from Bun.serve websocket config) ─────────────

export async function handleInstanceWsOpen(ws: WebSocket & { data?: any }) {
  const { instanceId, workspaceId } = ws.data || {}
  if (!instanceId || !workspaceId) {
    ws.close(4001, 'Missing instance context')
    return
  }

  const conn: TunnelConnection = {
    ws,
    instanceId,
    workspaceId,
    pendingRequests: new Map(),
    streamHandlers: new Map(),
  }
  tunnels.set(instanceId, conn)

  // Await ownership registration BEFORE marking the instance 'online' in
  // Postgres. Otherwise another pod seeing the DB row flip to online can
  // race ahead of the Redis write and 503 with `{ code: 'offline' }`.
  // The inner whenReady() guard also absorbs the cold-start window where
  // Redis is still connecting.
  try {
    await registerTunnelOwnership(instanceId)
  } catch (err) {
    console.warn('[RemoteControl] registerTunnelOwnership failed:', (err as Error).message)
  }

  // The WS may have closed while we were awaiting Redis (cold start can
  // add ~200–2000 ms on the first call). If handleInstanceWsClose already
  // ran and marked the row 'offline', we must NOT flip it back to 'online'
  // here — that would leave the DB showing an online instance whose
  // underlying WS is already dead.
  if (!tunnels.has(instanceId)) {
    console.warn(
      `[RemoteControl] Instance ${instanceId} WS closed during registration; skipping online write`,
    )
    return
  }

  prisma.instance.update({
    where: { id: instanceId },
    data: { status: 'online', lastSeenAt: new Date(), wsRequestedAt: null },
  }).catch(() => {})

  // Ownership is in Redis at this point, so the desktop may treat this socket
  // as the one the cloud routes to (SHO-565). A rotation holds its replacement
  // until this frame arrives, which is why it is sent only after the write.
  sendTunnelFrame(ws, { type: 'ready', podId: getPodId() })
  if (drainingTunnels) sendTunnelFrame(ws, { type: 'drain', graceMs: TUNNEL_DRAIN_GRACE_MS })

  console.log(`[RemoteControl] Instance ${instanceId} connected (workspace ${workspaceId}, pod ${getPodId()})`)
}

/** Best-effort control frame: a socket that died mid-write is not an error. */
function sendTunnelFrame(ws: WebSocket & { data?: any }, frame: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(frame))
  } catch {
    // The close handler owns the aftermath of a dead socket.
  }
}

export function handleInstanceWsMessage(ws: WebSocket & { data?: any }, raw: string | Buffer) {
  const { instanceId } = ws.data || {}
  const conn = instanceId ? tunnels.get(instanceId) : null
  if (!conn) return

  let msg: TunnelMessage
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
  } catch {
    return
  }

  if (msg.type === 'pong') {
    conn.ws.data._lastPong = Date.now()
    return
  }

  if (msg.type === 'heartbeat') {
    const hb = msg as TunnelHeartbeat
    prisma.instance.update({
      where: { id: instanceId },
      data: { lastSeenAt: new Date(), metadata: (hb.metadata ?? undefined) as any },
    }).catch(() => {})
    return
  }

  if (msg.type === 'response') {
    const resp = msg as TunnelResponse
    const pending = conn.pendingRequests.get(resp.requestId)
    if (pending) {
      clearTimeout(pending.timeout)
      conn.pendingRequests.delete(resp.requestId)
      pending.resolve(resp)
    }
    return
  }

  if (msg.type === 'stream-chunk' || msg.type === 'stream-end' || msg.type === 'stream-error') {
    const chunk = msg as TunnelStreamChunk
    const handler = conn.streamHandlers.get(chunk.requestId)
    if (handler) {
      handler(chunk)
      if (chunk.type === 'stream-end' || chunk.type === 'stream-error') {
        conn.streamHandlers.delete(chunk.requestId)
      }
    }
    return
  }
}

export function handleInstanceWsClose(
  ws: WebSocket & { data?: any },
  code?: number,
  reason?: string,
) {
  const { instanceId } = ws.data || {}
  if (!instanceId) return

  const closeInfo = `code=${code ?? 'none'} reason=${reason || 'none'}`

  const conn = tunnels.get(instanceId)

  // Ignore a stale close: during a reconnect flap a newer socket may already
  // own the registry entry, and tearing down here would evict the live tunnel.
  if (conn && conn.ws !== ws) {
    console.log(
      `[RemoteControl] Instance ${instanceId} stale WS close ignored — superseded by a newer connection (${closeInfo})`,
    )
    return
  }

  if (conn) {
    for (const [, pending] of conn.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Tunnel disconnected'))
    }
    conn.pendingRequests.clear()
    for (const [reqId, handler] of conn.streamHandlers) {
      handler({ type: 'stream-error', requestId: reqId, error: 'Tunnel disconnected' })
    }
    conn.streamHandlers.clear()
    tunnels.delete(instanceId)
  }

  unregisterTunnelOwnership(instanceId)
    .then((wasOwner) => {
      if (!wasOwner) {
        // Another pod owns this machine: this socket was replaced (SHO-565), so
        // the tunnel is alive — flipping the row offline would 503 every
        // request until the next heartbeat.
        console.log(
          `[RemoteControl] Instance ${instanceId} moved to another pod — keeping it online (${closeInfo})`,
        )
        return undefined
      }
      return prisma.instance
        .update({
          where: { id: instanceId },
          data: { status: 'offline' },
        })
        .catch(() => undefined)
    })
    .catch((err) => {
      console.warn('[RemoteControl] unregisterTunnelOwnership failed:', (err as Error).message)
    })

  console.log(`[RemoteControl] Instance ${instanceId} disconnected (${closeInfo})`)
}

/**
 * Read the tunnel API key out of a WebSocket upgrade request.
 *
 * Preferred order (header-only — keeps secrets out of access logs and
 * Cloudflare logging):
 *   1. `Authorization: Bearer <key>`
 *   2. `x-api-key: <key>`
 *
 * Legacy fallback for older desktop builds:
 *   3. `?key=<key>` query parameter
 *
 * The legacy path is deprecated; once all deployed desktops have rolled
 * to the new tunnel client we can drop the query-string branch.
 */
function extractInstanceWsKey(url: URL, headers: Headers): { key: string; legacy: boolean } {
  const auth = headers.get('authorization') || ''
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer) return { key: bearer, legacy: false }
  const xKey = headers.get('x-api-key')
  if (xKey) return { key: xKey, legacy: false }
  const queryKey = url.searchParams.get('key')
  if (queryKey) return { key: queryKey, legacy: true }
  return { key: '', legacy: false }
}

/**
 * Authenticate a WebSocket upgrade request.
 * Returns { instanceId, workspaceId } or null.
 */
export async function authenticateInstanceWs(
  req: Request,
): Promise<{ instanceId: string; workspaceId: string } | null> {
  try {
    const url = new URL(req.url)
    const { key, legacy } = extractInstanceWsKey(url, req.headers)
    if (!key) return null

    const resolved = await resolveApiKey(key)
    if (!resolved) return null

    if (legacy) {
      console.warn('[RemoteControl] WS auth used legacy ?key= query param — desktop should upgrade to header-based auth')
    }

    // Identity (used to upsert the Instance row) — read from headers
    // first, fall back to query for legacy clients.
    const headerHostname = req.headers.get('x-shogo-hostname')
    const hostname = headerHostname || url.searchParams.get('hostname') || 'unknown'
    const headerName = req.headers.get('x-shogo-name')
    const name = headerName || url.searchParams.get('name') || hostname
    const headerOs = req.headers.get('x-shogo-os')
    const os = headerOs || url.searchParams.get('os') || null
    const headerArch = req.headers.get('x-shogo-arch')
    const arch = headerArch || url.searchParams.get('arch') || null
    const kind = parseInstanceKind(
      req.headers.get('x-shogo-kind') || url.searchParams.get('kind'),
    )

    // Hostname is not an identity: macOS renames itself per network, so a row
    // is found by device id first and the hostname is a field on it (SHO-276).
    const deviceId = req.headers.get('x-shogo-device-id') || url.searchParams.get('deviceId')
    const resolvedRow = await resolveInstanceIdentity(prisma, {
      workspaceId: resolved.workspaceId,
      userId: resolved.userId,
      hostname,
      name,
      os,
      arch,
      kind,
      deviceId,
    })
    const instance = await prisma.instance.update({
      where: { id: resolvedRow.id },
      data: { status: 'online', lastSeenAt: new Date(), wsRequestedAt: null },
    })

    return { instanceId: instance.id, workspaceId: resolved.workspaceId }
  } catch (err) {
    console.error('[RemoteControl] WS auth error:', (err as Error).message)
    return null
  }
}

// ─── Proxy helpers ──────────────────────────────────────────────────────────

function sendLocalTunnelRequest(instanceId: string, req: TunnelRequest): Promise<TunnelResponse> {
  const conn = tunnels.get(instanceId)
  if (!conn) return Promise.reject(new Error('Instance is offline (local)'))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.pendingRequests.delete(req.requestId)
      reject(new Error('Proxy request timed out'))
    }, PROXY_TIMEOUT_MS)

    conn.pendingRequests.set(req.requestId, { resolve, reject, timeout })
    conn.ws.send(JSON.stringify(req))
  })
}

export async function sendTunnelRequest(instanceId: string, req: TunnelRequest): Promise<TunnelResponse> {
  const conn = tunnels.get(instanceId)
  if (conn) return sendLocalTunnelRequest(instanceId, req)

  const ownerPod = await getTunnelOwner(instanceId)
  if (!ownerPod) throw new Error('Instance is offline')

  if (ownerPod === getPodId()) {
    await evictTunnelOwnership(instanceId).catch(() => {})
    throw new Error('Instance is offline')
  }

  const alive = await verifyPodAlive(ownerPod)
  if (!alive) {
    await evictTunnelOwnership(instanceId).catch(() => {})
    console.warn(`[RemoteControl] Proactively evicted dead pod ${ownerPod} for instance ${instanceId} (sendTunnelRequest)`)
    throw new Error('Instance is offline')
  }

  // The owner pod is demonstrably alive (it answered the probe), so a relay
  // timeout means the *machine* was slow, not that the pod died. Evicting here
  // used to delete a live tunnel's owner key, and the heartbeat could not put
  // it back — every later call then 503'd "Machine is offline" (SHO-185).
  try {
    const response = await relayTunnelRequest(ownerPod, instanceId, req)
    if (!response) throw new Error('Empty relay response')
    return response as TunnelResponse
  } catch (err: any) {
    if (err?.message === 'Cross-pod relay timed out') {
      console.warn(
        `[RemoteControl] Relay to ${ownerPod} for instance ${instanceId} timed out; pod answered our probe, keeping ownership`,
      )
      throw new RelayTimeoutError(instanceId, RELAY_TIMEOUT_MS)
    }
    throw err
  }
}

function sendLocalTunnelStreamRequest(
  instanceId: string,
  req: TunnelRequest,
  onChunk: (chunk: TunnelStreamChunk) => void,
): { cancel: () => void } {
  const conn = tunnels.get(instanceId)
  if (!conn) {
    onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Instance is offline (local)' })
    return { cancel: () => {} }
  }

  const c = conn
  let gotFirstChunk = false
  // An agent turn streams for as long as the model and its tools take, and the
  // runtime sends a `data-turn-seq` heartbeat every 250 ms while it works, so a
  // wall-clock cap can only ever cut a live turn (SHO-546: every desktop stream
  // died at 10 min however busy it was). Liveness for those is the idle timer,
  // which resets on every chunk. Every other stream keeps the hard cap.
  const agentStream = isAgentStreamTunnelPath(req.method, req.path)
  const timeouts = streamTimeouts()
  // Use a generous timeout for the first chunk — the local agent may need
  // to cold-start the runtime AND wait for the first LLM token.
  let idleTimer = setTimeout(() => kill('idle'), timeouts.firstChunk)
  const maxTimer = agentStream ? null : setTimeout(() => kill('max'), timeouts.max)

  function kill(reason: string) {
    clearTimeout(idleTimer)
    if (maxTimer) clearTimeout(maxTimer)
    c.streamHandlers.delete(req.requestId)
    onChunk({ type: 'stream-error', requestId: req.requestId, error: `Stream timed out (${reason})` })
  }

  c.streamHandlers.set(req.requestId, (chunk) => {
    clearTimeout(idleTimer)
    if (chunk.type === 'stream-chunk') {
      gotFirstChunk = true
      // After the first chunk, switch to the tighter inter-chunk timeout.
      idleTimer = setTimeout(() => kill('idle'), timeouts.idle)
    }
    if (chunk.type === 'stream-end' || chunk.type === 'stream-error') {
      clearTimeout(idleTimer)
      if (maxTimer) clearTimeout(maxTimer)
    }
    onChunk(chunk)
  })

  c.ws.send(JSON.stringify({ ...req, stream: true }))

  return {
    cancel: () => {
      clearTimeout(idleTimer)
      if (maxTimer) clearTimeout(maxTimer)
      c.streamHandlers.delete(req.requestId)
      try {
        c.ws.send(JSON.stringify({ type: 'cancel', requestId: req.requestId }))
      } catch {}
    },
  }
}

export function sendTunnelStreamRequest(
  instanceId: string,
  req: TunnelRequest,
  onChunk: (chunk: TunnelStreamChunk) => void,
): { cancel: () => void } {
  const conn = tunnels.get(instanceId)
  if (conn) return sendLocalTunnelStreamRequest(instanceId, req, onChunk)

  let cancelled = false
  const cancelRef = { cancel: () => { cancelled = true } }

  getTunnelOwner(instanceId).then(async (ownerPod) => {
    if (cancelled) return
    if (!ownerPod) {
      onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Instance is offline' })
      return
    }
    if (ownerPod === getPodId()) {
      evictTunnelOwnership(instanceId).catch(() => {})
      onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Instance is offline' })
      return
    }
    const alive = await verifyPodAlive(ownerPod)
    if (!alive) {
      await evictTunnelOwnership(instanceId).catch(() => {})
      console.warn(`[RemoteControl] Proactively evicted dead pod ${ownerPod} for instance ${instanceId} (sendTunnelStreamRequest)`)
      onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Instance is offline' })
      return
    }
    const relay = relayTunnelStreamRequest(ownerPod, instanceId, req, onChunk)
    cancelRef.cancel = relay.cancel
  }).catch((err) => {
    onChunk({ type: 'stream-error', requestId: req.requestId, error: (err as Error).message })
  })
  return { cancel: () => cancelRef.cancel() }
}

/**
 * A tunneled GET handed back as a `Response`, so a caller that reads a runtime
 * stream through `fetch`-shaped code can also reach a desktop-hosted runtime
 * (SHO-546). `trackUsageFromStream`'s resume hook is the caller: it re-attaches
 * to `/agent/chat/:id/stream?fromSeq=0` over the same tunnel the turn ran on.
 *
 * The streaming tunnel carries no response headers, so a resume cannot report
 * `X-Turn-Id` here — the replay's own `data-turn-start` frame is what tells the
 * tracker whether the buffer still holds its turn.
 */
export function tunnelStreamResponse(instanceId: string, req: TunnelRequest): Response {
  const encoder = new TextEncoder()
  let cancel: (() => void) | null = null
  let settled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const handle = sendTunnelStreamRequest(instanceId, req, (chunk) => {
        if (settled) return
        if (chunk.type === 'stream-chunk' && chunk.data) {
          try {
            controller.enqueue(encoder.encode(chunk.data))
          } catch {
            settled = true
          }
        } else if (chunk.type === 'stream-end') {
          settled = true
          try { controller.close() } catch { /* already closed */ }
        } else if (chunk.type === 'stream-error') {
          settled = true
          try { controller.error(new Error(chunk.error || 'Stream error')) } catch { /* already closed */ }
        }
      })
      cancel = handle.cancel
    },
    cancel() {
      settled = true
      cancel?.()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

// ─── REST routes ────────────────────────────────────────────────────────────

export function instanceRoutes() {
  // Kick off init eagerly. registerTunnelOwnership / getTunnelOwner now
  // await whenReady() internally, so any WS auth or relay that lands
  // during this boot window will block briefly instead of silently
  // no-oping against a null Redis client and returning 503.
  initTunnelRedis().catch((err) => {
    console.error('[RemoteControl] Failed to initialize tunnel Redis:', err.message)
  })

  setLocalTunnelHandlers(
    (instanceId, req) => sendLocalTunnelRequest(instanceId, req as TunnelRequest),
    (instanceId, req, onChunk) => sendLocalTunnelStreamRequest(instanceId, req as TunnelRequest, onChunk),
  )

  const router = new Hono()

  // POST /instances/heartbeat — HTTP heartbeat from local instance (replaces always-on WS)
  router.post('/instances/heartbeat', async (c) => {
    const key = c.req.header('x-api-key') || ''
    if (!key) {
      return c.json({ error: { code: 'unauthorized', message: 'API key required' } }, 401)
    }

    const resolved = await resolveApiKey(key)
    if (!resolved) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid API key' } }, 401)
    }

    const body = await c.req.json<{
      hostname: string
      name?: string
      os?: string
      arch?: string
      kind?: string
      deviceId?: string
      metadata?: Record<string, unknown>
    }>()

    if (!body.hostname) {
      return c.json({ error: { code: 'invalid_request', message: 'hostname required' } }, 400)
    }

    // Resolve the instance kind from header (preferred) → body → default.
    // The worker sends both, the desktop sends neither, so the default
    // 'desktop' here keeps existing clients on the existing row shape.
    const kind = parseInstanceKind(c.req.header('x-shogo-kind') || body.kind)
    const deviceId = deviceIdFrom(
      c.req.header('x-shogo-device-id') || body.deviceId || null,
      body.metadata,
    )
    const identity = {
      workspaceId: resolved.workspaceId,
      userId: resolved.userId,
      hostname: body.hostname,
      name: body.name || body.hostname,
      os: body.os || null,
      arch: body.arch || null,
      kind,
      deviceId,
      metadata: body.metadata,
    }

    // A viewer puts the desktop on a 5 s poll; writing the row on every one of
    // those was ~190k upserts/day for a lastSeenAt nobody reads that finely
    // (PERF-6). Read first and only write when something changed or the
    // timestamp is getting old. The read is an indexed lookup.
    const fields = {
      name: body.name || body.hostname,
      os: body.os || null,
      arch: body.arch || null,
      kind,
      metadata: body.metadata,
    }
    const existing = await findIdentityRow(prisma, identity)
    // A hostname the row does not carry yet, or a device id it has not adopted,
    // is a change the write has to make (SHO-276): skipping it is what left a
    // renamed Mac on a stale hostname.
    const identityChanged = Boolean(
      existing && (existing.hostname !== body.hostname || (deviceId && !existing.deviceId)),
    )
    const instance =
      existing && !identityChanged && !heartbeatNeedsWrite(existing as any, fields)
        ? existing
        : await resolveInstanceIdentity(prisma, { ...identity, touch: true })

    const wsRequested = isWsRequested((instance as any).wsRequestedAt ?? null)
    const nextPollIn = await computeNextPollIn(instance.id, resolved.workspaceId, instance.wsRequestedAt)
    const hasTunnel = tunnels.has(instance.id) || await isTunnelConnectedAnywhere(instance.id, { retry: false })

    // Where the desktop should open its on-demand WebSocket. In staging
    // / production this points at a non-DomainMapping host
    // (`tunnel.staging.shogo.ai` / `tunnel.shogo.ai`) that bypasses the
    // Knative DomainMapping rewriteHost loopback that breaks the WS
    // Upgrade handshake. When unset, the desktop falls back to deriving
    // the URL from its existing cloud URL (the dev / self-hosted path).
    const tunnelWsUrl = (process.env.SHOGO_TUNNEL_WS_URL || '').trim() || undefined

    return c.json({
      instanceId: instance.id,
      nextPollIn,
      wsRequested,
      tunnelStatus: hasTunnel ? 'connected' : 'polling',
      wsUrl: tunnelWsUrl,
    })
  })

  // POST /instances/viewer-active — Signal that a user is viewing Remote Control
  router.post('/instances/viewer-active', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const body = await c.req.json<{ workspaceId: string }>()
    if (!body.workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'workspaceId required' } }, 400)
    }

    if (!(await can(c, 'workspace:read', { workspaceId: body.workspaceId }))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    await markViewerActive(body.workspaceId)
    return c.json({ ok: true })
  })

  // POST /instances/:id/request-connect — Ask an instance to open its WebSocket tunnel
  router.post('/instances/:id/request-connect', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const id = c.req.param('id')
    // A hosted workspace's viewer names the workspace it is opening (SHO-538):
    // that workspace's runtime lives on this machine, so waking it is part of
    // opening it.
    // Only a JSON body is read: the federated fallback below forwards the raw
    // bytes, so a request without one must reach it untouched.
    const requestedWorkspaceId = /application\/json/i.test(c.req.header('content-type') ?? '')
      ? await c.req
          .json<{ workspaceId?: string }>()
          .then((body) => (typeof body?.workspaceId === 'string' ? body.workspaceId : null))
          .catch(() => null)
      : null
    const instance = await prisma.instance.findUnique({ where: { id } })
    if (!instance) {
      if (await isFederatedEnabled()) {
        const upstream = await forwardToUpstream(c)
        return new Response(upstream.body, {
          status: upstream.status,
          headers: copyResponseHeaders(upstream),
        })
      }
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    // Legacy rows with no recorded owner (userId null) fall back to the
    // membership check below, as they always have.
    const ownsMachine = !instance.userId || instance.userId === auth.userId

    // A machine serves two kinds of caller: the person it belongs to, and anyone
    // who may open a workspace it hosts (SHO-285) — that workspace's runtime runs
    // on this machine, so opening it has to be able to wake it (SHO-538). It is
    // still only that one workspace, and only when it is this machine's.
    const wakesHostedWorkspace =
      !ownsMachine &&
      !!requestedWorkspaceId &&
      (await can(c, 'workspace:read', { workspaceId: requestedWorkspaceId })) &&
      (await hostOfWorkspace(requestedWorkspaceId)) === instance.id

    if (!wakesHostedWorkspace && !(await can(c, 'workspace:read', { workspaceId: instance.workspaceId }))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    // Machines are scoped to the user who paired them. A workspace member
    // may not view or drive another member's machine.
    if (!ownsMachine && !wakesHostedWorkspace) {
      return c.json({ error: { code: 'forbidden', message: 'Not your machine' } }, 403)
    }

    if (tunnels.has(instance.id) || await isTunnelConnectedAnywhere(instance.id, { retry: false })) {
      return c.json({ ok: true, status: 'already_connected' })
    }

    await prisma.instance.update({
      where: { id: instance.id },
      data: { wsRequestedAt: new Date() },
    })

    await markViewerActive(instance.workspaceId)

    void sendPushToInstance(instance.id, { type: 'ws-requested', priority: 'high' })

    return c.json({ ok: true, status: 'requested' })
  })

  // GET /instances — List all instances for the authenticated user.
  //
  // `?workspaceId=` scopes to one cloud workspace (a project's runtime picker).
  // `?scope=owner` is the Settings → Remote control list: every machine this
  // user registered, whichever cloud workspace the app happens to be showing —
  // the same owner-scoped list the workspace switcher reads from
  // `GET /api/machines`. Each row carries the name of the workspace its key was
  // issued in, which is information only (one tunnel serves all of them).
  router.get('/instances', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const ownerScoped = c.req.query('scope') === 'owner'
    const workspaceId = c.req.query('workspaceId')

    if (!ownerScoped) {
      if (!workspaceId) {
        return c.json({ error: { code: 'invalid_request', message: 'workspaceId query param required' } }, 400)
      }

      if (!(await can(c, 'workspace:read', { workspaceId }))) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }
    }

    // Scope to the machines this user paired. Ownership is stamped from the
    // API key used to register/heartbeat the machine (see resolveApiKey), so
    // each member only sees their own machines, not everyone's in the workspace.
    //
    // A desktop belongs to its owner, not to the workspace its key happened to be
    // issued in (SHO-241 §C): asking for one workspace still lists the caller's
    // desktops wherever their rows live, or a machine would vanish from the
    // runtime picker the moment it was viewed from another workspace. `cli_worker`
    // rows are a workspace's dev boxes and stay workspace-scoped.
    const instances = await prisma.instance.findMany({
      where: ownerScoped
        ? { userId: auth.userId }
        : {
            userId: auth.userId,
            OR: [{ workspaceId }, { kind: { not: InstanceKind.cli_worker } }],
          },
      orderBy: { lastSeenAt: 'desc' },
    })

    const workspaceNames = await workspaceNamesById(instances.map((inst) => inst.workspaceId))

    // Owner scope is a machine list, so a machine registered in several
    // workspaces appears once, carrying every workspace it is in — the same
    // grouping `GET /api/machines` (the workspace switcher) applies, and with
    // the same representative row: the one that owns the cloud copy. Picking the
    // freshest row instead gave a live machine a new `id` every few seconds, and
    // the client's stored id then never matched (SHO-241). A workspace-scoped
    // caller asks for one workspace's view: `preferWorkspaceId` keeps the id it
    // already holds, and the machine still appears once.
    const grouped = groupMachinesByHostname(instances, {
      preferWorkspaceId: ownerScoped ? null : workspaceId,
      nameFor: (id) => workspaceNames.get(id),
      copyOwners: await hostingInstanceIds(instances.map((inst) => inst.id)),
    })

    const withLiveStatus = await Promise.all(grouped.map(async ({ row: inst, workspaces, rows: machineRows }) => ({
      ...inst,
      kind: formatInstanceKind(inst.kind),
      // Any live tunnel counts: with one row per workspace, the row picked as the
      // representative is not necessarily the one that is connected.
      status: await getMachineGroupStatus(machineRows),
      origin: 'local' as const,
      workspaceName: workspaceNames.get(inst.workspaceId) ?? null,
      workspaces,
    })))

    // Local mode: merge in any instances registered against the cloud
    // upstream this local API is signed in to. Local rows win on id
    // collision; cloud rows are tagged with the upstream hostname so
    // the UI can render a badge.
    let merged: Array<Record<string, unknown>> = withLiveStatus
    if (await isFederatedEnabled()) {
      const cloud = ownerScoped
        ? await listCloudInstancesForWorkspace(workspaceId ?? '', { ownerScope: true })
        : await listCloudInstancesForWorkspace(workspaceId ?? '')
      if (cloud.length) {
        const origin = getUpstreamOrigin()
        const localIds = new Set(withLiveStatus.map((i) => i.id))
        const tagged = cloud
          .filter((inst) => !localIds.has(inst.id))
          .map((inst) => ({ ...inst, origin }))
        merged = [...withLiveStatus, ...tagged]
      }
    }

    return c.json({ instances: merged })
  })


  // GET /instances/online — Trimmed list of online instances (for Phase 3 chat environment picker)
  router.get('/instances/online', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const workspaceId = c.req.query('workspaceId')
    if (!workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'workspaceId query param required' } }, 400)
    }

    if (!(await can(c, 'workspace:read', { workspaceId }))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    // Same rule as `GET /instances` (SHO-241 §C): a desktop belongs to its owner
    // wherever its row lives, so the chat environment picker sees the machine even
    // when the row was filed under another workspace's device key. `cli_worker`
    // rows stay workspace-scoped.
    const instances = await prisma.instance.findMany({
      where: {
        userId: auth.userId,
        OR: [{ workspaceId }, { kind: { not: InstanceKind.cli_worker } }],
      },
      orderBy: { lastSeenAt: 'desc' },
    })

    // A machine with a row per workspace must not appear once per row either.
    const machines = groupMachinesByHostname(instances, { preferWorkspaceId: workspaceId })
    const online = (await Promise.all(
      machines.map(async ({ row: inst, rows: machineRows }) => {
        const live = await Promise.all(
          machineRows.map(
            async (candidate) =>
              tunnels.has(candidate.id) ||
              (await isTunnelConnectedAnywhere(candidate.id, { retry: false })),
          ),
        )
        return live.some(Boolean) ? inst : null
      })
    )).filter((x): x is NonNullable<typeof x> => x !== null)

    return c.json({
      instances: online.map((inst) => ({
        id: inst.id,
        name: inst.name,
        hostname: inst.hostname,
        os: inst.os,
        arch: inst.arch,
        kind: formatInstanceKind(inst.kind),
        lastSeenAt: inst.lastSeenAt,
      })),
    })
  })

  // GET /instances/:id — Instance details
  router.get('/instances/:id', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const id = c.req.param('id')
    const instance = await prisma.instance.findUnique({ where: { id } })
    if (!instance) {
      // Local DB miss: in local mode, fall through to the cloud upstream
      // the local API is already signed in to. The forwarded response
      // carries the cloud's own membership + status checks; we surface
      // it verbatim so the UI sees the same shape as the local branch.
      if (await isFederatedEnabled()) {
        const upstream = await forwardToUpstream(c)
        return new Response(upstream.body, {
          status: upstream.status,
          headers: copyResponseHeaders(upstream),
        })
      }
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!(await can(c, 'workspace:read', { workspaceId: instance.workspaceId }))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    // Machines are scoped to the user who paired them. A workspace member
    // may not view or drive another member's machine. Legacy rows with no
    // recorded owner (userId null) fall back to the membership check above.
    if (instance.userId && instance.userId !== auth.userId) {
      return c.json({ error: { code: 'forbidden', message: 'Not your machine' } }, 403)
    }

    const controllers = await getActiveControllers(instance.id)
    return c.json({
      ...instance,
      kind: formatInstanceKind(instance.kind),
      status: tunnels.has(instance.id) || await isTunnelConnectedAnywhere(instance.id, { retry: false })
        ? 'online'
        : (isRecentlySeenViaHeartbeat(instance.lastSeenAt) ? 'heartbeat' : 'offline'),
      origin: 'local' as const,
      controllers: controllers.map((c) => ({
        userId: c.userId,
        lastSeenAt: c.lastSeenAt,
      })),
    })
  })

  // PUT /instances/:id — Rename instance
  router.put('/instances/:id', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!(await can(c, 'workspace:read', { workspaceId: instance.workspaceId }))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    // Machines are scoped to the user who paired them. A workspace member
    // may not view or drive another member's machine. Legacy rows with no
    // recorded owner (userId null) fall back to the membership check above.
    if (instance.userId && instance.userId !== auth.userId) {
      return c.json({ error: { code: 'forbidden', message: 'Not your machine' } }, 403)
    }

    const body = await c.req.json<{ name?: string }>()
    const updated = await prisma.instance.update({
      where: { id: instance.id },
      data: { name: body.name ?? instance.name },
    })

    return c.json(updated)
  })

  // DELETE /instances/:id — Remove instance from registry
  router.delete('/instances/:id', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!(await can(c, 'workspace:read', { workspaceId: instance.workspaceId }))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    // Machines are scoped to the user who paired them. A workspace member
    // may not view or drive another member's machine. Legacy rows with no
    // recorded owner (userId null) fall back to the membership check above.
    if (instance.userId && instance.userId !== auth.userId) {
      return c.json({ error: { code: 'forbidden', message: 'Not your machine' } }, 403)
    }

    const conn = tunnels.get(instance.id)
    if (conn) {
      conn.ws.close(4000, 'Instance removed')
    }

    // Unpairing hands the machine's hosted workspaces back to cloud compute
    // (SHO-285). Their rows stay: they are the person's workspaces.
    await releaseHostedWorkspaces(prisma, instance.id).catch((err: any) => {
      console.warn(`[Instances] could not release hosted workspaces of ${instance.id}: ${err?.message ?? err}`)
    })

    await prisma.instance.delete({ where: { id: instance.id } })
    return c.json({ ok: true })
  })

  // POST /instances/:id/proxy — Proxy a single request to the local instance
  router.post('/instances/:id/proxy', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const id = c.req.param('id')
    const instance = await prisma.instance.findUnique({ where: { id } })
    if (!instance) {
      if (await isFederatedEnabled()) {
        const upstream = await forwardToUpstream(c)
        return new Response(upstream.body, {
          status: upstream.status,
          headers: copyResponseHeaders(upstream),
        })
      }
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!(await can(c, 'workspace:read', { workspaceId: instance.workspaceId }))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    // Machines are scoped to the user who paired them. A workspace member
    // may not view or drive another member's machine. Legacy rows with no
    // recorded owner (userId null) fall back to the membership check above.
    if (instance.userId && instance.userId !== auth.userId) {
      return c.json({ error: { code: 'forbidden', message: 'Not your machine' } }, 403)
    }

    if (!tunnels.has(instance.id) && !await isTunnelConnectedAnywhere(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    await markControllerActive(instance.id, auth.userId)

    const body = await c.req.json<{
      method: string
      path: string
      headers?: Record<string, string>
      body?: string
    }>()

    const requestId = generateRequestId()
    const action = classifyAction(body.method || 'GET', body.path)

    try {
      const resp = await sendTunnelRequest(instance.id, {
        type: 'request',
        requestId,
        method: body.method || 'GET',
        path: body.path,
        headers: body.headers,
        body: body.body,
      })

      logRemoteAction({
        instanceId: instance.id,
        userId: auth.userId,
        action,
        path: body.path,
        method: body.method || 'GET',
        result: `HTTP ${resp.status}`,
      })

      return c.json({
        status: resp.status,
        headers: resp.headers,
        body: resp.body,
      })
    } catch (err: any) {
      logRemoteAction({
        instanceId: instance.id,
        userId: auth.userId,
        action,
        path: body.path,
        method: body.method || 'GET',
        result: `error: ${err.message}`,
      })
      return c.json({ error: { code: 'proxy_error', message: err.message } }, 502)
    }
  })

  // POST /instances/:id/ping — Lightweight latency check through the tunnel
  router.post('/instances/:id/ping', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!tunnels.has(instance.id) && !await isTunnelConnectedAnywhere(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    const requestId = generateRequestId()
    const start = Date.now()
    try {
      await sendTunnelRequest(instance.id, {
        type: 'request',
        requestId,
        method: 'GET',
        path: '/health',
      })
      return c.json({ ok: true, rttMs: Date.now() - start })
    } catch (err: any) {
      return c.json({ error: { code: 'proxy_error', message: err.message } }, 502)
    }
  })

  // POST /instances/:id/proxy/stream — Proxy a streaming request (e.g. /agent/chat)
  router.post('/instances/:id/proxy/stream', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const id = c.req.param('id')
    const instance = await prisma.instance.findUnique({ where: { id } })
    if (!instance) {
      if (await isFederatedEnabled()) {
        const upstream = await forwardToUpstream(c)
        return new Response(upstream.body, {
          status: upstream.status,
          headers: copyResponseHeaders(upstream),
        })
      }
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!(await can(c, 'workspace:read', { workspaceId: instance.workspaceId }))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    // Machines are scoped to the user who paired them. A workspace member
    // may not view or drive another member's machine. Legacy rows with no
    // recorded owner (userId null) fall back to the membership check above.
    if (instance.userId && instance.userId !== auth.userId) {
      return c.json({ error: { code: 'forbidden', message: 'Not your machine' } }, 403)
    }

    if (!tunnels.has(instance.id) && !await isTunnelConnectedAnywhere(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    await markControllerActive(instance.id, auth.userId, auth.sessionId || 'stream')

    const body = await c.req.json<{
      method: string
      path: string
      headers?: Record<string, string>
      body?: string
    }>()

    void logRemoteAction({
      instanceId: instance.id,
      userId: auth.userId,
      action: classifyAction(body.method || 'POST', body.path),
      path: body.path,
      method: body.method || 'POST',
      summary: 'streaming',
    })

    const requestId = generateRequestId()

    // Bracket chat turns with a billing session so per-turn AI proxy
    // calls accumulate into a single `chat_message` row. The body envelope
    // for this route doesn't carry a projectId, but the wrapper path
    // pattern produced by `useRemoteChatTransport.ts` is the same as the
    // transparent proxy, so we look in `body.path`.
    const tunnelProjectId = body.path?.match(
      /^\/api\/projects\/([^/]+)\/agent-proxy(?:\/|$)/,
    )?.[1]
    const cleanPath = body.path ? normalizeTransparentProxyPath(body.path) : ''
    const isChatTurn = (body.method || 'POST') === 'POST' && cleanPath === '/agent/chat' && !!tunnelProjectId
    // Pull the chat-session id out of the forwarded request headers (the
    // envelope copies headers verbatim). With it, the billing session is
    // keyed by `(projectId, chatSessionId)` and concurrent chat panels
    // against the same project bill independently.
    const envelopeChatSessionId = (() => {
      const h = body.headers || {}
      return h['x-chat-session-id'] || h['X-Chat-Session-Id'] || null
    })()
    let trackerController: ReadableStreamDefaultController<Uint8Array> | null = null
    if (isChatTurn && tunnelProjectId) {
      await openSession(tunnelProjectId, instance.workspaceId, auth.userId, envelopeChatSessionId)
      const trackerStream = new ReadableStream<Uint8Array>({
        start(c) { trackerController = c },
      })
      trackChatStreamForBilling(trackerStream, tunnelProjectId, envelopeChatSessionId).catch((err) =>
        console.error(`[InstanceTunnel] Tracking error for project ${tunnelProjectId}:`, err),
      )
    }

    const stream = new ReadableStream({
      start(controller) {
        const { cancel } = sendTunnelStreamRequest(
          instance.id,
          {
            type: 'request',
            requestId,
            method: body.method || 'POST',
            path: body.path,
            headers: body.headers,
            body: body.body,
          },
          (chunk) => {
            if (chunk.type === 'stream-chunk' && chunk.data) {
              const bytes = new TextEncoder().encode(chunk.data)
              controller.enqueue(bytes)
              if (trackerController) {
                try { trackerController.enqueue(bytes) } catch { /* tracker closed */ }
              }
            } else if (chunk.type === 'stream-end') {
              controller.close()
              if (trackerController) {
                try { trackerController.close() } catch { /* already closed */ }
              }
            } else if (chunk.type === 'stream-error') {
              controller.error(new Error(chunk.error || 'Stream error'))
              if (trackerController) {
                try { trackerController.close() } catch { /* already closed */ }
              }
            }
          },
        )

        const signal = c.req.raw.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            cancel()
            try { controller.close() } catch {}
            if (trackerController) {
              try { trackerController.close() } catch { /* already closed */ }
            }
          }, { once: true })
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  // ─── Transparent proxy ──────────────────────────────────────────────────
  // ALL /instances/:id/p/* — Transparent HTTP proxy
  //
  // Forwards any HTTP request through the tunnel to the remote agent as-is.
  // The client uses agentUrl = "${API_URL}/api/instances/${id}/p" and all
  // existing fetch calls (GET /agent/status, POST /agent/chat, etc.) work
  // without a special fetch wrapper or envelope format.
  //
  // Streaming is auto-detected for POST requests to known streaming paths
  // (e.g. /agent/chat, /agent/logs/stream).

  // Use :rest{.+} so the full suffix after /p/ is always captured. A trailing /*
  // alone does not populate c.req.param('*') reliably under app.route('/api', …),
  // and manual pathname slicing can miss edge cases — leaving afterPrefix empty
  // normalizes to "/" and breaks tunnel forwarding.
  router.all('/instances/:id/p/:rest{.+}', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instanceId = c.req.param('id')
    const instance = await prisma.instance.findUnique({ where: { id: instanceId } })
    if (!instance) {
      // Federated transparent proxy: forward the entire request (incl. body
      // and headers) to cloud and pipe the response back. Streaming responses
      // (SSE/chunked) flow through `Response.body` without buffering.
      if (await isFederatedEnabled()) {
        const upstream = await forwardToUpstream(c)
        return new Response(upstream.body, {
          status: upstream.status,
          headers: copyResponseHeaders(upstream),
        })
      }
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!(await can(c, 'workspace:read', { workspaceId: instance.workspaceId }))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    // Machines are scoped to the user who paired them. A workspace member
    // may not view or drive another member's machine. Legacy rows with no
    // recorded owner (userId null) fall back to the membership check above.
    if (instance.userId && instance.userId !== auth.userId) {
      return c.json({ error: { code: 'forbidden', message: 'Not your machine' } }, 403)
    }

    const localTunnel = tunnels.has(instanceId)
    let remoteTunnelPod = localTunnel ? null : await getTunnelOwner(instanceId)

    // If Redis says a remote pod owns this tunnel but that pod is actually us
    // and we don't have a local connection, the ownership is stale. Evict it.
    if (!localTunnel && remoteTunnelPod === getPodId()) {
      await evictTunnelOwnership(instanceId).catch(() => {})
      remoteTunnelPod = null
    }

    // If Redis points to a different pod, verify it's actually alive before
    // committing to a 30s relay timeout. Dead pods (e.g. from a dev server
    // restart) will never respond. Evict and fall through to the wake-up path.
    if (!localTunnel && remoteTunnelPod && remoteTunnelPod !== getPodId()) {
      const alive = await verifyPodAlive(remoteTunnelPod)
      if (!alive) {
        console.warn(`[RemoteControl] Proactively evicting dead pod ${remoteTunnelPod} for instance ${instanceId}`)
        await evictTunnelOwnership(instanceId).catch(() => {})
        remoteTunnelPod = null
      }
    }

    if (!localTunnel && !remoteTunnelPod) {
      await prisma.instance.update({
        where: { id: instanceId },
        data: { wsRequestedAt: new Date() },
      }).catch(() => {})
      void sendPushToInstance(instanceId, { type: 'ws-requested', priority: 'high' })

      const deadline = Date.now() + TUNNEL_WAIT_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, TUNNEL_WAIT_POLL_MS))
        if (tunnels.has(instanceId)) break
        remoteTunnelPod = await getTunnelOwner(instanceId)
        if (remoteTunnelPod) break
      }

      if (!tunnels.has(instanceId) && !remoteTunnelPod) {
        return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
      }
    }

    await markControllerActive(instanceId, auth.userId)

    const incomingUrl = new URL(c.req.url)
    const qs = incomingUrl.search
    const afterPrefix = c.req.param('rest') || ''
    const rawPath = '/' + afterPrefix

    // Extract the target's id from wrapped agent-proxy paths before stripping.
    // Both wrappers name their runtime: a project chat names a project, a
    // workspace chat names a workspace (the personal companion, or a paired
    // desktop's own). Dropping the workspace id sent the request to whichever
    // runtime happened to be running, with no token — a 401 (SHO-526).
    const tunnelProjectId = rawPath.match(
      /^\/api\/projects\/([^/]+)\/agent-proxy(?:\/|$)/,
    )?.[1]
    const tunnelWorkspaceId = rawPath.match(
      /^\/api\/workspaces\/([^/]+)\/agent-proxy(?:\/|$)/,
    )?.[1]

    // ── Path normalization ─────────────────────────────────────────────
    // Strip the /api/projects/:pid/agent-proxy prefix so the desktop
    // tunnel receives the clean path (e.g. "/agent/quick-actions")
    // instead of the full cloud gateway path which would 404 on the
    // local agent.  Query string is appended AFTER normalization.
    const cleanPath = normalizeTransparentProxyPath(rawPath)
    const agentPath = cleanPath + qs

    const method = c.req.method
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
    const body = hasBody ? await c.req.text() : undefined
    const requestId = generateRequestId()

    const forwardHeaders: Record<string, string> = {}
    const contentType = c.req.header('content-type')
    if (contentType) forwardHeaders['content-type'] = contentType
    const accept = c.req.header('accept')
    if (accept) forwardHeaders['accept'] = accept
    // Video and audio seeking: the runtime already answers 206s, but the range
    // never reached it, so a player could only ever get the whole file.
    const range = c.req.header('range')
    if (range) forwardHeaders['range'] = range
    const ifRange = c.req.header('if-range')
    if (ifRange) forwardHeaders['if-range'] = ifRange

    // Inject the cloud-authenticated userId so the desktop API can
    // identify who is making the request without needing a session
    // cookie.  The desktop's auth middleware trusts this header when
    // the request originates from the local tunnel handler (loopback).
    forwardHeaders['x-tunnel-auth-user-id'] = auth.userId
    if (auth.email) forwardHeaders['x-tunnel-auth-email'] = auth.email
    if (auth.name) forwardHeaders['x-tunnel-auth-name'] = auth.name

    // Forward the chat-session id verbatim so the remote runtime can stamp
    // it on its outbound ai-proxy calls; required for accumulateUsage to
    // route to the same `(projectId, chatSessionId)` bucket our openSession
    // call below uses.
    const transparentChatSessionId = c.req.header('x-chat-session-id') || null
    if (transparentChatSessionId) {
      forwardHeaders['x-chat-session-id'] = transparentChatSessionId
    }

    // Use the pre-normalized path (no query string) for streaming detection
    // to avoid double-normalization bugs.
    const isStreaming = isStreamingRequest(method, cleanPath)

    if (isStreaming) {
      void logRemoteAction({
        instanceId,
        userId: auth.userId,
        action: classifyAction(method, agentPath),
        path: agentPath,
        method,
        summary: 'streaming',
      })

      // Bracket chat turns with a billing session AND persist the
      // assistant `ChatMessage` row.
      //
      // We tee the upstream SSE into `trackUsageFromStream` (the same
      // function the cloud-direct path in `project-chat.ts` uses).
      // That function closes the billing session, persists the
      // accumulated text + parts + tool calls, and is robust to
      // partial turns. Without this tee the tunneled path would only
      // bracket billing and never write `chat_messages.assistant`,
      // so the user would see the reply on screen but lose it on
      // page reload. See `instance-tunnel-chat-persistence.test.ts`.
      //
      // Persistence requires both a `chatSessionId` (header) and the
      // referenced project existing in our DB. When either is missing
      // (legacy probe traffic, mismatched project) we fall through to
      // the billing-only tracker so we never silently mis-attribute
      // tokens to a project we can't validate.
      const isChatTurn = method === 'POST' && cleanPath === '/agent/chat' && !!tunnelProjectId
      let billingSessionHandedOff = false
      let trackerController: ReadableStreamDefaultController<Uint8Array> | null = null
      let trackerStream: ReadableStream<Uint8Array> | null = null
      if (isChatTurn && tunnelProjectId) {
        const tunnelProject = transparentChatSessionId
          ? await prisma.project.findUnique({
              where: { id: tunnelProjectId },
              select: { id: true, workspaceId: true, workingMode: true },
            }).catch(() => null)
          : null

        await openSession(tunnelProjectId, instance.workspaceId, auth.userId, transparentChatSessionId)
        trackerStream = new ReadableStream<Uint8Array>({
          start(c) { trackerController = c },
        })

        if (tunnelProject) {
          // Re-create the body shape `trackUsageFromStream` reads.
          // The header is authoritative for chatSessionId (matches
          // the cloud-direct fix in `project-chat.ts`); we still
          // forward whatever the body claimed for `agentMode` so the
          // log lines match.
          let parsedBodyForTracker: any = {}
          if (body) {
            try { parsedBodyForTracker = JSON.parse(body) } catch { /* not JSON, leave empty */ }
          }
          // EOF without `data-turn-complete` means the tunnel cut the stream,
          // not that the turn ended: the desktop runtime keeps buffering it.
          // Re-attach over the same tunnel so a long turn still lands in the
          // database (SHO-546). Without this hook the tracker could only
          // persist what the cut leg had, and logged `partial (no-resume-hook)`.
          const chatSessionForResume = transparentChatSessionId
          const resumeBasePath = `/agent/chat/${encodeURIComponent(chatSessionForResume || '')}/stream`
          trackUsageFromStream(trackerStream, parsedBodyForTracker, tunnelProject, {
            chatSessionId: transparentChatSessionId,
            resume: chatSessionForResume
              ? async (fromSeq) =>
                  tunnelStreamResponse(instanceId, {
                    type: 'request',
                    requestId: generateRequestId(),
                    method: 'GET',
                    path: `${resumeBasePath}?fromSeq=${fromSeq}`,
                    projectId: tunnelProjectId,
                    workspaceId: tunnelWorkspaceId,
                    acceptBodyEncoding: ['base64'],
                    headers: { ...forwardHeaders, accept: 'text/event-stream' },
                  })
              : undefined,
          }).catch((err) =>
            console.error(`[InstanceTunnel] Usage tracking error for project ${tunnelProjectId}:`, err),
          )
        } else {
          // No chat-session header or project not found in DB —
          // bracket billing only, never persist.
          trackChatStreamForBilling(trackerStream, tunnelProjectId, transparentChatSessionId).catch((err) =>
            console.error(`[InstanceTunnel] Tracking error for project ${tunnelProjectId}:`, err),
          )
        }
        billingSessionHandedOff = true
      }

      try {
        const stream = new ReadableStream({
          start(controller) {
            const { cancel } = sendTunnelStreamRequest(
              instanceId,
              {
                type: 'request',
                requestId,
                method,
                path: agentPath,
                projectId: tunnelProjectId,
                workspaceId: tunnelWorkspaceId,
                acceptBodyEncoding: ['base64'],
                headers: forwardHeaders,
                body,
              },
              (chunk) => {
                if (chunk.type === 'stream-chunk' && chunk.data) {
                  const bytes = new TextEncoder().encode(chunk.data)
                  controller.enqueue(bytes)
                  if (trackerController) {
                    try { trackerController.enqueue(bytes) } catch { /* tracker closed */ }
                  }
                } else if (chunk.type === 'stream-end') {
                  controller.close()
                  if (trackerController) {
                    try { trackerController.close() } catch { /* already closed */ }
                  }
                } else if (chunk.type === 'stream-error') {
                  controller.error(new Error(chunk.error || 'Stream error'))
                  if (trackerController) {
                    try { trackerController.close() } catch { /* already closed */ }
                  }
                }
              },
            )

            const signal = c.req.raw.signal
            if (signal) {
              signal.addEventListener('abort', () => {
                cancel()
                try { controller.close() } catch {}
                if (trackerController) {
                  try { trackerController.close() } catch { /* already closed */ }
                }
              }, { once: true })
            }
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      } catch (err) {
        if (isChatTurn && tunnelProjectId && billingSessionHandedOff && (await hasSession(tunnelProjectId, transparentChatSessionId))) {
          closeSession(tunnelProjectId, { discardPartial: true, chatSessionId: transparentChatSessionId }).catch(() => {})
        }
        throw err
      }
    }

    // Non-streaming: forward and return the response directly
    try {
      const send = (pathWithQuery: string, headers: Record<string, string>) =>
        sendTunnelRequest(instanceId, {
          type: 'request',
          requestId: generateRequestId(),
          method,
          path: pathWithQuery,
          projectId: tunnelProjectId,
          workspaceId: tunnelWorkspaceId,
          acceptBodyEncoding: ['base64'],
          headers,
          body,
        })

      // A whole file cannot cross one frame: window the download and stream it.
      if (isWorkspaceDownloadPath(method, cleanPath)) {
        const response = await relayWorkspaceDownload({
          agentPath,
          headers: forwardHeaders,
          send: async (pathWithQuery, headers) => send(pathWithQuery, headers),
        })
        logRemoteAction({
          instanceId,
          userId: auth.userId,
          action: classifyAction(method, agentPath),
          path: agentPath,
          method,
          result: `HTTP ${response.status}`,
        })
        return response
      }

      const resp = await send(agentPath, forwardHeaders)

      logRemoteAction({
        instanceId,
        userId: auth.userId,
        action: classifyAction(method, agentPath),
        path: agentPath,
        method,
        result: `HTTP ${resp.status}`,
      })

      const responseHeaders: Record<string, string> = {}
      if (resp.headers) {
        for (const [k, v] of Object.entries(resp.headers)) {
          if (v) responseHeaders[k.toLowerCase()] = v
        }
      }
      if (!responseHeaders['content-type']) {
        responseHeaders['content-type'] = 'application/json'
      }

      return new Response(tunnelResponseBody(resp) as BodyInit, {
        status: resp.status,
        headers: responseHeaders,
      })
    } catch (err: any) {
      logRemoteAction({
        instanceId,
        userId: auth.userId,
        action: classifyAction(method, agentPath),
        path: agentPath,
        method,
        result: `error: ${err.message}`,
      })
      return c.json({ error: { code: 'proxy_error', message: err.message } }, 502)
    }
  })

  // GET /instances/:id/echo — End-to-end tunnel integration test endpoint
  router.all('/instances/:id/echo', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!tunnels.has(instance.id) && !await isTunnelConnectedAnywhere(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    const body = c.req.method !== 'GET' ? await c.req.text() : undefined
    const requestId = generateRequestId()
    const start = Date.now()

    try {
      const resp = await sendTunnelRequest(instance.id, {
        type: 'request',
        requestId,
        method: c.req.method,
        path: '/__test/echo',
        body,
      })
      return c.json({
        tunnelRttMs: Date.now() - start,
        echoStatus: resp.status,
        echoBody: resp.body,
      })
    } catch (err: any) {
      return c.json({ error: { code: 'proxy_error', message: err.message } }, 502)
    }
  })

  return router
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Rewrite `lastSeenAt` at least this often. Well inside the 2 min
 * `isRecentlySeenViaHeartbeat` window, so a skipped write never turns a live
 * machine into `offline`.
 */
const HEARTBEAT_WRITE_MIN_INTERVAL_MS = 30_000

/** Key-order independent: Postgres `jsonb` hands keys back in its own order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * `uptime` ticks on every beat and `machine.generatedAt` on every snapshot
 * (20 s); neither is a reason to write the row.
 */
function stableMetadata(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return canonicalJson(metadata)
  const { uptime: _uptime, ...rest } = metadata as Record<string, unknown>
  const machine = rest.machine
  if (machine && typeof machine === 'object' && !Array.isArray(machine)) {
    const { generatedAt: _generatedAt, ...machineRest } = machine as Record<string, unknown>
    rest.machine = machineRest
  }
  return canonicalJson(rest)
}

export function heartbeatNeedsWrite(
  existing: {
    name: string | null
    os: string | null
    arch: string | null
    kind: InstanceKind
    lastSeenAt: Date | null
    metadata: unknown
  },
  next: {
    name: string
    os: string | null
    arch: string | null
    kind: InstanceKind
    metadata: Record<string, unknown> | undefined
  },
  now: number = Date.now(),
): boolean {
  if (!existing.lastSeenAt) return true
  if (now - existing.lastSeenAt.getTime() >= HEARTBEAT_WRITE_MIN_INTERVAL_MS) return true
  if (existing.name !== next.name || existing.os !== next.os || existing.arch !== next.arch) return true
  if (existing.kind !== next.kind) return true
  if (next.metadata !== undefined && stableMetadata(existing.metadata) !== stableMetadata(next.metadata)) return true
  return false
}

/**
 * Is this host's heartbeat recent enough to expect an answer from it?
 *
 * Two idle polls is the same rule `/instances` uses for `heartbeat` vs `offline`:
 * a host that polled inside that window still has a poller running, so a wake it
 * has not answered yet is "not yet", not "away". `now` is injectable so the wake
 * decision can be tested without a clock.
 */
export function isRecentlySeenViaHeartbeat(lastSeenAt: Date | null, now: number = Date.now()): boolean {
  if (!lastSeenAt) return false
  return now - lastSeenAt.getTime() < POLL_INTERVAL_IDLE_S * 2 * 1000
}

/**
 * Live status of one machine. Same three states the `/instances` list renders:
 * `online` while its tunnel WebSocket is up, `heartbeat` while it has polled
 * recently (offline app, or a tunnel that has not been opened yet), `offline`
 * otherwise.
 */
export async function getMachineLiveStatus(
  instanceId: string,
  lastSeenAt: Date | null,
): Promise<'online' | 'heartbeat' | 'offline'> {
  if (tunnels.has(instanceId) || (await isTunnelConnectedAnywhere(instanceId, { retry: false }))) return 'online'
  return isRecentlySeenViaHeartbeat(lastSeenAt) ? 'heartbeat' : 'offline'
}

/**
 * One status for a machine, across every row it has.
 *
 * A machine registered in three workspaces keeps three tunnels; the list shows
 * one entry, so the entry is online when *any* of them is — reading only the
 * representative row would call a live machine offline whenever the row that
 * happened to be picked had not connected yet.
 */
export async function getMachineGroupStatus(
  rows: Array<{ id: string; lastSeenAt: Date | null }>,
): Promise<'online' | 'heartbeat' | 'offline'> {
  const statuses = await Promise.all(rows.map((row) => getMachineLiveStatus(row.id, row.lastSeenAt)))
  if (statuses.includes('online')) return 'online'
  return statuses.includes('heartbeat') ? 'heartbeat' : 'offline'
}

/**
 * True when *this pod* holds a live tunnel for the instance.
 *
 * The machine relay uses it to look across a machine's rows for one that can
 * serve the request: the representative `id` a client holds is stable, and the
 * desktop opens one tunnel per device key, so the two are not necessarily the
 * same row (SHO-241).
 */
export function hasLocalTunnel(instanceId: string): boolean {
  return tunnels.has(instanceId)
}

/**
 * What a wake should do, decided from the host's own heartbeat (SHO-506).
 *
 * A desktop has no push channel: it only sees `wsRequestedAt` on its next
 * heartbeat poll, and an idle one polls every `POLL_INTERVAL_IDLE_S`. So for a
 * host that polled recently the wait is the time to that poll plus a margin,
 * capped at `maxWaitMs`; for a host whose heartbeat is stale nothing can arrive
 * and the old short probe is all there is to try.
 *
 * `lastSeenAt` writes are throttled (`HEARTBEAT_WRITE_MIN_INTERVAL_MS`), which is
 * why this is the worst case rather than a prediction of the next poll.
 */
export function planHostWake(input: {
  tunnelUp: boolean
  lastSeenAt: Date | null
  now?: number
  staleProbeMs?: number
  maxWaitMs?: number
}): { state: 'connected' | 'wait' | 'offline'; waitMs: number } {
  const now = input.now ?? Date.now()
  const maxWaitMs = Math.max(0, input.maxWaitMs ?? WAKE_MAX_WAIT_MS)
  const staleProbeMs = Math.min(Math.max(0, input.staleProbeMs ?? TUNNEL_WAIT_TIMEOUT_MS), maxWaitMs)
  if (input.tunnelUp) return { state: 'connected', waitMs: 0 }
  if (!isRecentlySeenViaHeartbeat(input.lastSeenAt, now)) return { state: 'wait', waitMs: staleProbeMs }
  const untilNextPoll = (input.lastSeenAt as Date).getTime() + POLL_INTERVAL_IDLE_S * 1000 + WAKE_HEARTBEAT_MARGIN_MS - now
  return { state: 'wait', waitMs: Math.min(Math.max(untilNextPoll, WAKE_MIN_WAIT_MS), maxWaitMs) }
}

export type HostWakeState = 'connected' | 'connecting' | 'offline'

export interface HostWakeResult {
  state: HostWakeState
  instanceId: string
  name: string | null
  lastSeenAt: Date | null
  /** Seconds to wait before trying again; only meaningful for `connecting`. */
  retryAfterSeconds: number
}

/**
 * Wake an instance's tunnel for a caller that has to forward a request into it,
 * and say *why* when it does not come up (SHO-506).
 *
 * `connecting` means the desktop is alive (its heartbeat is fresh) and its
 * tunnel is still opening — a caller may retry, and the agent-facing surfaces
 * tell a model to. `offline` means its heartbeat is stale, so the machine is
 * genuinely away. The old code could only say `offline`, which read as "this Mac
 * is off" for a Mac that had polled forty seconds earlier.
 *
 * `maxWaitMs` bounds the wait for callers that must answer promptly (a message
 * that is queued on an offline host, a UI list); without it the wait is the
 * freshness-bounded window from `planHostWake`.
 */
export async function wakeHostTunnel(
  instanceId: string,
  opts: {
    staleProbeMs?: number
    maxWaitMs?: number
    now?: () => number
    _tunnelUp?: (id: string) => Promise<boolean>
    _lastSeenAt?: Date | null
  } = {},
): Promise<HostWakeResult> {
  const now = opts.now ?? Date.now
  const row = await prisma.instance
    .findUnique({ where: { id: instanceId }, select: { name: true, lastSeenAt: true } })
    .catch(() => null)
  const lastSeenAt = opts._lastSeenAt !== undefined ? opts._lastSeenAt : row?.lastSeenAt ?? null
  const name = row?.name ?? null

  const tunnelUp = await (opts._tunnelUp ?? ((id: string) => isTunnelConnectedAnywhere(id, { retry: false })))(instanceId)
  const plannedAt = now()
  const plan = planHostWake({
    tunnelUp,
    lastSeenAt,
    now: plannedAt,
    staleProbeMs: opts.staleProbeMs,
    maxWaitMs: opts.maxWaitMs,
  })
  const result = (state: HostWakeState): HostWakeResult => ({
    state,
    instanceId,
    name,
    lastSeenAt,
    retryAfterSeconds: state === 'connecting' ? WAKE_RETRY_AFTER_S : 0,
  })
  if (plan.state === 'connected') return result('connected')

  if (await requestAndWaitForTunnel(instanceId, plan.waitMs)) return result('connected')
  // A fresh heartbeat is what separates "still opening" from "away": the machine
  // is up either way, only its tunnel missed the window. Read it at the moment the
  // wait was planned, not now: the wait is up to 75s long, so re-reading would
  // turn a host that was up when we started into the non-retryable "offline" just
  // because its own wait pushed that same heartbeat past the freshness line.
  return result(isRecentlySeenViaHeartbeat(lastSeenAt, plannedAt) ? 'connecting' : 'offline')
}

/**
 * Wake an instance's tunnel if it is asleep and wait up to `timeoutMs` for it.
 * Used by the machine-workspace relay, which has to be honest about "offline"
 * instead of forwarding into a void.
 */
export async function ensureTunnelConnected(
  instanceId: string,
  timeoutMs: number = TUNNEL_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  return requestAndWaitForTunnel(instanceId, timeoutMs)
}

/**
 * Ask the desktop to open its tunnel and wait up to `timeoutMs` for the WS.
 *
 * The ownership check is first: a tunnel held by another pod is already up, and
 * asking a connected desktop to reconnect would drop a session that works.
 */
async function requestAndWaitForTunnel(instanceId: string, timeoutMs: number): Promise<boolean> {
  if (tunnels.has(instanceId)) return true

  let remotePod = await getTunnelOwner(instanceId)
  if (remotePod === getPodId()) {
    await evictTunnelOwnership(instanceId).catch(() => {})
    remotePod = null
  }
  if (remotePod) {
    const alive = await verifyPodAlive(remotePod)
    if (alive) return true
    await evictTunnelOwnership(instanceId).catch(() => {})
  }

  await prisma.instance
    .update({ where: { id: instanceId }, data: { wsRequestedAt: new Date() } })
    .catch(() => {})
  void sendPushToInstance(instanceId, { type: 'ws-requested', priority: 'high' })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, TUNNEL_WAIT_POLL_MS))
    if (tunnels.has(instanceId)) return true
    // The loop re-polls every TUNNEL_WAIT_POLL_MS, so the cold-start retry would only add delay.
    if (await getTunnelOwner(instanceId, { retry: false })) return true
  }
  return false
}

// ─── Heartbeat ping for all connected tunnels ───────────────────────────────

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function startTunnelHeartbeat() {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    for (const [instanceId, conn] of tunnels) {
      try {
        conn.ws.send(JSON.stringify({ type: 'ping' }))
        refreshTunnelOwnership(instanceId).catch((err) => {
          console.warn('[RemoteControl] refreshTunnelOwnership failed:', (err as Error).message)
        })
      } catch {
        tunnels.delete(instanceId)
        unregisterTunnelOwnership(instanceId).catch((err) => {
          console.warn('[RemoteControl] unregisterTunnelOwnership failed:', (err as Error).message)
        })
      }
    }
  }, HEARTBEAT_INTERVAL_MS)
}

export function stopTunnelHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

// ─── Exported for testing ────────────────────────────────────────────────────

export const _testing = {
  tunnels,
  activeViewers,
  activeControllers,
  computeNextPollIn,
  isWsRequested,
  /** Put the "this pod is draining" flag back, so one test's drain cannot leak. */
  resetTunnelDrain: () => { drainingTunnels = false },
  isViewerActive,
  markViewerActive,
  markControllerActive,
  getActiveControllers,
  sendLocalTunnelRequest,
  sendLocalTunnelStreamRequest,
  tunnelStreamResponse,
  planHostWake,
  POLL_INTERVAL_IDLE_S,
  POLL_INTERVAL_VIEWER_S,
  POLL_INTERVAL_WS_REQUESTED_S,
  WAKE_MIN_WAIT_MS,
  WAKE_MAX_WAIT_MS,
  WAKE_HEARTBEAT_MARGIN_MS,
  WAKE_RETRY_AFTER_S,
  WS_REQUEST_TTL_MS,
  VIEWER_ACTIVE_TTL_MS,
  STREAM_FIRST_CHUNK_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_MAX_TIMEOUT_MS,
}
