import { useState, useCallback, useRef } from 'react'
import { mcpService } from '../services/mcpService'

/**
 * Record artifacts created by tool calls
 * Detects schema_set and store_create calls and records them to the ai-sdk-chat schema
 */
async function recordArtifacts(sessionId: string | null, toolCalls: Array<{ tool: string; args: any; result?: string }>) {
  if (!sessionId) return

  // Ensure ai-sdk-chat schema is loaded
  try {
    await mcpService.callTool('schema.load', { name: 'ai-sdk-chat' })
  } catch (error) {
    console.warn('Could not load ai-sdk-chat schema for artifact tracking:', error)
    return
  }

  // Detect artifacts from tool calls
  for (const toolCall of toolCalls) {
    let artifactType: 'schema' | 'entity' | 'other' | null = null
    let artifactName: string | null = null

    // Detect schema_set tool calls
    if (toolCall.tool === 'mcp__wavesmith__schema_set' && toolCall.args?.name) {
      artifactType = 'schema'
      artifactName = toolCall.args.name
    }
    // Detect store_create tool calls
    else if (toolCall.tool === 'mcp__wavesmith__store_create' && toolCall.args?.data?.id) {
      artifactType = 'entity'
      artifactName = `${toolCall.args.model}:${toolCall.args.data.id}`
    }

    // Record artifact if detected
    if (artifactType && artifactName) {
      try {
        // First ensure the chat session exists in the store
        try {
          await mcpService.callTool('store.get', {
            schema: 'ai-sdk-chat',
            model: 'ChatSession',
            id: sessionId
          })
        } catch {
          // Session doesn't exist, create it
          await mcpService.callTool('store.create', {
            schema: 'ai-sdk-chat',
            model: 'ChatSession',
            data: {
              id: sessionId,
              name: `Chat Session ${sessionId.slice(0, 8)}`,
              status: 'active',
              createdAt: Date.now()
            }
          })
        }

        // Create the artifact record
        await mcpService.callTool('store.create', {
          schema: 'ai-sdk-chat',
          model: 'CreatedArtifact',
          data: {
            id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            session: sessionId,
            artifactType,
            artifactName,
            toolName: toolCall.tool,
            createdAt: Date.now()
          }
        })
      } catch (error) {
        console.warn('Failed to record artifact:', error)
      }
    }
  }
}

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
        async (result) => {
          if (!result.ok) {
            setState(prev => ({
              ...prev,
              isLoading: false,
              error: result.error?.message || 'Chat request failed',
            }))
            resolve(false)
            return
          }

          // Detect and record artifacts created during this chat interaction
          if (result.toolCalls && result.toolCalls.length > 0) {
            await recordArtifacts(result.sessionId || sessionIdRef.current, result.toolCalls)
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
