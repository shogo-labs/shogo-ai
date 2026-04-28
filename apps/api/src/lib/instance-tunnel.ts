// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instance Tunnel Client
 *
 * Runs on local Shogo instances to maintain presence with Shogo Cloud.
 * Uses HTTP heartbeat polling (default 60s) to report status and check
 * if the cloud wants an interactive session. When wsRequested, opens
 * an on-demand WebSocket for bidirectional command proxying. Closes the
 * WebSocket when the session ends and returns to polling.
 */

import { hostname as osHostname, platform, arch as osArch } from 'os'
import { getRuntimeManager } from './runtime'

interface TunnelRequest {
  type: 'request'
  requestId: string
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
  stream?: boolean
  projectId?: string
}

interface CancelMessage {
  type: 'cancel'
  requestId: string
}

type IncomingMessage = TunnelRequest | CancelMessage | { type: 'ping' } | { type: string }

type TunnelWebSocketInit = {
  headers: Record<string, string>
}

type TunnelWebSocketConstructor = new (url: string, init: TunnelWebSocketInit) => WebSocket

type RuntimeWithBunWebSocketHeaders = typeof globalThis & {
  Bun?: unknown
  process?: {
    versions?: {
      bun?: string
    }
  }
}

type HeartbeatResponse = {
  instanceId?: string
  nextPollIn: number
  wsRequested: boolean
  wsUrl?: string
}

export class TunnelWebSocketHeaderSupportError extends Error {
  code = 'TUNNEL_WS_HEADERS_UNSUPPORTED' as const

  constructor() {
    super(
      'Tunnel WebSocket auth requires Bun WebSocket header support. ' +
        'This runtime does not advertise Bun, so Authorization headers may be dropped.'
    )
    this.name = 'TunnelWebSocketHeaderSupportError'
  }
}

const DEFAULT_POLL_INTERVAL_S = 60
const AUTH_FAILURE_BACKOFF_S = 300 // 5 min once we hit AUTH_FAILURE_THRESHOLD consecutive 401/403s
const AUTH_FAILURE_THRESHOLD = 3
const AUTH_RECOVERY_SUCCESS_THRESHOLD = AUTH_FAILURE_THRESHOLD
const WS_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 25_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 60_000

/**
 * Protocol version advertised in heartbeat metadata. Bump when new
 * tunnel message types or proxy endpoints are added so mobile can
 * gate features for older desktops.
 *
 * Version history:
 *   1 — Initial tunnel with chat proxy
 *   2 — Transparent proxy (any HTTP request)
 *   3 — Remote state sync (projects, history routed through tunnel)
 */
export const TUNNEL_PROTOCOL_VERSION = 3

let pollTimer: ReturnType<typeof setTimeout> | null = null
let ws: WebSocket | null = null
let wsIdleTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let stopped = false
let currentPollInterval = DEFAULT_POLL_INTERVAL_S
let wsReconnectAttempt = 0
let lastHeartbeatError: string | null = null
let consecutiveAuthFailures = 0
let consecutiveAuthSuccesses = 0
// Public WS endpoint published by the cloud `heartbeat` response.
// In staging / prod this is a non-DomainMapping host
// (`wss://tunnel.staging.shogo.ai` / `wss://tunnel.shogo.ai`) that
// supports WebSocket Upgrade end-to-end. When the cloud doesn't supply
// a value (older API or self-hosted), we fall back to deriving it from
// SHOGO_CLOUD_URL.
let serverPublishedWsUrl: string | null = null
const activeAbortControllers = new Map<string, AbortController>()

function getReconnectDelay(): number {
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, wsReconnectAttempt), BACKOFF_MAX_MS)
  const jitter = delay * 0.2 * Math.random()
  return delay + jitter
}

function getApiPort(): number {
  return parseInt(process.env.PORT || process.env.API_PORT || '8002', 10)
}

function splitPathAndQuery(pathWithQuery: string): { pathname: string; search: string } {
  const q = pathWithQuery.indexOf('?')
  if (q === -1) return { pathname: pathWithQuery, search: '' }
  return { pathname: pathWithQuery.slice(0, q), search: pathWithQuery.slice(q) }
}

