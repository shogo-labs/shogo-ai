// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat session fork helper.
 *
 * Thin wrapper around `POST /api/chat-sessions/:id/fork` (see
 * `apps/api/src/routes/chat-session-fork.ts`). Powers the "Fork
 * conversation from here" footer button under a completed assistant
 * turn — clones the session's history up to and including a given
 * message into a brand-new session.
 *
 * Same shape as `message-edit-api.ts` / `feedback-api.ts`: takes the
 * MST collection it's logically attached to, pulls `env.http` off it
 * via `getEnv`, and goes through the SAME HttpClient the
 * auto-generated CRUD uses so the remote-aware interceptor still
 * proxies to a connected desktop instance.
 *
 * This helper deliberately does NOT know about `chatSessionEvents` —
 * that's an `apps/mobile`-local pub/sub for switching the already-
 * mounted project workspace to the new session in place, and doesn't
 * belong in a package shared with other host apps. Callers should
 * emit/select on the new `sessionId` themselves after this resolves.
 */

import { getEnv } from 'mobx-state-tree'
import type { IChatSessionCollection, ISDKEnvironment } from '@shogo/domain-stores'

export interface ForkSessionResult {
  ok: true
  sessionId: string
  messageCount: number
}

/**
 * Fork `sessionId` at `messageId`: clones every message up to and
 * including the target into a brand-new `ChatSession` (same
 * project/workspace context) and returns its id.
 */
export async function forkChatSession(
  collection: IChatSessionCollection,
  sessionId: string,
  messageId: string,
): Promise<ForkSessionResult> {
  const env = getEnv<ISDKEnvironment>(collection)
  const response = await env.http.post<ForkSessionResult>(
    `/api/chat-sessions/${sessionId}/fork`,
    { messageId },
  )
  if (!response.data?.ok) {
    throw new Error('Failed to fork chat session')
  }
  return response.data
}
