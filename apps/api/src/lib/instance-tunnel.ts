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
}

interface CancelMessage {
  type: 'cancel'
  requestId: string
}

type IncomingMessage = TunnelRequest | CancelMessage | { type: 'ping' }

const DEFAULT_POLL_INTERVAL_S = 60
const WS_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 25_000

let pollTimer: ReturnType<typeof setTimeout> | null = null
let ws: WebSocket | null = null
let wsIdleTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let stopped = false
let currentPollInterval = DEFAULT_POLL_INTERVAL_S
let wsReconnectAttempt = 0
const activeAbortControllers = new Map<string, AbortController>()

function getApiPort(): number {
  return parseInt(process.env.PORT || process.env.API_PORT || '8002', 10)
}

function buildLocalUrl(path: string): string {
  return `http://localhost:${getApiPort()}${path}`
}

function getCloudUrl(): string {
  return (process.env.SHOGO_CLOUD_URL || 'https://studio.shogo.ai').replace(/\/$/, '')
}

function buildWsUrl(): string {
  const cloudUrl = getCloudUrl()
  const wsBase = cloudUrl.replace(/^http/, 'ws')
  const key = process.env.SHOGO_API_KEY!
  const hn = osHostname()
  const os = platform()
  const arch = osArch()
  const name = process.env.SHOGO_INSTANCE_NAME || hn

  return `${wsBase}/api/instances/ws?key=${encodeURIComponent(key)}&hostname=${encodeURIComponent(hn)}&os=${encodeURIComponent(os)}&arch=${encodeURIComponent(arch)}&name=${encodeURIComponent(name)}`
}

async function collectMetadata(): Promise<Record<string, unknown>> {
  const meta: Record<string, unknown> = {
    hostname: osHostname(),
    os: platform(),
    arch: osArch(),
    apiPort: getApiPort(),
    uptime: process.uptime(),
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

async function sendHeartbeat(): Promise<{ nextPollIn: number; wsRequested: boolean }> {
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

  return resp.json()
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
    currentPollInterval = result.nextPollIn || DEFAULT_POLL_INTERVAL_S

    if (result.wsRequested && !ws) {
      console.log('[InstanceTunnel] Cloud requested WebSocket — connecting...')
      connectWs()
      return
    }
  } catch (err: any) {
    console.error(`[InstanceTunnel] Heartbeat error: ${err.message}`)
    currentPollInterval = DEFAULT_POLL_INTERVAL_S
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
    const url = buildLocalUrl(msg.path)
    const init: RequestInit = {
      method: msg.method,
      headers: msg.headers,
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
  console.log(`[InstanceTunnel] Opening WebSocket to ${url.replace(/key=[^&]+/, 'key=***')}`)

  try {
    ws = new WebSocket(url)
  } catch (err: any) {
    console.error(`[InstanceTunnel] WebSocket creation failed: ${err.message}`)
    ws = null
    scheduleNextPoll(5)
    return
  }

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
    }
  }

  ws.onclose = (event) => {
    console.log(`[InstanceTunnel] WebSocket closed: code=${event.code} reason=${event.reason || 'none'}`)
    cleanupWs()
    scheduleNextPoll(currentPollInterval)
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
  return ws !== null && ws.readyState === WebSocket.OPEN
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
  buildWsUrl,
  DEFAULT_POLL_INTERVAL_S,
  get currentPollInterval() { return currentPollInterval },
  set currentPollInterval(v: number) { currentPollInterval = v },
  get ws() { return ws },
  get stopped() { return stopped },
}
