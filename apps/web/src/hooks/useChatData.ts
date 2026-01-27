/**
 * useChatData Hook
 *
 * Provides chat data from the SDK domain store including:
 * - Chat Sessions (AI conversation sessions)
 * - Chat Messages (messages within sessions)
 * - Tool Call Logs (tool execution history)
 *
 * Uses the SDK collections via collection.loadAll() methods.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useSDKDomain } from "../contexts/DomainProvider"
import { useSession } from "../contexts/SessionProvider"
import type { IDomainStore } from "../generated/domain"

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
  const store = useSDKDomain() as IDomainStore

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
      if (!store?.chatSessionCollection) {
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

        await store.chatSessionCollection.loadAll(filter)
      } catch (err) {
        console.error("[useChatData] Error loading sessions:", err)
        setError(err instanceof Error ? err : new Error("Failed to load chat sessions"))
      } finally {
        setIsLoadingSessions(false)
      }
    }

    loadSessions()
  }, [store, contextType, effectiveContextId, projectId, sessionsRefetchCounter])

  // Load messages for current session
  useEffect(() => {
    const loadMessages = async () => {
      if (!currentSessionId || !store?.chatMessageCollection) {
        setIsLoadingMessages(false)
        return
      }

      try {
        setIsLoadingMessages(true)
        await store.chatMessageCollection.loadAll({ sessionId: currentSessionId })
      } catch (err) {
        console.error("[useChatData] Error loading messages:", err)
        setError(err instanceof Error ? err : new Error("Failed to load messages"))
      } finally {
        setIsLoadingMessages(false)
      }
    }

    loadMessages()
  }, [currentSessionId, store, messagesRefetchCounter])

  // Load tool calls for current session
  useEffect(() => {
    const loadToolCalls = async () => {
      if (!currentSessionId || !store?.toolCallLogCollection) {
        return
      }

      try {
        await store.toolCallLogCollection.loadAll({ chatSessionId: currentSessionId })
      } catch (err) {
        console.error("[useChatData] Error loading tool calls:", err)
      }
    }

    loadToolCalls()
  }, [currentSessionId, store])

  // Refetch callbacks
  const refetchSessions = useCallback(() => {
    setSessionsRefetchCounter((c) => c + 1)
  }, [])

  const refetchMessages = useCallback(() => {
    setMessagesRefetchCounter((c) => c + 1)
  }, [])

  // Get sessions based on context filters
  const sessions = useMemo(() => {
    if (!store?.chatSessionCollection) return []
    try {
      const allSessions = store.chatSessionCollection.all
      if (contextType && effectiveContextId) {
        return allSessions.filter((s: any) => s.contextId === effectiveContextId)
      } else if (contextType) {
        return allSessions.filter((s: any) => s.contextType === contextType)
      }
      return allSessions
    } catch {
      return []
    }
  }, [store, contextType, effectiveContextId, isLoadingSessions])

  // Get current session
  const currentSession = useMemo(() => {
    if (!currentSessionId || !store?.chatSessionCollection) return undefined
    try {
      return store.chatSessionCollection.get(currentSessionId)
    } catch {
      return undefined
    }
  }, [currentSessionId, store, isLoadingSessions])

  // Get messages for current session
  const messages = useMemo(() => {
    if (!currentSessionId || !store?.chatMessageCollection) return []
    try {
      return store.chatMessageCollection.all.filter((m: any) => m.sessionId === currentSessionId)
    } catch {
      return []
    }
  }, [currentSessionId, store, isLoadingMessages])

  // Get tool calls for current session
  const toolCalls = useMemo(() => {
    if (!currentSessionId || !store?.toolCallLogCollection) return []
    try {
      return store.toolCallLogCollection.all
        .filter((tc: any) => tc.chatSessionId === currentSessionId)
    } catch {
      return []
    }
  }, [currentSessionId, store])

  // Total message count
  const totalMessageCount = useMemo(() => {
    if (!store?.chatMessageCollection) return 0
    try {
      return store.chatMessageCollection.all.length
    } catch {
      return 0
    }
  }, [store, isLoadingMessages])

  // Create a new session
  const createSession = useCallback(async (data: {
    name?: string
    inferredName: string
    contextType: "feature" | "project" | "general"
    contextId?: string
    phase?: string
  }) => {
    if (!store?.chatSessionCollection) throw new Error("Chat store not available")
    
    const newSession = await store.chatSessionCollection.create(data)
    if (newSession) {
      setCurrentSessionId(newSession.id)
    }
    refetchSessions()
    return newSession
  }, [store, refetchSessions])

  // Add a message to current session
  const addMessage = useCallback(async (data: {
    role: "user" | "assistant"
    content: string
    imageData?: string
    parts?: string
  }) => {
    if (!store?.chatMessageCollection) throw new Error("Chat store not available")
    if (!currentSessionId) throw new Error("No current session selected")

    const message = await store.chatMessageCollection.create({
      sessionId: currentSessionId,
      ...data,
    })
    refetchMessages()
    return message
  }, [store, currentSessionId, refetchMessages])

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
