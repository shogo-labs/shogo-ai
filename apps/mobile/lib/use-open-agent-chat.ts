// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opens the person's chat with an agent and navigates to it.
 *
 * A DM with an agent is just a project chat with that agent — a workspace chat
 * for the workspace agent (SHO-412). Every place that offers "Open chat" on an
 * agent (the agents directory, the agent profile, a project's header) goes
 * through here so they all land on the same session.
 */
import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { teamChatApi } from './team-chat-api'
import { agentChatRoute } from './team-chat-nav'

export interface OpenAgentChatOptions {
  /** Wide screens open the project beside the chat. */
  wide?: boolean
  /** Replace the default `router.push`. */
  navigate?: (route: ReturnType<typeof agentChatRoute>) => void
}

export function useOpenAgentChat(workspaceId: string | null | undefined) {
  const router = useRouter()
  const [opening, setOpening] = useState(false)
  const inFlight = useRef(false)

  const openAgentChat = useCallback(
    async (projectId: string | null, options: OpenAgentChatOptions = {}): Promise<string | null> => {
      if (!workspaceId || inFlight.current) return null
      inFlight.current = true
      setOpening(true)
      try {
        const chat = await teamChatApi().openAgentChat(workspaceId, projectId)
        const route = agentChatRoute({ projectId, sessionId: chat.chatSessionId, wide: !!options.wide })
        if (options.navigate) options.navigate(route)
        else router.push(route as never)
        return chat.chatSessionId
      } finally {
        inFlight.current = false
        setOpening(false)
      }
    },
    [workspaceId, router],
  )

  return { openAgentChat, opening }
}
