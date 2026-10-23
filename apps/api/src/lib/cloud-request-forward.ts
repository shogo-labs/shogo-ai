// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One forwarder for the local routes that must be answered by Shogo Cloud when
 * a desktop is cloud-authed.
 *
 * The local api is the gateway for a desktop in `SHOGO_LOCAL_MODE` with a
 * linked cloud key (`isShogoCloudForwarding()`): the bundled instance on the
 * user's machine has no provider keys, so anything that resolves one — chat
 * completions, images, video, 3D, transcription, hosted voice — has to be
 * answered by the cloud, which holds the keys and bills the workspace.
 *
 * Chat / responses / Anthropic messages predate this module and forward
 * themselves (they rewrite bodies for cache breakpoints, so they can't share a
 * pass-through). Everything else goes through here, so:
 *   - there is exactly one cloud credential and one header set (`SHOGO_API_KEY`
 *     as a bearer, `x-shogo-client: desktop`, `x-chat-session-id` relayed for
 *     cloud-side grouping),
 *   - bodies — including multipart uploads — are streamed through rather than
 *     buffered and re-encoded,
 *   - a 401 from cloud triggers the same device-key self-heal everywhere.
 */

import type { Context } from 'hono'
import { getShogoCloudUrl } from './cloud-urls'
import { wipeCloudKeyIfRejected } from './cloud-key-wipe'

/**
 * Response headers the runtime must recompute when it re-streams the body.
 * Bun's fetch transparently decompresses, so forwarding `content-encoding`
 * would make the caller decode plain bytes.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
])

/**
 * Request headers the local proxy relays to Shogo Cloud so cloud capture can
 * group desktop calls by chat.
 */
export function cloudPassthroughHeaders(c: Context): Record<string, string> {
  const chatSessionId = c.req.header('x-chat-session-id')
  return chatSessionId ? { 'x-chat-session-id': chatSessionId } : {}
}

export interface CloudForwardOptions {
  /**
   * Path as the cloud router sees it, without the `/api` mount:
   * `/ai/v1/3d/models`, `/voice/tts`, …
   */
  pathname: string
  /** Query string including its leading `?`, or `''`. */
  search?: string
  /** Extra request headers to relay. The cloud credential always wins. */
  headers?: Record<string, string>
  /**
   * Body to send when the handler had to read and validate it first (the
   * request stream is single-use). Omit to stream the caller's body straight
   * through, which is what the multipart routes need.
   */
  body?: string
}

/**
 * Forward the current request to the Shogo Cloud api and return its response,
 * streamed back with the upstream status and headers.
 */
export async function forwardToShogoCloud(
  c: Context,
  opts: CloudForwardOptions,
): Promise<Response> {
  const upstreamUrl = `${getShogoCloudUrl()}/api${opts.pathname}${opts.search ?? ''}`

  const headers = new Headers(cloudPassthroughHeaders(c))
  for (const [key, value] of Object.entries(opts.headers ?? {})) headers.set(key, value)
  headers.set('Authorization', `Bearer ${process.env.SHOGO_API_KEY!}`)
  headers.set('x-shogo-client', 'desktop')
  // `content-type` carries the multipart boundary on uploads — without it the
  // cloud rejects the request before it reaches a handler.
  const contentType = c.req.header('content-type')
  if (contentType) headers.set('Content-Type', contentType)
  const accept = c.req.header('accept')
  if (accept) headers.set('Accept', accept)

  const method = c.req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const streamedBody = hasBody ? { body: c.req.raw.body, duplex: 'half' } : {}
  const bodyInit = opts.body !== undefined ? { body: opts.body } : streamedBody

  let response: Response
  try {
    response = await fetch(upstreamUrl, {
      method,
      headers,
      ...bodyInit,
      // Same rationale as `lib/region-peer-proxy.ts`: when the upstream answers
      // before reading a streamed body (any early reject), Bun returns the
      // socket to the keep-alive pool mid-request-message and the *next*
      // request is written into the abandoned body.
      keepalive: false,
      signal: c.req.raw.signal,
    } as RequestInit)
  } catch (error: any) {
    console.error(`[CloudForward] ${opts.pathname} failed:`, error?.message)
    return new Response(
      JSON.stringify({
        error: {
          message: `Cloud proxy error: ${error?.message || String(error)}`,
          type: 'server_error',
          code: 'cloud_proxy_error',
        },
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // Self-heal on a revoked / superseded device key.
  if (response.status === 401) {
    void wipeCloudKeyIfRejected(`AI proxy ${opts.pathname} got 401 from Shogo Cloud`)
  }

  const responseHeaders = new Headers()
  response.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value)
  })
  responseHeaders.set('X-Proxy-Provider', 'shogo-cloud')
  return new Response(response.body, { status: response.status, headers: responseHeaders })
}
