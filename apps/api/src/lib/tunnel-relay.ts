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

/**
 * The AI SDK's durable-resume reconnect endpoint: `GET /agent/chat/:id/stream`.
 * It must be relayed as a live SSE stream (not buffered as a one-shot
 * response) so the client's auto-resume wrapper can pick up live frames the
 * runtime produced during a disconnect window. Mirrors `CHAT_RESUME_STREAM_RE`
 * in `routes/instances.ts`.
 */
const CHAT_RESUME_STREAM_RE = /^\/agent\/chat\/[^/]+\/stream$/

export function isAgentTunnelStreamingPath(method: string, cleanPath: string): boolean {
  if (method !== 'POST' && method !== 'GET') return false
  // /agent/logs/stream is GET-only; everything else streams under POST.
  if (cleanPath === '/agent/logs/stream') return method === 'GET'
  // The chat-resume endpoint streams under GET. Without this a reconnect
  // would be buffered into a one-shot response and the live tail would
  // never reach the client — defeating durable resume across a tunnel drop.
  if (CHAT_RESUME_STREAM_RE.test(cleanPath)) return method === 'GET'
  return method === 'POST' && STREAMING_PATHS.has(cleanPath)
}

/** Extract the chat-session id from a resume path like `/agent/chat/<id>/stream`. */
function chatSessionIdFromResumePath(cleanPath: string): string | null {
  const m = cleanPath.match(/^\/agent\/chat\/([^/]+)\/stream$/)
  return m ? decodeURIComponent(m[1]) : null
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
   * already called `openSession(projectId, …, chatSessionId)` so AI proxy
   * calls accumulate against the right `(projectId, chatSessionId)` slot;
   * we plug `trackChatStreamForBilling` in here so the session closes
   * exactly once after the runtime emits `data-turn-complete`.
   */
  isChatTurn?: boolean
  /**
   * Chat-session id from the client (`X-Chat-Session-Id` header). Forwarded
   * to the tracker so the close targets the same composite key the caller
   * used at `openSession` time.
   */
  chatSessionId?: string | null
  /**
   * Caller-owned flag; we flip it to `true` once we hand the SSE stream
   * to the billing tracker. The caller's `finally` guard uses this to
   * decide whether to `closeSession(..., { discardPartial: true })` on
   * exit (e.g. error, abort).
   */
  onBillingHandoff?: () => void
  /** Tracker plug — defaults to `trackChatStreamForBilling`. Overridable for tests. */
  trackChatStream?: (
    stream: ReadableStream<Uint8Array>,
    projectId: string,
    chatSessionId?: string | null,
  ) => Promise<void> | void
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
    chatSessionId,
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
      Promise.resolve(tracker(trackerStream, projectId, chatSessionId)).catch((err) =>
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
            } else if (chunk.type === 'stream-interrupted') {
              // The worker's tunnel WebSocket dropped mid-turn (e.g. 1006
              // over the India hop). The agent keeps running and buffering
              // into the runtime's durable stream buffer, so this is NOT a
              // terminal error. End the SSE body cleanly — the client's
              // auto-resume wrapper sees EOF *without* a `data-turn-complete`
              // marker and reconnects via `/agent/chat/:id/stream?fromSeq=N`,
              // delivering everything generated during the disconnect.
              try { controller.close() } catch { /* already closed */ }
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

    // Surface the durable-turn session id so the client's auto-resume fetch
    // wrapper (`createAutoResumingFetch`) recognizes this as a resumable
    // chat stream and reconnects via `/agent/chat/:id/stream` on a premature
    // EOF (the tunnel-drop case). Without this header the wrapper treats the
    // stream as non-durable and a 1006 disconnect silently truncates the
    // response.
    //
    // The worker forwards only SSE *body* bytes over the tunnel, not the
    // runtime's HTTP response headers, so the runtime's `X-Turn-Id` never
    // reaches us here. That's fine: the client reads the real turn id from
    // the body's `data-turn-start` frame. We only need to advertise the
    // session id, which we already know — from the chat POST (`chatSessionId`)
    // or, on a resume GET, from the request path itself.
    const durableChatSessionId = chatSessionId || chatSessionIdFromResumePath(cleanPath)
    if (durableChatSessionId) {
      responseHeaders.set('X-Chat-Session-Id', durableChatSessionId)
    }

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
  // Cross-origin reads of response headers are hidden by default; the
  // auto-resume wrapper needs to read the durable-turn headers off the
  // chat stream response (Studio and the API are different origins).
  headers.set('access-control-expose-headers', 'X-Turn-Id, X-Chat-Session-Id, X-Last-Seq, X-Turn-Status')
}
