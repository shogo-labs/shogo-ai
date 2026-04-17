// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tunnel DB Layer — Redis-less Cross-Pod Coordination
 *
 * When Redis is not available (e.g. staging without a Redis deployment),
 * these helpers provide equivalent functionality via Postgres + direct
 * pod-to-pod HTTP relay:
 *
 *   • Viewer presence  → `active_viewers` table (replaces Redis `viewer:*`)
 *   • Tunnel ownership → `tunnel_ownership` table (replaces `tunnel:*:pod`)
 *   • Request relay    → HTTP POST to owning pod IP (replaces pub/sub)
 *
 * `tunnel-redis.ts` detects the Redis-unavailable condition and forwards
 * every helper to this module, so callers (`routes/instances.ts`) never
 * need to know which backend is in use.
 */
import { prisma } from './prisma'

// ─── Constants ───────────────────────────────────────────────────────────────

const VIEWER_TTL_MS = 2 * 60 * 1000
const OWNERSHIP_STALE_MS = 90_000 // refreshed every 25 s by startTunnelHeartbeat
const RELAY_TIMEOUT_MS = 30_000
const STREAM_RELAY_TIMEOUT_MS = 600_000
const POD_ALIVE_TIMEOUT_MS = 3_000

// ─── Pod identity (matches tunnel-redis.ts) ──────────────────────────────────

const POD_ID = process.env.HOSTNAME || crypto.randomUUID()
const POD_IP = process.env.POD_IP || '127.0.0.1'
const INTERNAL_RELAY_PORT = parseInt(process.env.API_PORT || process.env.PORT || '8002', 10)
const INTERNAL_RELAY_SECRET = process.env.INTERNAL_RELAY_SECRET || ''

export function getLocalPodIp(): string {
  return POD_IP
}

function podBaseUrl(podIp: string): string {
  return `http://${podIp}:${INTERNAL_RELAY_PORT}`
}

function relayAuthHeaders(): Record<string, string> {
  // When no shared secret is configured (single-pod dev) we still emit a
  // header so the internal endpoint can detect the "local, trust me" case.
  // In a real multi-pod deployment, set INTERNAL_RELAY_SECRET so pods can
  // reject unauthenticated traffic that somehow makes it through NetworkPolicy.
  return INTERNAL_RELAY_SECRET
    ? { 'x-internal-relay-secret': INTERNAL_RELAY_SECRET }
    : {}
}

export function verifyInternalRelaySecret(header: string | null | undefined): boolean {
  if (!INTERNAL_RELAY_SECRET) return true // single-pod dev (no shared secret configured)
  return header === INTERNAL_RELAY_SECRET
}

// ─── Viewer presence ─────────────────────────────────────────────────────────

export async function markViewerActiveDb(workspaceId: string): Promise<void> {
  try {
    await prisma.activeViewer.upsert({
      where: { workspaceId },
      update: { lastSeenAt: new Date() },
      create: { workspaceId, lastSeenAt: new Date() },
    })
  } catch (err) {
    console.warn('[TunnelDb] markViewerActiveDb failed:', (err as Error).message)
  }
}

export async function isViewerActiveDb(workspaceId: string): Promise<boolean> {
  try {
    const row = await prisma.activeViewer.findUnique({ where: { workspaceId } })
    if (!row) return false
    return Date.now() - row.lastSeenAt.getTime() < VIEWER_TTL_MS
  } catch (err) {
    console.warn('[TunnelDb] isViewerActiveDb failed:', (err as Error).message)
    return false
  }
}

// ─── Tunnel ownership ────────────────────────────────────────────────────────

export async function registerTunnelOwnershipDb(instanceId: string): Promise<void> {
  try {
    await prisma.tunnelOwnership.upsert({
      where: { instanceId },
      update: { podId: POD_ID, podIp: POD_IP, refreshedAt: new Date() },
      create: {
        instanceId,
        podId: POD_ID,
        podIp: POD_IP,
        acquiredAt: new Date(),
        refreshedAt: new Date(),
      },
    })
  } catch (err) {
    console.warn('[TunnelDb] registerTunnelOwnershipDb failed:', (err as Error).message)
  }
}

export async function unregisterTunnelOwnershipDb(instanceId: string): Promise<void> {
  try {
    await prisma.tunnelOwnership.deleteMany({
      where: { instanceId, podId: POD_ID },
    })
  } catch (err) {
    console.warn('[TunnelDb] unregisterTunnelOwnershipDb failed:', (err as Error).message)
  }
}

export async function evictTunnelOwnershipDb(instanceId: string): Promise<void> {
  try {
    await prisma.tunnelOwnership.delete({ where: { instanceId } }).catch(() => {})
  } catch (err) {
    console.warn('[TunnelDb] evictTunnelOwnershipDb failed:', (err as Error).message)
  }
}

export async function refreshTunnelOwnershipDb(instanceId: string): Promise<void> {
  try {
    await prisma.tunnelOwnership.updateMany({
      where: { instanceId, podId: POD_ID },
      data: { refreshedAt: new Date() },
    })
  } catch (err) {
    console.warn('[TunnelDb] refreshTunnelOwnershipDb failed:', (err as Error).message)
  }
}

export interface TunnelOwnerRef {
  podId: string
  podIp: string
}

