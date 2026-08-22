// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turn idempotency for `POST /projects/:projectId/chat`.
 *
 * Part of the offline-resilient chat design: when a send is queued because
 * the initial POST failed on a network error (see the client's offline send
 * queue in `ChatPanel.tsx`), retrying it later must not risk starting a
 * SECOND agent turn if the original request actually reached the runtime
 * (e.g. the POST succeeded but the client never saw the response — a
 * connection reset right after the runtime accepted the request). Without an
 * idempotency key, `runAgentLoop` would be invoked twice for what the user
 * experienced as one send.
 *
 * The client generates a `clientTurnId` once per logical send (reused across
 * retries of the SAME send) and forwards it as the `X-Client-Turn-Id` header
 * (see `packages/shared-app/src/chat/useChatTransport.ts`). This module is a
 * small in-memory `(chatSessionId -> last clientTurnId)` map the route
 * consults before proxying to the runtime: a repeat POST with a
 * `clientTurnId` that matches the most recent one for that session, within
 * `MAX_AGE_MS`, is treated as a retry of an in-flight-or-recently-finished
 * turn and attached to the existing `streamBufferStore` entry instead of
 * starting a new one (see the `X-Client-Turn-Id` handling in
 * `router.post("/projects/:projectId/chat", ...)`).
 *
 * Deliberately process-local (like `streamBufferStore` itself) — this is a
 * best-effort de-dupe for the single-pod desktop/self-hosted case the
 * offline-resilience plan targets, not a distributed idempotency guarantee.
 */

interface ClientTurnRecord {
  clientTurnId: string
  startedAt: number
}

/** How long a `clientTurnId` stays eligible for de-dupe after being recorded. */
const MAX_AGE_MS = 10 * 60 * 1000

const recentTurnsByChatSession = new Map<string, ClientTurnRecord>()

/** Record that a new turn was just started for `chatSessionId` with `clientTurnId`. */
export function recordClientTurn(chatSessionId: string, clientTurnId: string, now: number = Date.now()): void {
  recentTurnsByChatSession.set(chatSessionId, { clientTurnId, startedAt: now })
}

/**
 * True when `clientTurnId` matches the most recently recorded turn for
 * `chatSessionId` and hasn't aged out. Stale entries are pruned as a
 * side effect so the map doesn't grow across a long-lived session's many
 * distinct turns.
 */
export function isRecentClientTurn(chatSessionId: string, clientTurnId: string, now: number = Date.now()): boolean {
  const rec = recentTurnsByChatSession.get(chatSessionId)
  if (!rec) return false
  if (now - rec.startedAt > MAX_AGE_MS) {
    recentTurnsByChatSession.delete(chatSessionId)
    return false
  }
  return rec.clientTurnId === clientTurnId
}

/** Test-only: reset all in-memory state between test cases. */
export function _resetClientTurnIdempotencyForTests(): void {
  recentTurnsByChatSession.clear()
}