/**
 * Resolve where to send a tunneled path. /agent/* goes to the agent-runtime HTTP
 * server (not the desktop API). If the runtime is cold, start it — same as
 * app.all('/api/projects/:id/agent-proxy/*') in server.ts — so quick-actions
 * and chat do not fall through to GET /agent/* on the API port (404).
 */
async function resolveLocalAgentUrl(pathWithQuery: string, projectId?: string): Promise<string> {
  const { pathname, search } = splitPathAndQuery(pathWithQuery)
  const path = pathname || '/'

  if (path.startsWith('/agent/') || path === '/agent') {
    try {
      const manager = getRuntimeManager()
      const candidates = projectId ? [projectId] : manager.getActiveProjects()
      for (const pid of candidates) {
        try {
          let runtime = manager.status(pid)
          if (!runtime?.agentPort || runtime.status !== 'running') {
            runtime = await manager.start(pid)
          }
          if (runtime?.agentPort && runtime.status === 'running') {
            return `http://localhost:${runtime.agentPort}${path}${search}`
          }
        } catch (err: any) {
          console.warn(`[InstanceTunnel] Agent URL resolve failed for ${pid}: ${err?.message ?? err}`)
          if (projectId) break
        }
      }
    } catch (err: any) {
      console.warn(`[InstanceTunnel] resolveLocalAgentUrl: ${err?.message ?? err}`)
    }
  }
  return `http://localhost:${getApiPort()}${path}${search}`
}

function getCloudUrl(): string {
  return (process.env.SHOGO_CLOUD_URL || 'https://studio.shogo.ai').replace(/\/$/, '')
}

function supportsWebSocketConstructorHeaders(
  runtime: RuntimeWithBunWebSocketHeaders = globalThis as RuntimeWithBunWebSocketHeaders,
): boolean {
  return typeof runtime.Bun !== 'undefined' || typeof runtime.process?.versions?.bun === 'string'
}

function createTunnelWebSocket(
  url: string,
  init: TunnelWebSocketInit,
  runtime: RuntimeWithBunWebSocketHeaders = globalThis as RuntimeWithBunWebSocketHeaders,
): WebSocket {
  if (!supportsWebSocketConstructorHeaders(runtime)) {
    throw new TunnelWebSocketHeaderSupportError()
  }

  const WebSocketCtor = WebSocket as unknown as TunnelWebSocketConstructor
  return new WebSocketCtor(url, init)
}

/**
 * Resolve the base URL to use for the on-demand tunnel WebSocket.
 *
 * Priority:
 *   1. `SHOGO_TUNNEL_WS_URL` env (explicit override; for ops / debugging)
 *   2. `wsUrl` field from the most recent heartbeat response (the
 *      canonical signal from the cloud — points at a non-DomainMapping
 *      host like `wss://tunnel.staging.shogo.ai`)
 *   3. Derived from `SHOGO_CLOUD_URL` (legacy / self-hosted path; this
 *      is what currently fails on Knative DomainMapping clusters and
 *      is the reason this fallback exists at all)
 */
function getWsBaseUrl(): string {
  const explicit = (process.env.SHOGO_TUNNEL_WS_URL || '').trim()
  if (explicit) return explicit.replace(/\/$/, '')
  if (serverPublishedWsUrl) return serverPublishedWsUrl.replace(/\/$/, '')
  return getCloudUrl().replace(/^http/, 'ws')
}

function buildWsUrl(): string {
  // Path-only URL — credentials and identity now travel as request
  // headers (see connectWs), so they do NOT end up in Cloudflare /
  // Kourier access logs.
  return `${getWsBaseUrl()}/api/instances/ws`
}

