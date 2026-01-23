/**
 * useChatData Hook
 *
 * Provides chat data from the studioChat domain store including:
 * - Chat Sessions (AI conversation sessions)
 * - Chat Messages (messages within sessions)
 * - Tool Call Logs (tool execution history)
 *
 * Uses the API persistence layer via collection.loadAll() methods.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useDomains } from "../contexts/DomainProvider"
import { useSession } from "../auth/client"

/**
 * Return type for useChatData hook
 */
export interface ChatDataState {
  /** All chat sessions for the context */
  sessions: any[]
  /** Currently active session */
  currentSession: any | undefined
  /** Messages for the current session */
  messages: any[]
  /** Tool calls for the current session */
  toolCalls: any[]
  /** Total message count across all sessions */
  totalMessageCount: number
  /** Loading state */
  isLoading: boolean
  /** Error state */
  error: Error | null
  /** Refetch sessions */
  refetchSessions: () => void
  /** Refetch messages for current session */
  refetchMessages: () => void
  /** Create a new chat session */
  createSession: (data: {
    name?: string
    inferredName: string
    contextType: "feature" | "project" | "general"
    contextId?: string
    phase?: string
  }) => Promise<any>
  /** Add a message to current session */
  addMessage: (data: {
    role: "user" | "assistant"
    content: string
    imageData?: string
    parts?: string
  }) => Promise<any>
  /** Set current session by ID */
  setCurrentSessionId: (sessionId: string | undefined) => void
}

/**
 * Options for useChatData hook
 */
export interface UseChatDataOptions {
  /** Context type to filter sessions by */
  contextType?: "feature" | "project" | "general"
  /** Context ID (feature or project ID) to filter sessions by */
  contextId?: string
  /** Project ID (alias for contextId when contextType is "project") */
  projectId?: string
}

/**
 * Hook for accessing chat data for a specific context (project, feature, or general).
 *
 * @param options - Filter options for chat data
 *
 * @example
 * ```tsx
 * // For a project chat
 * const { sessions, currentSession, messages, createSession, addMessage } = useChatData({
 *   contextType: "project",
 *   projectId: "project-123"
 * })
 *
 * // Create a new session
 * const session = await createSession({
 *   inferredName: "New Chat",
 *   contextType: "project",
 *   contextId: "project-123"
 * })
 *
 * // Add a message
 * await addMessage({ role: "user", content: "Hello!" })
 * ```
 */
