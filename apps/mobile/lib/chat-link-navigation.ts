// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opening one of this app's own chat links *in place*.
 *
 * Every surface that shows a link into our chat — the message body, the preview
 * card, an unfurl — has to agree on this, or a link opened from one place
 * leaves the app while the same link opened from another does not. Kept in
 * `lib` so nothing has to import the message row to get at it.
 */
import { parseChatLink, type ChatLinkTarget } from './team-chat-links'

function push(target: ChatLinkTarget): void {
  void import('expo-router').then(({ router }) =>
    router.push({
      pathname: '/(app)/c/[conversationId]',
      params: {
        conversationId: target.conversationId,
        ...(target.messageId ? { msg: target.messageId } : {}),
        ...(target.threadRootId ? { thread: target.threadRootId } : {}),
      },
    } as any),
  )
}

/**
 * Opens a chat link in the current window and returns true, or returns false
 * when the link is not ours and the caller should do what it would have done.
 * Pass the already-parsed target when the caller has one.
 */
export function openChatLinkInApp(hrefOrTarget: string | ChatLinkTarget): boolean {
  const target = typeof hrefOrTarget === 'string' ? parseChatLink(hrefOrTarget) : hrefOrTarget
  if (!target) return false
  push(target)
  return true
}