async function collectMetadata(): Promise<Record<string, unknown>> {
  const meta: Record<string, unknown> = {
    hostname: osHostname(),
    os: platform(),
    arch: osArch(),
    apiPort: getApiPort(),
    uptime: process.uptime(),
    protocolVersion: TUNNEL_PROTOCOL_VERSION,
    apiVersion: process.env.npm_package_version || '0.1.0',
    tunnelStatus: ws?.readyState === WebSocket.OPEN ? 'connected' : 'polling',
  }

  try {
    const manager = getRuntimeManager()
    const projectIds = manager.getActiveProjects()
    meta.activeProjects = projectIds.length
    meta.projects = projectIds.map((projectId) => {
      const s = manager.status(projectId)
      return {
        projectId,
        status: s?.status || 'unknown',
        agentPort: s?.agentPort,
      }
    })
  } catch {
    meta.activeProjects = 0
  }

  return meta
}

// ─── HTTP Heartbeat Loop ────────────────────────────────────────────────────

async function sendHeartbeat(): Promise<HeartbeatResponse> {
  const cloudUrl = getCloudUrl()
  const key = process.env.SHOGO_API_KEY!
  const metadata = await collectMetadata()

  const resp = await fetch(`${cloudUrl}/api/instances/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
    },
    body: JSON.stringify({
      hostname: osHostname(),
      name: process.env.SHOGO_INSTANCE_NAME || osHostname(),
      os: platform(),
      arch: osArch(),
      metadata,
    }),
  })

  if (!resp.ok) {
    throw new Error(`Heartbeat failed: HTTP ${resp.status}`)
  }

  const data = await resp.json() as HeartbeatResponse

  // Cache the server-published tunnel WS URL so connectWs() picks it up
  // without a second round-trip. Treat empty / falsy as "no override".
  if (typeof data.wsUrl === 'string' && data.wsUrl.length > 0) {
    if (data.wsUrl !== serverPublishedWsUrl) {
      console.log(`[InstanceTunnel] Cloud advertised tunnel WS URL: ${data.wsUrl}`)
    }
    serverPublishedWsUrl = data.wsUrl
  }

  return data
}

function scheduleNextPoll(intervalS?: number) {
  if (stopped) return
  if (pollTimer) clearTimeout(pollTimer)
  const delay = (intervalS ?? currentPollInterval) * 1000
  pollTimer = setTimeout(heartbeatLoop, delay)
}

async function heartbeatLoop() {
  if (stopped) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    scheduleNextPoll(currentPollInterval)
    return
  }

  try {
    const result = await sendHeartbeat()
    const nextPollIn = result.nextPollIn || DEFAULT_POLL_INTERVAL_S
    const wasInAuthBackoff = consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD

    if (wasInAuthBackoff) {
      consecutiveAuthSuccesses++
      if (consecutiveAuthSuccesses < AUTH_RECOVERY_SUCCESS_THRESHOLD) {
        currentPollInterval = AUTH_FAILURE_BACKOFF_S
        scheduleNextPoll()
        return
      }
    }

    currentPollInterval = nextPollIn
    if (lastHeartbeatError) {
      console.log('[InstanceTunnel] Heartbeat recovered')
      lastHeartbeatError = null
    }
    consecutiveAuthFailures = 0
    consecutiveAuthSuccesses = 0

    if (result.wsRequested && !ws) {
      console.log('[InstanceTunnel] Cloud requested WebSocket — connecting...')
      connectWs()
      return
    }
  } catch (err: any) {
    const isAuthFailure = /HTTP 40[13]\b/.test(err.message || '')
    if (isAuthFailure) {
      consecutiveAuthFailures++
      consecutiveAuthSuccesses = 0
    } else {
      consecutiveAuthFailures = 0
      consecutiveAuthSuccesses = 0
    }
    if (err.message !== lastHeartbeatError) {
      console.error(`[InstanceTunnel] Heartbeat error: ${err.message}`)
      lastHeartbeatError = err.message
    }
    if (consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD) {
      if (currentPollInterval !== AUTH_FAILURE_BACKOFF_S) {
        console.warn(
          `[InstanceTunnel] ${consecutiveAuthFailures} consecutive auth failures \u2014 backing off to ${AUTH_FAILURE_BACKOFF_S}s. ` +
            `Run \`shogo login\` once you've issued a fresh API key.`
        )
      }
      currentPollInterval = AUTH_FAILURE_BACKOFF_S
    } else {
      currentPollInterval = DEFAULT_POLL_INTERVAL_S
    }
  }

  scheduleNextPoll()
}

