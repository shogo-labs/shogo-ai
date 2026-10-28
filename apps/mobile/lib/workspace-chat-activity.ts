// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace-agent side of the chat activity bus. A project workspace
 * derives its spinner state from its per-tab streaming map; the workspace agent
 * shows one chat at a time, so its state is just "the open chat, streaming or
 * not" plus the chats that finished while the person was looking elsewhere.
 * Pure so it can be tested without rendering the agent screen.
 */
import type { ChatActivityEvent } from './chat-session-events'

export type WorkspaceChatActivityState = {
  /** The one chat whose turn is running, if any. */
  streamingSessionId: string | null
  /** Chats that finished streaming and have not been opened since. */
  completedSessionIds: string[]
  /**
   * The chat whose turn just ended, for the emit that follows. A real
   * transition only — a chat switch clears the state without setting it, so
   * the list never mistakes "you navigated away" for "the turn is over".
   */
  finishedSessionId?: string | null
}

export const emptyWorkspaceChatActivity: WorkspaceChatActivityState = {
  streamingSessionId: null,
  completedSessionIds: [],
}

export function nextWorkspaceChatActivity(
  state: WorkspaceChatActivityState,
  change: {
    sessionId: string
    isStreaming: boolean
    /** The chat on screen; it never gets a new-activity dot. */
    activeSessionId?: string | null
  },
): WorkspaceChatActivityState {
  const { sessionId, isStreaming, activeSessionId } = change

  if (isStreaming) {
    return {
      streamingSessionId: sessionId,
      completedSessionIds: state.completedSessionIds.filter(
        (id) => id !== sessionId,
      ),
      finishedSessionId: null,
    }
  }

  const wasStreaming = state.streamingSessionId === sessionId
  if (!wasStreaming) return state

  const shouldFlag =
    sessionId !== activeSessionId && !state.completedSessionIds.includes(sessionId)
  return {
    streamingSessionId: null,
    completedSessionIds: shouldFlag
      ? [...state.completedSessionIds, sessionId]
      : state.completedSessionIds,
    finishedSessionId: sessionId,
  }
}

/** The event to emit for `workspaceId`. One scope id — never `projectId`. */
export function workspaceChatActivityEvent(
  workspaceId: string,
  state: WorkspaceChatActivityState,
): ChatActivityEvent {
  return {
    workspaceId,
    streamingSessionIds: state.streamingSessionId
      ? [state.streamingSessionId]
      : [],
    completedSessionIds: [...state.completedSessionIds],
    finishedSessionIds: state.finishedSessionId ? [state.finishedSessionId] : [],
  }
}
