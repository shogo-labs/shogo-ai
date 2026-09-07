// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat message feedback helpers.
 *
 * Thin wrappers around the `/api/chat-messages/:id/feedback` and
 * `/api/chat-sessions/:id/feedback` extension endpoints (see
 * `apps/api/src/routes/chat-message-feedback.ts`). Powers the
 * thumbs up/down footer buttons under each completed assistant turn.
 *
 * Same shape as `message-edit-api.ts`: helpers take the MST
 * collection they're logically attached to, pull `env.http` off it
 * via `getEnv`, and go through the SAME HttpClient the auto-generated
 * CRUD uses so the remote-aware interceptor still proxies to a
 * connected desktop instance.
 */

import { getEnv } from 'mobx-state-tree'
import type {
  IChatMessageCollection,
  IChatSessionCollection,
  ISDKEnvironment,
} from '@shogo/domain-stores'

export type MessageFeedbackThumbs = 'up' | 'down'

export interface SetMessageFeedbackResult {
  ok: true
  data: {
    messageId: string
    thumbs: MessageFeedbackThumbs
    createdAt: string
    updatedAt: string
  }
}

/**
 * Set (or flip) the caller's reaction to a message. Re-tapping the
 * same thumb is a no-op server-side (still upserts, same value);
 * tapping the other thumb flips it — both go through this one call.
 */
export async function setMessageFeedback(
  collection: IChatMessageCollection,
  messageId: string,
  thumbs: MessageFeedbackThumbs,
): Promise<SetMessageFeedbackResult> {
  const env = getEnv<ISDKEnvironment>(collection)
  // The HttpClient exposes get/post/patch/delete helpers but no `put`
  // — go through the underlying `request()` method directly (same
  // client, same auth/interceptor plumbing) for the PUT verb the
  // feedback route uses.
  const response = await env.http.request<SetMessageFeedbackResult>(
    `/api/chat-messages/${messageId}/feedback`,
    { method: 'PUT', body: { thumbs } },
  )
  if (!response.data?.ok) {
    throw new Error('Failed to set message feedback')
  }
  return response.data
}

/**
 * Clear the caller's reaction to a message (re-tapping an
 * already-active thumb in the UI calls this instead of `set` with
 * the same value). No-op (still resolves) if no feedback row exists.
 */
export async function clearMessageFeedback(
  collection: IChatMessageCollection,
  messageId: string,
): Promise<void> {
  const env = getEnv<ISDKEnvironment>(collection)
  const response = await env.http.delete<{ ok: boolean }>(
    `/api/chat-messages/${messageId}/feedback`,
  )
  if (!response.data?.ok) {
    throw new Error('Failed to clear message feedback')
  }
}

export interface SessionFeedbackResult {
  ok: true
  feedback: Record<string, MessageFeedbackThumbs>
}

/**
 * Fetch the caller's own feedback for every message in a session, as
 * `{ [messageId]: 'up' | 'down' }`. Powers the footer's initial
 * thumb state on chat load/reload.
 */
export async function getSessionFeedback(
  collection: IChatSessionCollection,
  sessionId: string,
): Promise<Record<string, MessageFeedbackThumbs>> {
  const env = getEnv<ISDKEnvironment>(collection)
  const response = await env.http.get<SessionFeedbackResult>(
    `/api/chat-sessions/${sessionId}/feedback`,
  )
  if (!response.data?.ok) {
    throw new Error('Failed to load session feedback')
  }
  return response.data.feedback ?? {}
}