// ─── On-demand WebSocket ────────────────────────────────────────────────────

async function handleRequest(msg: TunnelRequest) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  resetWsIdleTimer()

  const controller = new AbortController()
  activeAbortControllers.set(msg.requestId, controller)

  try {
    const url = await resolveLocalAgentUrl(msg.path, msg.projectId)
    const headers = { ...(msg.headers || {}) }

    // If forwarding to local agent runtime, inject the runtime token.
    // We do this locally so the token is derived using THIS machine's
    // local signing secret (which may differ from the cloud gateway's secret).
    if (msg.projectId && (msg.path.startsWith('/agent/') || msg.path === '/agent')) {
      const { deriveRuntimeToken } = await import('./runtime-token')
      headers['x-runtime-token'] = deriveRuntimeToken(msg.projectId)
    }

    const init: RequestInit = {
      method: msg.method,
      headers: headers,
      signal: controller.signal,
    }
    if (msg.body && msg.method !== 'GET' && msg.method !== 'HEAD') {
      init.body = msg.body
    }

    const resp = await fetch(url, init)

    if (msg.stream) {
      const reader = resp.body?.getReader()
      if (!reader) {
        ws.send(JSON.stringify({
          type: 'stream-error',
          requestId: msg.requestId,
          error: 'No response body for stream',
        }))
        return
      }

      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (ws.readyState !== WebSocket.OPEN) break

          ws.send(JSON.stringify({
            type: 'stream-chunk',
            requestId: msg.requestId,
            data: decoder.decode(value, { stream: true }),
          }))
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'stream-end',
            requestId: msg.requestId,
          }))
        }
      } catch (err: any) {
        if (err.name !== 'AbortError' && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'stream-error',
            requestId: msg.requestId,
            error: err.message,
          }))
        }
      }
    } else {
      const body = await resp.text()
      const headers: Record<string, string> = {}
      resp.headers.forEach((v, k) => { headers[k] = v })

      ws.send(JSON.stringify({
        type: 'response',
        requestId: msg.requestId,
        status: resp.status,
        headers,
        body,
      }))
    }
  } catch (err: any) {
    if (err.name === 'AbortError') return

    if (ws.readyState === WebSocket.OPEN) {
      const payload = msg.stream
        ? { type: 'stream-error', requestId: msg.requestId, error: err.message }
        : { type: 'response', requestId: msg.requestId, status: 502, body: JSON.stringify({ error: err.message }) }
      ws.send(JSON.stringify(payload))
    }
  } finally {
    activeAbortControllers.delete(msg.requestId)
  }
}

function resetWsIdleTimer() {
  if (wsIdleTimer) clearTimeout(wsIdleTimer)
  wsIdleTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[InstanceTunnel] WebSocket idle timeout — closing, returning to polling')
      ws.close(1000, 'Idle timeout')
    }
  }, WS_IDLE_TIMEOUT_MS)
}

function startWsHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      const metadata = await collectMetadata()
      ws.send(JSON.stringify({ type: 'heartbeat', metadata }))
    } catch {}
  }, HEARTBEAT_INTERVAL_MS)
}

