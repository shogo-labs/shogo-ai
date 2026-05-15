// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * High-level helper that relays an agent-proxy request through a paired
 * Instance's WebSocket tunnel — i.e. the on-VPS / on-laptop `shogo worker`.
 *
 * Why this exists as a separate module:
 *   - The cloud `/api/projects/:id/agent-proxy/*` handler in `server.ts` and
 *     the legacy transparent proxy `/api/instances/:id/p/*` in
 *     `routes/instances.ts` both need to forward a normalized agent
 *     path into the tunnel and stream the SSE response back to the caller.
 *   - That logic was 100+ lines of streaming + abort + billing-tracker
 *     plumbing duplicated across the two routes. Folding it here keeps
 *     `server.ts:agent-proxy` thin and lets us test the relay in isolation.
 *
 * The function is intentionally narrow: it only knows how to fan a
 * normalized inner agent path (e.g. `/agent/chat`, `/agent/channels/webhook/incoming`)
 * over the tunnel. It does NOT handle:
 *   - Authentication / project membership (caller's job).
 *   - The `Project.preferredInstanceId` resolution (the resolver's job —
 *     see `agent-proxy-resolver.ts`).
 *   - Opening the billing session (caller opens it before invoking us;
 *     `billingSessionHandedOff` flips when we hand the stream to the tracker).
 */

import type { Context } from 'hono'
import {
  generateRequestId,
  markControllerActive,
  sendTunnelRequest,
  sendTunnelStreamRequest,
  type TunnelRequest,
} from '../routes/instances'

/**
 * Status codes / methods the runtime emits as SSE today. Mirrors the
 * detection logic in `routes/instances.ts:isStreamingRequest`. Kept here
 * so callers don't need to import that file's internals.
 */
const STREAMING_PATHS = new Set<string>([
  '/agent/chat',
  '/agent/quick-actions',
  '/agent/logs/stream',
])

export function isAgentTunnelStreamingPath(method: string, cleanPath: string): boolean {
  if (method !== 'POST' && method !== 'GET') return false
  // /agent/logs/stream is GET-only; everything else streams under POST.
  if (cleanPath === '/agent/logs/stream') return method === 'GET'
  return method === 'POST' && STREAMING_PATHS.has(cleanPath)
}

export interface TunnelRelayOptions {
  /** Hono context — needed for abort signal + CORS origin echo. */
  c: Context
  /** Instance UUID — the routing target. Caller has already confirmed the tunnel is live. */
  instanceId: string
  /** Workspace UUID — surfaced for audit logging only. */
  workspaceId: string
  /** Project UUID — embedded in the wire envelope so the worker spawns the right runtime. */
  projectId: string
  /**
   * Clean inner agent path WITH query string (e.g. `/agent/chat?cid=…`).
   * Already stripped of the `/api/projects/:pid/agent-proxy` prefix.
   */
  agentPath: string
  /** Same path as `agentPath` but WITHOUT query string — used for streaming detection. */
  cleanPath: string
  method: string
  /** Stringified body for non-GET/HEAD requests. */
  body?: string
  /** Per-request headers to forward into the runtime (content-type, accept, etc). */
  headers: Record<string, string>
  /**
   * Authenticated cloud user — surfaced as `x-tunnel-auth-user-id` so the
   * runtime can attribute the request without a session cookie. Optional
   * because public webchat / webhook traffic is unauthenticated.
   */
  userId?: string | null
  authEmail?: string | null
  authName?: string | null
  /**
   * True for `/agent/chat` POST turns. The caller is expected to have
   * already called `openSession(projectId, …)` so AI proxy calls
   * accumulate; we plug `trackChatStreamForBilling` in here so the
   * session closes exactly once after the runtime emits
   * `data-turn-complete`.
   */
  isChatTurn?: boolean
  /**
   * Caller-owned flag; we flip it to `true` once we hand the SSE stream
   * to the billing tracker. The caller's `finally` guard uses this to
   * decide whether to `closeSession(..., { discardPartial: true })` on
   * exit (e.g. error, abort).
   */
  onBillingHandoff?: () => void
  /** Tracker plug — defaults to `trackChatStreamForBilling`. Overridable for tests. */
  trackChatStream?: (stream: ReadableStream<Uint8Array>, projectId: string) => Promise<void> | void
}

/**
 * Relay a single agent-proxy request through the tunnel and return a
 * `Response` that the route can hand back to the client. Handles both
 * one-shot JSON and SSE-style streaming.
 */
export async function relayAgentProxyViaTunnel(opts: TunnelRelayOptions): Promise<Response> {
  const {
    c,
    instanceId,
    workspaceId: _workspaceId,
    projectId,
    agentPath,
    cleanPath,
    method,
    body,
    headers,
    userId,
    authEmail,
    authName,
    isChatTurn,
    onBillingHandoff,
    trackChatStream,
  } = opts

  // Bookkeeping (best-effort; failures must not break the request flow).
  if (userId) {
    void markControllerActive(instanceId, userId).catch(() => {})
  }

  const forwardHeaders: Record<string, string> = { ...headers }
  if (userId) forwardHeaders['x-tunnel-auth-user-id'] = userId
  if (authEmail) forwardHeaders['x-tunnel-auth-email'] = authEmail
  if (authName) forwardHeaders['x-tunnel-auth-name'] = authName

  const requestId = generateRequestId()
  const isStreaming = isAgentTunnelStreamingPath(method, cleanPath)

  if (isStreaming) {
    // Lazy-import the tracker to keep this module's deps tiny — tracker
    // pulls in proxy-billing-session + Prisma, and the webhook path
    // never needs them.
    let tracker: typeof trackChatStream | undefined = trackChatStream
    if (isChatTurn && !tracker) {
      const mod = await import('./chat-usage-tracker')
      tracker = mod.trackChatStreamForBilling
    }

    let trackerController: ReadableStreamDefaultController<Uint8Array> | null = null
    if (isChatTurn && tracker) {
      const trackerStream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          trackerController = ctrl
        },
      })
      Promise.resolve(tracker(trackerStream, projectId)).catch((err) =>
        console.error(`[TunnelRelay] chat tracker error for project ${projectId}:`, err),
      )
      onBillingHandoff?.()
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const { cancel } = sendTunnelStreamRequest(
          instanceId,
          {
            type: 'request',
            requestId,
            method,
            path: agentPath,
            projectId,
            headers: forwardHeaders,
            body,
          } satisfies TunnelRequest,
          (chunk) => {
            if (chunk.type === 'stream-chunk' && chunk.data) {
              const bytes = new TextEncoder().encode(chunk.data)
              controller.enqueue(bytes)
              if (trackerController) {
                try { trackerController.enqueue(bytes) } catch { /* tracker closed */ }
              }
            } else if (chunk.type === 'stream-end') {
              try { controller.close() } catch {}
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

    const responseHeaders = new Headers({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    })
    applyCorsHeaders(responseHeaders, c.req.header('origin'))
    return new Response(stream, { headers: responseHeaders })
  }

  // ─── Non-streaming ──────────────────────────────────────────────────
  try {
    const resp = await sendTunnelRequest(instanceId, {
      type: 'request',
      requestId,
      method,
      path: agentPath,
      projectId,
      headers: forwardHeaders,
      body,
    })

    const responseHeaders = new Headers()
    if (resp.headers) {
      for (const [k, v] of Object.entries(resp.headers)) {
        if (!v) continue
        const lower = k.toLowerCase()
        // Strip hop-by-hop + cookie headers for the same reason as the
        // cloud-pod branch: responses from a user's runtime must not be
        // able to set cookies on the Studio origin or confuse the
        // upstream proxy with transfer-encoding.
        if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'set-cookie') continue
        responseHeaders.set(k, v)
      }
    }
    if (!responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', 'application/json')
    }
    applyCorsHeaders(responseHeaders, c.req.header('origin'))

    return new Response(resp.body || '', {
      status: resp.status,
      headers: responseHeaders,
    })
  } catch (err: any) {
    console.error(`[TunnelRelay] ${method} ${agentPath} via instance ${instanceId} failed:`, err?.message ?? err)
    return new Response(
      JSON.stringify({ error: { code: 'proxy_error', message: err?.message || 'Tunnel relay failed' } }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }
}

function applyCorsHeaders(headers: Headers, reqOrigin: string | undefined) {
  headers.set('access-control-allow-origin', reqOrigin || '*')
  headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
  headers.set('access-control-allow-headers', '*')
  if (reqOrigin) headers.set('access-control-allow-credentials', 'true')
  headers.set('cross-origin-resource-policy', 'cross-origin')
}
