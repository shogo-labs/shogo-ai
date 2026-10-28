// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opens (or creates) the team-chat DM with a person and navigates to it.
 *
 * Every place that offers "Message <person>" — a profile panel, a member list,
 * the new-message picker — goes through here so they all land on the same
 * `/c/[conversationId]` thread. The agent equivalent is `useOpenAgentDm`.
 */
import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { invalidateConversationList } from '../hooks/useTeamChat'
import { teamChatApi, type ConversationSummary } from './team-chat-api'

export interface OpenUserDmOptions {
  /** Replace the default `router.push` to the conversation. */
  navigate?: (conversation: ConversationSummary) => void
}

export function useOpenUserDm(workspaceId: string | null | undefined) {
  const router = useRouter()
  const [opening, setOpening] = useState(false)
  const inFlight = useRef(false)

  const openUserDm = useCallback(
    async (userId: string, options: OpenUserDmOptions = {}): Promise<ConversationSummary | null> => {
      if (!workspaceId || inFlight.current) return null
      inFlight.current = true
      setOpening(true)
      try {
        // The same endpoint as a note-to-self: passing your own id yields it.
        const conversation = await teamChatApi().openDm(workspaceId, [userId])
        // Resolve before navigating: an empty response must not throw here.
        if (!conversation?.id) return null
        invalidateConversationList(workspaceId)
        if (options.navigate) {
          options.navigate(conversation)
        } else {
          router.push({
            pathname: '/(app)/c/[conversationId]',
            params: { conversationId: conversation.id },
          } as any)
        }
        return conversation
      } finally {
        inFlight.current = false
        setOpening(false)
      }
    },
    [workspaceId, router],
  )

  return { openUserDm, opening }
}