function connectWs() {
  if (stopped || ws) return

  const url = buildWsUrl()
  const key = process.env.SHOGO_API_KEY!
  const hn = osHostname()
  const os = platform()
  const arch = osArch()
  const name = process.env.SHOGO_INSTANCE_NAME || hn

  console.log(`[InstanceTunnel] Opening WebSocket to ${url} (hostname=${hn})`)

  // Bun's WebSocket constructor accepts a `headers` option; this lets us
  // ship the API key and identity in request headers rather than the
  // query string, so Cloudflare / Kourier access logs never capture
  // the secret.
  //
  // The fallback `key=` query path on the server side stays in place
  // for older desktops that don't run on Bun yet; once everyone is
  // migrated we can drop it.
  const wsInit = {
    headers: {
      'Authorization': `Bearer ${key}`,
      'x-shogo-hostname': hn,
      'x-shogo-name': name,
      'x-shogo-os': os,
      'x-shogo-arch': arch,
    },
  }

  let socket: WebSocket
  try {
    socket = createTunnelWebSocket(url, wsInit)
  } catch (err: any) {
    console.error(`[InstanceTunnel] WebSocket creation failed: ${err.message}`)
    ws = null
    scheduleNextPoll(5)
    return
  }
  ws = socket

  ws.onopen = () => {
    console.log('[InstanceTunnel] WebSocket connected — session active')
    wsReconnectAttempt = 0
    startWsHeartbeat()
    resetWsIdleTimer()
  }

  ws.onmessage = (event) => {
    let msg: IncomingMessage
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
    } catch {
      return
    }

    if (msg.type === 'ping') {
      ws?.send(JSON.stringify({ type: 'pong' }))
      resetWsIdleTimer()
      return
    }

    if (msg.type === 'cancel') {
      const controller = activeAbortControllers.get((msg as CancelMessage).requestId)
      if (controller) controller.abort()
      return
    }

    if (msg.type === 'request') {
      handleRequest(msg as TunnelRequest).catch((err) => {
        console.error(`[InstanceTunnel] Error handling request: ${err.message}`)
      })
      return
    }

    // Unknown message types are silently ignored for forward compatibility
  }

  ws.onclose = (event) => {
    console.log(`[InstanceTunnel] WebSocket closed: code=${event.code} reason=${event.reason || 'none'}`)
    cleanupWs()

    if (stopped) return

    if (event.code === 1000 || event.code === 4000) {
      scheduleNextPoll(currentPollInterval)
    } else {
      wsReconnectAttempt++
      const delay = getReconnectDelay()
      console.log(`[InstanceTunnel] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${wsReconnectAttempt})`)
      scheduleNextPoll(Math.ceil(delay / 1000))
    }
  }

  ws.onerror = (event) => {
    console.error('[InstanceTunnel] WebSocket error:', (event as any).message || 'unknown')
  }
}

function cleanupWs() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (wsIdleTimer) {
    clearTimeout(wsIdleTimer)
    wsIdleTimer = null
  }
  for (const [, controller] of activeAbortControllers) {
    controller.abort()
  }
  activeAbortControllers.clear()
  ws = null
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startInstanceTunnel() {
  if (!process.env.SHOGO_API_KEY) {
    console.log('[InstanceTunnel] No SHOGO_API_KEY set, skipping tunnel')
    return
  }

  stopped = false
  wsReconnectAttempt = 0
  currentPollInterval = DEFAULT_POLL_INTERVAL_S
  console.log('[InstanceTunnel] Starting heartbeat polling to Shogo Cloud...')
  heartbeatLoop()
}

export function isTunnelConnected(): boolean {
  if (ws !== null && ws.readyState === WebSocket.OPEN) return true
  // Heartbeat polling keeps the instance reachable even without an open WebSocket.
  // The WS is on-demand (only opens when a remote controller is active).
  return !stopped && !!process.env.SHOGO_API_KEY && lastHeartbeatError === null && pollTimer !== null
}

export function stopInstanceTunnel() {
  stopped = true
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  cleanupWs()
  if (ws) {
    ws.close(1000, 'Tunnel stopped')
    ws = null
  }
  console.log('[InstanceTunnel] Tunnel stopped')
}

// Exported for testing
export const _testing = {
  sendHeartbeat,
  heartbeatLoop,
  connectWs,
  cleanupWs,
  getCloudUrl,
  supportsWebSocketConstructorHeaders,
  createTunnelWebSocket,
  getWsBaseUrl,
  buildWsUrl,
  getReconnectDelay,
  DEFAULT_POLL_INTERVAL_S,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  TUNNEL_PROTOCOL_VERSION,
  get currentPollInterval() { return currentPollInterval },
  set currentPollInterval(v: number) { currentPollInterval = v },
  get wsReconnectAttempt() { return wsReconnectAttempt },
  set wsReconnectAttempt(v: number) { wsReconnectAttempt = v },
  get ws() { return ws },
  get stopped() { return stopped },
  get serverPublishedWsUrl() { return serverPublishedWsUrl },
  set serverPublishedWsUrl(v: string | null) { serverPublishedWsUrl = v },
}
