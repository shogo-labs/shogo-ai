// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instance Tunnel Client
 *
 * Runs on local Shogo instances to establish an outbound WebSocket
 * connection to Shogo Cloud. The cloud can then proxy dashboard
 * commands back through this tunnel to the local agent runtime.
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

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000
const HEARTBEAT_INTERVAL_MS = 25_000

let ws: WebSocket | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let stopped = false
const activeAbortControllers = new Map<string, AbortController>()

function getApiPort(): number {
  return parseInt(process.env.PORT || process.env.API_PORT || '8002', 10)
}

function buildLocalUrl(path: string): string {
  return `http://localhost:${getApiPort()}${path}`
}

function buildWsUrl(): string {
  const cloudUrl = (process.env.SHOGO_CLOUD_URL || 'https://studio.shogo.ai').replace(/\/$/, '')
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

async function handleRequest(msg: TunnelRequest) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return

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

function scheduleReconnect() {
  if (stopped) return
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS)
  reconnectAttempt++
  console.log(`[InstanceTunnel] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`)
  reconnectTimer = setTimeout(connect, delay)
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      const metadata = await collectMetadata()
      ws.send(JSON.stringify({ type: 'heartbeat', metadata }))
    } catch {}
  }, HEARTBEAT_INTERVAL_MS)
}

function connect() {
  if (stopped) return

  const url = buildWsUrl()
  console.log(`[InstanceTunnel] Connecting to ${url.replace(/key=[^&]+/, 'key=***')}`)

  try {
    ws = new WebSocket(url)
  } catch (err: any) {
    console.error(`[InstanceTunnel] WebSocket creation failed: ${err.message}`)
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    console.log('[InstanceTunnel] Connected to Shogo Cloud')
    reconnectAttempt = 0
    startHeartbeat()
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
    console.log(`[InstanceTunnel] Disconnected: code=${event.code} reason=${event.reason || 'none'}`)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    ws = null
    scheduleReconnect()
  }

  ws.onerror = (event) => {
    console.error('[InstanceTunnel] WebSocket error:', (event as any).message || 'unknown')
  }
}

export function startInstanceTunnel() {
  if (!process.env.SHOGO_API_KEY) {
    console.log('[InstanceTunnel] No SHOGO_API_KEY set, skipping tunnel')
    return
  }

  stopped = false
  reconnectAttempt = 0
  console.log('[InstanceTunnel] Starting instance tunnel to Shogo Cloud...')
  connect()
}

export function isTunnelConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

export function stopInstanceTunnel() {
  stopped = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  for (const [, controller] of activeAbortControllers) {
    controller.abort()
  }
  activeAbortControllers.clear()
  if (ws) {
    ws.close(1000, 'Tunnel stopped')
    ws = null
  }
  console.log('[InstanceTunnel] Tunnel stopped')
}
