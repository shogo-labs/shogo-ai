// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one realtime event a "what is running" surface needs: a chat's turn
 * started or ended somewhere else — another window, another device, or the
 * server itself (SHO-299).
 *
 * Wrapped in its own hook so a screen that reacts to a turn edge can be tested
 * without a socket, and so the workspace chats list and the activity feed read
 * the same event the same way (SHO-602).
 */
import { useTeamChatEvents } from '../lib/team-chat-connection'

export interface ChatTurnEdge {
  chatSessionId: string
  turnId: string
  state: 'started' | 'ended'
}

export function useChatTurnEvents(
  workspaceId: string | null | undefined,
  onEdge: (edge: ChatTurnEdge) => void,
): void {
  useTeamChatEvents(workspaceId ?? null, (event) => {
    if (event.type !== 'chat-session.turn') return
    onEdge({
      chatSessionId: event.chatSessionId,
      turnId: event.turnId,
      state: event.state,
    })
  })
}
