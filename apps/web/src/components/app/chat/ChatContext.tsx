/**
 * ChatContext - Foundation for sharing chat state across components
 * Task: task-2-4-001
 *
 * Provides a React context for chat state that enables:
 * - RunPhaseButton to access sendMessage without prop drilling
 * - ChatPanel to provide chat state to consumer components
 * - Type-safe context access throughout the chat UI
 *
 * Usage:
 * ```tsx
 * // In ChatPanel (provider)
 * <ChatContextProvider value={{ currentSession, messages, sendMessage, isLoading, error }}>
 *   <PhaseContentPanel />
 * </ChatContextProvider>
 *
 * // In RunPhaseButton (consumer)
 * const { sendMessage } = useChatContext()
 * onClick={() => sendMessage(`Execute /${phaseName} skill`)}
 * ```
 */

import { createContext, useContext, type ReactNode } from "react"

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal chat session info needed by context consumers
 */
export interface ChatSession {
  id: string
  name?: string
}

/**
 * Minimal message info needed by context consumers
 */
export interface ChatMessage {
  id: string
  content: string
  role?: "user" | "assistant"
}

/**
 * Context value interface for chat state
 *
 * Provides all state and actions needed by chat UI components:
 * - currentSession: The active chat session (null if none)
 * - messages: Array of messages in the current session
 * - sendMessage: Function to send a new message
 * - isLoading: Whether a message is currently being processed
 * - error: Current error state (null if none)
 */
export interface ChatContextValue {
  /** The currently active chat session, or null if none exists */
  currentSession: ChatSession | null

  /** Messages in the current chat session */
  messages: ChatMessage[]

  /** Send a message to the chat. This triggers the AI response. */
  sendMessage: (content: string) => void

  /** Whether the chat is currently processing a message */
  isLoading: boolean

  /** Current error state, or null if no error */
  error: string | null
}

// ============================================================================
// Context
// ============================================================================

const ChatContext = createContext<ChatContextValue | null>(null)

// ============================================================================
// Provider
// ============================================================================

export interface ChatContextProviderProps {
  /** The context value to provide to children */
  value: ChatContextValue
  /** Child components that will have access to the context */
  children: ReactNode
}

/**
 * Provider component for ChatContext
 *
 * Wraps children with chat context, making state available via useChatContext().
 * The value prop is typically provided by ChatPanel which manages the actual
 * chat state via useChat hook.
 *
 * @example
 * ```tsx
 * <ChatContextProvider value={{ currentSession, messages, sendMessage, isLoading, error }}>
 *   <PhaseContentPanel />
 * </ChatContextProvider>
 * ```
 */
export function ChatContextProvider({ value, children }: ChatContextProviderProps) {
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access chat context value
 *
 * Must be used within a ChatContextProvider. Throws an error if used outside
 * the provider to ensure proper usage.
 *
 * @throws Error if used outside ChatContextProvider
 * @returns ChatContextValue with current session, messages, sendMessage, isLoading, error
 *
 * @example
 * ```tsx
 * function RunPhaseButton() {
 *   const { sendMessage, isLoading } = useChatContext()
 *
 *   const handleRun = () => {
 *     sendMessage(`Execute /discovery skill for feature session ${sessionName}`)
 *   }
 *
 *   return <Button onClick={handleRun} disabled={isLoading}>Run Phase</Button>
 * }
 * ```
 */
export function useChatContext(): ChatContextValue {
  const context = useContext(ChatContext)

  if (!context) {
    throw new Error(
      "useChatContext must be used within a ChatContextProvider. " +
        "Wrap your component tree with <ChatContextProvider> to fix this error."
    )
  }

  return context
}

/**
 * Safe hook to access chat context value without throwing
 *
 * Returns null if used outside ChatContextProvider instead of throwing an error.
 * Useful for components that need graceful fallback when chat context is not available.
 *
 * @returns ChatContextValue or null if used outside provider
 *
 * @example
 * ```tsx
 * function RunPhaseButton({ phaseName, featureName }) {
 *   const chatContext = useChatContextSafe()
 *
 *   // Gracefully disable button when context unavailable
 *   const isDisabled = !chatContext
 *
 *   const handleRun = () => {
 *     if (chatContext) {
 *       chatContext.sendMessage(`Execute /${phaseName} skill for feature session ${featureName}`)
 *     }
 *   }
 *
 *   return <Button onClick={handleRun} disabled={isDisabled}>Run Phase</Button>
 * }
 * ```
 */
export function useChatContextSafe(): ChatContextValue | null {
  return useContext(ChatContext)
}
