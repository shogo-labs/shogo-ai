// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent-proxy forward header builder.
 *
 * The cloud `/api/projects/:projectId/agent-proxy/*` handler has two
 * transport branches — direct fetch to a pod (cloud-pod / VM / K8s) and
 * relay through a paired Instance's outbound WebSocket (tunnel) — and
 * both have to forward the *same* tightly-controlled set of headers to
 * the inner agent-runtime. Centralizing that construction here keeps the
 * two branches semantically identical and makes the allow-list a single
 * audit target.
 *
 * The allow-list is small on purpose:
 *
 *   - `content-type`, `accept` — basic body negotiation.
 *   - `x-runtime-token` — derived per-project HMAC that authenticates
 *     the cloud→pod hop (replaces the caller's `Authorization`, which
 *     the cloud uses for its own `shogo_sk_*` workspace auth and which
 *     never reaches the pod).
 *   - `x-billing-user-id` — set only on chat-stream turns so the
 *     runtime can attribute AI proxy calls.
 *   - Webchat-only headers (`origin` + `x-webchat-*`) — passed through
 *     on `/agent/channels/webchat/*` paths because the widget itself
 *     authenticates with the runtime via those headers.
 *   - `x-webhook-secret` — passed through on `/agent/channels/webhook/*`
 *     paths so the runtime's `WebhookAdapter.verifyAuth` can compare it
 *     against the per-channel shared secret stored in the pod's
 *     `config.json`. Without this, every externally-configured webhook
 *     secret silently fails closed at the cloud relay and the only
 *     reachable verifyAuth branch is the empty-secret bypass — the
 *     exact regression that prompted this module's extraction.
 *
 * Headers explicitly *not* forwarded include `authorization` (rewritten
 * upstream to `x-runtime-token`), `cookie`, and any caller-supplied
 * `x-runtime-token` (so callers cannot impersonate the cloud). Adding
 * a new header to the allow-list is a security review decision —
 * extend the test suite alongside the change.
 */

/** Whether the agent-proxy path targets a webchat widget endpoint. */
export function isAgentProxyWebchatPath(path: string): boolean {
  return (
    path === '/agent/channels/webchat/widget.js' ||
    path === '/agent/channels/webchat/health' ||
    path === '/agent/channels/webchat/config' ||
    path === '/agent/channels/webchat/session' ||
    path === '/agent/channels/webchat/message' ||
    path.startsWith('/agent/channels/webchat/events/')
  )
}

/**
 * Whether the agent-proxy path targets the generic HTTP webhook channel.
 *
 * Matches every route registered in
 * `packages/agent-runtime/src/channels/webhook.ts:registerRoutes` —
 * `incoming`, `outbox/:channelId`, `health`, `activity`, `test`. New
 * sub-routes under `/agent/channels/webhook/` automatically inherit
 * the same header passthrough (intentional, so adding a webhook route
 * never requires a parallel cloud-side change to keep auth working).
 */
export function isAgentProxyWebhookPath(path: string): boolean {
  return path.startsWith('/agent/channels/webhook/')
}

export interface BuildAgentProxyForwardHeadersInput {
  /**
   * Lookup function returning a single request header by lowercase
   * name. Concretely, `c.req.header` in production code; a `Map.get`
   * in tests. Returning `undefined` (or empty string) for a missing
   * header skips it.
   */
  readHeader: (name: string) => string | undefined
  /** Pre-derived per-project runtime token (see `runtime-token.ts`). */
  runtimeToken: string
  /** Inner agent path with query string stripped (used for routing). */
  cleanPath: string
  /**
   * Authenticated cloud user, when this request is a chat-stream turn
   * that should be billed. Both must be truthy to emit
   * `x-billing-user-id`; matches the existing chat-stream contract in
   * the proxy handler.
   */
  isChatStream?: boolean
  billingUserId?: string | null
}

/**
 * Build the request header set to forward to the inner agent-runtime.
 *
 * Returns a plain `Record<string, string>` — both consumers (`fetch`
 * for the cloud-pod branch and the tunnel `headers` envelope) accept
 * that shape directly, so we don't pay for a `Headers` instance.
 */
export function buildAgentProxyForwardHeaders(input: BuildAgentProxyForwardHeadersInput): Record<string, string> {
  const { readHeader, runtimeToken, cleanPath, isChatStream, billingUserId } = input
  const headers: Record<string, string> = {}

  const contentType = readHeader('content-type')
  if (contentType) headers['content-type'] = contentType

  const accept = readHeader('accept')
  if (accept) headers['accept'] = accept

  if (isAgentProxyWebchatPath(cleanPath)) {
    for (const name of ['origin', 'x-webchat-widget-key', 'x-webchat-session-token', 'x-webchat-session'] as const) {
      const value = readHeader(name)
      if (value) headers[name] = value
    }
  }

  if (isAgentProxyWebhookPath(cleanPath)) {
    const secret = readHeader('x-webhook-secret')
    if (secret) headers['x-webhook-secret'] = secret
  }

  headers['x-runtime-token'] = runtimeToken

  if (isChatStream && billingUserId) {
    headers['x-billing-user-id'] = billingUserId
  }

  return headers
}
