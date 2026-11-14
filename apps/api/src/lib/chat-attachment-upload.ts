// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Chat attachment uploads (`PUT /agent/chat/attachments`) are the one proxied
 * request whose body is a file rather than a JSON document. Every other proxy
 * route buffers the body (`c.req.text()` / `c.req.arrayBuffer()`) before
 * forwarding, which is fine for a chat turn and fatal for a 200 MB archive:
 * the API would hold one copy in memory and hand the runtime another, which is
 * exactly what made large attachments time out (SHO-213).
 *
 * So the proxies stream this one path's body straight through. The runtime
 * pipes the bytes to disk as they arrive, so neither side ever holds the file.
 */

import { getChatAttachmentCapForPaid } from '../config/usage-plans'
import { hasPaidSubscription } from '../services/billing-runtime'

/** The runtime route that accepts streamed attachment bytes. */
export const CHAT_ATTACHMENT_UPLOAD_PATH = '/agent/chat/attachments'

/**
 * Header the API proxy sets on a streamed upload so the runtime can enforce the
 * same cap on the real byte count when `content-length` is missing or lies
 * (a chunked body). The runtime only ever *lowers* its own cap from this.
 */
export const CHAT_ATTACHMENT_MAX_BYTES_HEADER = 'x-attachment-max-bytes'

/**
 * True when this proxied request is an attachment upload, i.e. its body must
 * be streamed instead of buffered.
 */
export function isChatAttachmentUpload(method: string, path: string): boolean {
  return method.toUpperCase() === 'PUT' && path === CHAT_ATTACHMENT_UPLOAD_PATH
}

export interface ChatAttachmentCap {
  /** Per-attachment cap in bytes for this workspace's plan. */
  capBytes: number
  plan: 'free' | 'paid'
}

/**
 * Resolve the per-attachment cap for a workspace. Free is a hard 100 MB; every
 * paid tier (and desktop/local, where `hasPaidSubscription` is true) gets the
 * 500 MB body ceiling. This is the API's source of truth — the runtime and the
 * client both read the same numbers from `config/usage-plans`.
 */
export async function resolveChatAttachmentCap(workspaceId: string): Promise<ChatAttachmentCap> {
  let paid: boolean
  try {
    paid = await hasPaidSubscription(workspaceId)
  } catch (error) {
    // Both proxies call this inside the catch-all that answers 502
    // `proxy_error`, so a transient billing/DB failure must not turn a healthy
    // upload into a 502. Fall back to the paid cap — still bounded by the API
    // body limit and the runtime's own ceiling — and log it.
    console.warn(
      `[chat-attachment] hasPaidSubscription failed for workspace ${workspaceId}; using the paid cap`,
      error instanceof Error ? error.message : error,
    )
    paid = true
  }
  return { capBytes: getChatAttachmentCapForPaid(paid), plan: paid ? 'paid' : 'free' }
}

/** The 413 body both proxies return when a declared upload exceeds the cap. */
export function chatAttachmentTooLargeBody(cap: ChatAttachmentCap): {
  error: {
    code: 'attachment_too_large'
    message: string
    limitBytes: number
    plan: 'free' | 'paid'
    upgrade: boolean
  }
} {
  const limitMb = Math.round(cap.capBytes / (1024 * 1024))
  return {
    error: {
      code: 'attachment_too_large',
      message:
        cap.plan === 'free'
          ? `Free workspaces can attach files up to ${limitMb} MB. Upgrade to Basic or higher for up to 500 MB.`
          : `Attachments are limited to ${limitMb} MB.`,
      limitBytes: cap.capBytes,
      plan: cap.plan,
      upgrade: cap.plan === 'free',
    },
  }
}
