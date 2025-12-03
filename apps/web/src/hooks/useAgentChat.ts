import { useState, useCallback, useRef } from 'react'
import { mcpService } from '../services/mcpService'

/** Message in a chat conversation */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: Array<{ tool: string; args: any; result?: string }>
  timestamp: Date
}

export interface AgentChatState {
  sessionId: string | null
  messages: ChatMessage[]
  isLoading: boolean
  error: string | null
}

export function useAgentChat() {
  const [state, setState] = useState<AgentChatState>({
    sessionId: null,
    messages: [],
    isLoading: false,
    error: null,
  })

  // Use ref to track current sessionId to avoid stale closure
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = state.sessionId

  const sendMessage = useCallback(async (content: string): Promise<boolean> => {
    if (!content.trim()) return false

    // Add user message immediately
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: content.trim(),
      timestamp: new Date(),
    }

    // Create placeholder assistant message for streaming
    const assistantId = `assistant-${Date.now()}`
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    }

    setState(prev => ({
      ...prev,
      messages: [...prev.messages, userMessage, assistantMessage],
      isLoading: true,
      error: null,
    }))

    // Set up notification handler for streaming deltas via GET SSE
    mcpService.onNotification((data) => {
      const contentArray = data.params?.content
      if (Array.isArray(contentArray)) {
        for (const item of contentArray) {
          if (item?.type === 'text' && item?.text) {
            setState(prev => ({
              ...prev,
              messages: prev.messages.map(m =>
                m.id === assistantId
                  ? { ...m, content: m.content + item.text }
                  : m
              ),
            }))
          }
        }
      }
    })

    // Initialize session and start SSE listener if not already running
    try {
      if (!mcpService.getMcpSessionId()) {
        await mcpService.initializeSession()
        await mcpService.startSSEListener()
      }
    } catch (initError: any) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: initError.message || 'Failed to initialize MCP session',
      }))
      return false
    }

    return new Promise((resolve) => {
      mcpService.streamChat(
        content,
        sessionIdRef.current,
        // onDelta - append to assistant message content (fallback for inline events)
        (delta) => {
          setState(prev => ({
            ...prev,
            messages: prev.messages.map(m =>
              m.id === assistantId
                ? { ...m, content: m.content + delta }
                : m
            ),
          }))
        },
        // onComplete - finalize with metadata
        (result) => {
          if (!result.ok) {
            setState(prev => ({
              ...prev,
              isLoading: false,
              error: result.error?.message || 'Chat request failed',
            }))
            resolve(false)
            return
          }

          setState(prev => ({
            ...prev,
            sessionId: result.sessionId || prev.sessionId,
            messages: prev.messages.map(m =>
              m.id === assistantId
                ? { ...m, toolCalls: result.toolCalls }
                : m
            ),
            isLoading: false,
            error: null,
          }))
          resolve(true)
        },
        // onError
        (error) => {
          setState(prev => ({
            ...prev,
            isLoading: false,
            error: error.message || 'Unknown error',
          }))
          resolve(false)
        }
      )
    })
  }, [])

  const reset = useCallback(() => {
    mcpService.clearSession()  // Clear MCP session (stateful mode)
    setState({
      sessionId: null,
      messages: [],
      isLoading: false,
      error: null,
    })
  }, [])

  return {
    ...state,
    sendMessage,
    reset,
  }
}
