// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opens (or creates) the team-chat DM with an agent and navigates to it.
 *
 * An agent is a project, or the workspace agent when `projectId` is null. Every
 * place that offers "Message <agent>" (the agents directory, the agent profile,
 * a project's header, the new-message picker) goes through here so they all land
 * on the same `/c/[conversationId]` thread.
 */
import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { invalidateConversationList } from '../hooks/useTeamChat'
import { teamChatApi, type ConversationSummary } from './team-chat-api'

export interface OpenAgentDmOptions {
  /** Also open the agent's project beside the thread (wide screens only). */
  withProjectPane?: boolean
  /** Replace the default `router.push` to the conversation. */
  navigate?: (conversation: ConversationSummary) => void
}

export function useOpenAgentDm(workspaceId: string | null | undefined) {
  const router = useRouter()
  const [opening, setOpening] = useState(false)
  const inFlight = useRef(false)

  const openAgentDm = useCallback(
    async (projectId: string | null, options: OpenAgentDmOptions = {}): Promise<ConversationSummary | null> => {
      if (!workspaceId || inFlight.current) return null
      inFlight.current = true
      setOpening(true)
      try {
        const conversation = await teamChatApi().openAgentDm(workspaceId, projectId)
        invalidateConversationList(workspaceId)
        if (options.navigate) {
          options.navigate(conversation)
        } else {
          router.push({
            pathname: '/(app)/c/[conversationId]',
            params: {
              conversationId: conversation.id,
              ...(options.withProjectPane && projectId ? { project: projectId } : {}),
            },
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

  return { openAgentDm, opening }
}
