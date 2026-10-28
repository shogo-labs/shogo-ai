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

/** The runtime route that accepts streamed attachment bytes. */
export const CHAT_ATTACHMENT_UPLOAD_PATH = '/agent/chat/attachments'

/**
 * True when this proxied request is an attachment upload, i.e. its body must
 * be streamed instead of buffered.
 */
export function isChatAttachmentUpload(method: string, path: string): boolean {
  return method.toUpperCase() === 'PUT' && path === CHAT_ATTACHMENT_UPLOAD_PATH
}
