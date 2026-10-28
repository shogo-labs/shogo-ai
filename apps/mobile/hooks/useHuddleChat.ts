// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where the signed-in person chats during a call. With two people it's their
 * DM; with more it's the group DM of exactly the people in the call, which the
 * server finds or creates. Anyone added to the call changes the set
 * (`huddle.chatMembers`), so the lookup runs again and the chat follows.
 */
import { useEffect, useState } from 'react'
import { teamChatApi, type Huddle, type HuddleChatTarget } from '../lib/team-chat-api'

export interface HuddleChat {
  /** Null until the first lookup lands. */
  target: HuddleChatTarget | null
  /** The lookup failed; the call's own conversation is the best guess. */
  failed: boolean
}

/** A key that changes exactly when the chat should be looked up again. */
export function huddleChatKey(huddle: Pick<Huddle, 'id' | 'messageId' | 'chatMembers'> | null | undefined): string | null {
  if (!huddle) return null
  return `${huddle.id}|${huddle.messageId ?? ''}|${(huddle.chatMembers ?? []).join(',')}`
}

export function useHuddleChat(
  conversationId: string | null | undefined,
  huddle: Pick<Huddle, 'id' | 'messageId' | 'chatMembers'> | null | undefined,
): HuddleChat {
  const key = huddleChatKey(huddle)
  const [state, setState] = useState<{ forConversation: string | null; target: HuddleChatTarget | null; failed: boolean }>({
    forConversation: null,
    target: null,
    failed: false,
  })

  useEffect(() => {
    if (!conversationId || !key) return
    let cancelled = false
    teamChatApi()
      .huddleChat(conversationId)
      .then((target) => {
        if (!cancelled) setState({ forConversation: conversationId, target, failed: false })
      })
      .catch(() => {
        // Keep showing the last chat we knew rather than blanking out mid-call.
        if (!cancelled) setState((prev) => ({ ...prev, forConversation: conversationId, failed: true }))
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, key])

  // A different call starts with no chat of its own.
  const current = state.forConversation === conversationId
  return { target: current ? state.target : null, failed: current ? state.failed : false }
}
