/**
 * useChatSessionNavigation - URL state for chat session persistence
 *
 * Persists the current chat session ID in the URL query params so that:
 * - Page refresh returns to the same chat session
 * - Hot reload during development preserves the session
 * - Users can share/bookmark chat session URLs
 */

import { useQueryState, parseAsString } from "nuqs"
import { useCallback } from "react"

export interface ChatSessionNavigationState {
  /** Current chat session ID from URL (?chatSessionId=...) */
  chatSessionId: string | null
  /** Set/update chat session ID in URL */
  setChatSessionId: (sessionId: string | null) => Promise<URLSearchParams>
}

export function useChatSessionNavigation(): ChatSessionNavigationState {
  const [chatSessionId, setChatSessionIdRaw] = useQueryState("chatSessionId", parseAsString)

  const setChatSessionId = useCallback(
    async (sessionId: string | null): Promise<URLSearchParams> => {
      return setChatSessionIdRaw(sessionId)
    },
    [setChatSessionIdRaw]
  )

  return {
    chatSessionId,
    setChatSessionId,
  }
}
