// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * URL composition for `useChatConversation` (web + native).
 *
 * Lifted out of the hook so the same shape is exercised by both
 * platforms and is unit-testable without spinning up a React renderer.
 *
 * The hook appends `?projectId=` and `?conversationId=` to whatever
 * value the consumer supplied as the `api` option. We preserve any
 * pre-existing query string the consumer already added so this works:
 *
 *   appendChatQuery('https://api.example/chat?foo=bar', {
 *     projectId: 'p-1',
 *   })
 *   // → 'https://api.example/chat?foo=bar&projectId=p-1'
 *
 * Empty / `undefined` values are dropped silently so the helper is
 * safe to call with the consumer's whole option bag.
 */

export function appendChatQuery(
  basePath: string,
  params: Record<string, string | undefined>,
): string {
  const tail: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && v.length > 0) {
      tail.push(`${k}=${encodeURIComponent(v)}`)
    }
  }
  if (tail.length === 0) return basePath
  const sep = basePath.includes('?') ? '&' : '?'
  return `${basePath}${sep}${tail.join('&')}`
}