export async function getTunnelOwnerDb(instanceId: string): Promise<TunnelOwnerRef | null> {
  try {
    const row = await prisma.tunnelOwnership.findUnique({ where: { instanceId } })
    if (!row) return null
    if (Date.now() - row.refreshedAt.getTime() > OWNERSHIP_STALE_MS) {
      // Stale row — treat as no owner. Cleanup happens separately to avoid
      // doing a DELETE in the read path.
      return null
    }
    return { podId: row.podId, podIp: row.podIp }
  } catch (err) {
    console.warn('[TunnelDb] getTunnelOwnerDb failed:', (err as Error).message)
    return null
  }
}

export async function isTunnelConnectedAnywhereDb(instanceId: string): Promise<boolean> {
  return (await getTunnelOwnerDb(instanceId)) !== null
}

// Background janitor — run this from a single pod periodically. Currently
// invoked from `tunnel-redis.ts` in the same interval as the ping heartbeat.
export async function cleanupStaleTunnelOwnershipsDb(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - OWNERSHIP_STALE_MS)
    const res = await prisma.tunnelOwnership.deleteMany({
      where: { refreshedAt: { lt: cutoff } },
    })
    return res.count
  } catch (err) {
    console.warn('[TunnelDb] cleanupStaleTunnelOwnershipsDb failed:', (err as Error).message)
    return 0
  }
}

// ─── Pod liveness probe (HTTP) ──────────────────────────────────────────────

export async function verifyPodAliveDb(podIp: string): Promise<boolean> {
  if (podIp === POD_IP) return true
  try {
    const resp = await fetch(`${podBaseUrl(podIp)}/api/internal/tunnel-alive`, {
      method: 'GET',
      headers: relayAuthHeaders(),
      signal: AbortSignal.timeout(POD_ALIVE_TIMEOUT_MS),
    })
    return resp.ok
  } catch {
    return false
  }
}

// ─── Cross-pod relay over HTTP ──────────────────────────────────────────────

export interface RelayRequestBody {
  instanceId: string
  request: {
    type: 'request'
    requestId: string
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
    projectId?: string
  }
}

export interface RelayResponseShape {
  type: 'response'
  requestId: string
  status: number
  headers?: Record<string, string>
  body?: string
}

export async function relayTunnelRequestDb(
  owner: TunnelOwnerRef,
  instanceId: string,
  request: RelayRequestBody['request'],
): Promise<RelayResponseShape> {
  const resp = await fetch(`${podBaseUrl(owner.podIp)}/api/internal/tunnel-relay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...relayAuthHeaders(),
    },
    body: JSON.stringify({ instanceId, request } satisfies RelayRequestBody),
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  })

  if (!resp.ok) {
    if (resp.status === 404 || resp.status === 503) {
      throw new Error('Instance is offline')
    }
    throw new Error(`Relay returned HTTP ${resp.status}`)
  }

  return (await resp.json()) as RelayResponseShape
}

export interface StreamRelayChunkShape {
  type: 'stream-chunk' | 'stream-end' | 'stream-error'
  requestId: string
  data?: string
  error?: string
}

export function relayTunnelStreamRequestDb(
  owner: TunnelOwnerRef,
  instanceId: string,
  request: RelayRequestBody['request'],
  onChunk: (chunk: StreamRelayChunkShape) => void,
): { cancel: () => void } {
  const controller = new AbortController()
  let finished = false

  const timeoutTimer = setTimeout(() => {
    if (finished) return
    finished = true
    controller.abort()
    onChunk({
      type: 'stream-error',
      requestId: request.requestId,
      error: 'Cross-pod stream relay timed out',
    })
  }, STREAM_RELAY_TIMEOUT_MS)

  ;(async () => {
    let resp: Response
    try {
      resp = await fetch(
        `${podBaseUrl(owner.podIp)}/api/internal/tunnel-relay/stream`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...relayAuthHeaders(),
          },
          body: JSON.stringify({ instanceId, request } satisfies RelayRequestBody),
          signal: controller.signal,
        },
      )
    } catch (err: any) {
      if (finished) return
      finished = true
      clearTimeout(timeoutTimer)
      if (err?.name === 'AbortError') return
      onChunk({
        type: 'stream-error',
        requestId: request.requestId,
        error: err?.message ?? 'Relay fetch failed',
      })
      return
    }

    if (!resp.ok || !resp.body) {
      if (finished) return
      finished = true
      clearTimeout(timeoutTimer)
      onChunk({
        type: 'stream-error',
        requestId: request.requestId,
        error: `Relay returned HTTP ${resp.status}`,
      })
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Newline-delimited JSON framing (one chunk per line).
        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx)
          buffer = buffer.slice(newlineIdx + 1)
          if (!line) continue
          try {
            const chunk = JSON.parse(line) as StreamRelayChunkShape
            onChunk(chunk)
            if (chunk.type === 'stream-end' || chunk.type === 'stream-error') {
              finished = true
              clearTimeout(timeoutTimer)
              try { reader.cancel() } catch {}
              return
            }
          } catch {
            // Malformed line — ignore.
          }
        }
      }
      if (!finished) {
        finished = true
        clearTimeout(timeoutTimer)
        onChunk({ type: 'stream-end', requestId: request.requestId })
      }
    } catch (err: any) {
      if (finished) return
      finished = true
      clearTimeout(timeoutTimer)
      if (err?.name === 'AbortError') return
      onChunk({
        type: 'stream-error',
        requestId: request.requestId,
        error: err?.message ?? 'Relay stream read failed',
      })
    }
  })()

  return {
    cancel: () => {
      if (finished) return
      finished = true
      clearTimeout(timeoutTimer)
      controller.abort()
    },
  }
}
