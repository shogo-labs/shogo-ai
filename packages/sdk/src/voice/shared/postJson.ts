// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tiny `fetch`-based JSON POST helper used by the voice hooks (both web
 * and native). Lifted out of `useVoiceConversation` so the same auth /
 * credentials handling is shared verbatim between platforms.
 */

export interface PostJsonConfig {
  /** Static auth headers (e.g. `{ authorization: 'Bearer ...' }`). */
  authHeaders: () => Record<string, string>
  /** Forwarded to `fetch`'s `credentials` option. */
  fetchCredentials: RequestCredentials
}

export type PostJson = (path: string, body: unknown) => Promise<Response>

export function createPostJson({
  authHeaders,
  fetchCredentials,
}: PostJsonConfig): PostJson {
  return async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      credentials: fetchCredentials,
      body: JSON.stringify(body),
    })
  }
}