export function useChatData(options: UseChatDataOptions = {}): ChatDataState {
  const { contextType, contextId, projectId } = options
  const effectiveContextId = contextId || projectId

  const { data: session } = useSession()
  const { studioChat } = useDomains()

  // State
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>()
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Refetch counters
  const [sessionsRefetchCounter, setSessionsRefetchCounter] = useState(0)
  const [messagesRefetchCounter, setMessagesRefetchCounter] = useState(0)

  const userId = session?.user?.id

  // Load chat sessions
  useEffect(() => {
    const loadSessions = async () => {
      if (!studioChat?.chatSessionCollection) {
        setIsLoadingSessions(false)
        return
      }

      try {
        setIsLoadingSessions(true)
        setError(null)

        // Build filter based on options
        const filter: Record<string, any> = {}
        if (contextType) filter.contextType = contextType
        if (effectiveContextId) filter.contextId = effectiveContextId
        if (projectId) filter.projectId = projectId

        await studioChat.chatSessionCollection.loadAll(filter)
      } catch (err) {
        console.error("[useChatData] Error loading sessions:", err)
        setError(err instanceof Error ? err : new Error("Failed to load chat sessions"))
      } finally {
        setIsLoadingSessions(false)
      }
    }

    loadSessions()
  }, [studioChat, contextType, effectiveContextId, projectId, sessionsRefetchCounter])

  // Load messages for current session
  useEffect(() => {
    const loadMessages = async () => {
      if (!currentSessionId || !studioChat?.chatMessageCollection) {
        setIsLoadingMessages(false)
        return
      }

      try {
        setIsLoadingMessages(true)
        await studioChat.chatMessageCollection.loadAll({ sessionId: currentSessionId })
      } catch (err) {
        console.error("[useChatData] Error loading messages:", err)
        setError(err instanceof Error ? err : new Error("Failed to load messages"))
      } finally {
        setIsLoadingMessages(false)
      }
    }

    loadMessages()
  }, [currentSessionId, studioChat, messagesRefetchCounter])

  // Load tool calls for current session
  useEffect(() => {
    const loadToolCalls = async () => {
      if (!currentSessionId || !studioChat?.toolCallLogCollection) {
        return
      }

      try {
        await studioChat.toolCallLogCollection.loadAll({ chatSessionId: currentSessionId })
      } catch (err) {
        console.error("[useChatData] Error loading tool calls:", err)
      }
    }

    loadToolCalls()
  }, [currentSessionId, studioChat])

  // Refetch callbacks
  const refetchSessions = useCallback(() => {
    setSessionsRefetchCounter((c) => c + 1)
  }, [])

  const refetchMessages = useCallback(() => {
    setMessagesRefetchCounter((c) => c + 1)
  }, [])

  // Get sessions based on context filters
  const sessions = useMemo(() => {
    if (!studioChat?.chatSessionCollection) return []
    try {
      if (contextType && effectiveContextId) {
        return studioChat.chatSessionCollection.findByContext(effectiveContextId)
      } else if (contextType) {
        return studioChat.chatSessionCollection.findByContextType(contextType)
      }
      return studioChat.chatSessionCollection.all()
    } catch {
      return []
    }
  }, [studioChat, contextType, effectiveContextId, isLoadingSessions])

  // Get current session
  const currentSession = useMemo(() => {
    if (!currentSessionId || !studioChat?.chatSessionCollection) return undefined
    try {
      return studioChat.chatSessionCollection.get(currentSessionId)
    } catch {
      return undefined
    }
  }, [currentSessionId, studioChat, isLoadingSessions])

  // Get messages for current session
  const messages = useMemo(() => {
    if (!currentSessionId || !studioChat?.chatMessageCollection) return []
    try {
      return studioChat.chatMessageCollection.findBySession(currentSessionId)
    } catch {
      return []
    }
  }, [currentSessionId, studioChat, isLoadingMessages])

  // Get tool calls for current session
  const toolCalls = useMemo(() => {
    if (!currentSessionId || !studioChat?.toolCallLogCollection) return []
    try {
      return studioChat.toolCallLogCollection
        .all()
        .filter((tc: any) => tc.chatSession?.id === currentSessionId)
    } catch {
      return []
    }
  }, [currentSessionId, studioChat])

  // Total message count
  const totalMessageCount = useMemo(() => {
    if (!studioChat?.chatMessageCollection) return 0
    try {
      return studioChat.chatMessageCollection.all().length
    } catch {
      return 0
    }
  }, [studioChat, isLoadingMessages])

  // Create a new session
  const createSession = useCallback(async (data: {
    name?: string
    inferredName: string
    contextType: "feature" | "project" | "general"
    contextId?: string
    phase?: string
  }) => {
    if (!studioChat) throw new Error("Chat domain not available")
    
    const newSession = await studioChat.createChatSession(data)
    setCurrentSessionId(newSession.id)
    refetchSessions()
    return newSession
  }, [studioChat, refetchSessions])

  // Add a message to current session
  const addMessage = useCallback(async (data: {
    role: "user" | "assistant"
    content: string
    imageData?: string
    parts?: string
  }) => {
    if (!studioChat) throw new Error("Chat domain not available")
    if (!currentSessionId) throw new Error("No current session selected")

    const message = await studioChat.addMessage({
      sessionId: currentSessionId,
      ...data,
    })
    refetchMessages()
    return message
  }, [studioChat, currentSessionId, refetchMessages])

  const isLoading = isLoadingSessions || isLoadingMessages

  return {
    sessions,
    currentSession,
    messages,
    toolCalls,
    totalMessageCount,
    isLoading,
    error,
    refetchSessions,
    refetchMessages,
    createSession,
    addMessage,
    setCurrentSessionId,
  }
}
