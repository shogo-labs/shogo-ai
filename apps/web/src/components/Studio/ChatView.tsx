/**
 * ChatView - AI SDK chat integrated with feature session
 *
 * Uses @ai-sdk/react useChat hook for streaming conversations.
 * Links ChatSession to FeatureSession for persistence.
 */

import { useState, useEffect, useRef, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { useChat } from "@ai-sdk/react"

interface ChatViewProps {
  feature: any
  chatSession: any | null
  chat: any
}

export const ChatView = observer(function ChatView({
  feature,
  chatSession,
  chat,
}: ChatViewProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(chatSession?.id || null)

  // Create or get chat session linked to feature
  useEffect(() => {
    const ensureSession = async () => {
      if (chatSession) {
        setSessionId(chatSession.id)
        return
      }

      // Check if session exists for this feature
      const existing = chat.chatSessionCollection.findByFeatureSessionId(feature.id)
      if (existing) {
        setSessionId(existing.id)
        return
      }

      // Create new session
      try {
        const newSession = chat.createChatSession({
          name: `Chat: ${feature.name}`,
          featureSessionId: feature.id,
          project: feature.project,
        })
        setSessionId(newSession.id)
      } catch (err: any) {
        setLocalError(err.message || "Failed to create chat session")
      }
    }

    ensureSession()
  }, [feature, chatSession, chat])

  // AI SDK useChat hook
  const {
    messages,
    input,
    setInput,
    handleSubmit,
    isLoading,
    error: chatError,
    setMessages,
  } = useChat({
    api: "/api/chat",
    id: sessionId || undefined,
    streamProtocol: "text",
    onFinish: async (message) => {
      if (sessionId) {
        await chat.chatMessageCollection.insertOne({
          id: crypto.randomUUID(),
          session: sessionId,
          role: "assistant",
          content: message.content,
          createdAt: Date.now(),
        })
      }
    },
    onError: (error) => {
      console.error("[ChatView] Chat error:", error)
    },
  })

  // Load persisted messages when session changes
  useEffect(() => {
    if (!sessionId) return

    const persistedMessages = chat.chatMessageCollection.findBySession(sessionId)
    if (persistedMessages.length > 0) {
      const aiMessages = persistedMessages.map((msg: any) => ({
        id: msg.id,
        role: msg.role as "user" | "assistant",
        content: msg.content,
      }))
      setMessages(aiMessages)
    } else {
      setMessages([])
    }
  }, [sessionId, chat.chatMessageCollection, setMessages])

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Handle form submission
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!sessionId || !input.trim() || isLoading) return

    setLocalError(null)

    // Persist user message
    await chat.chatMessageCollection.insertOne({
      id: crypto.randomUUID(),
      session: sessionId,
      role: "user",
      content: input.trim(),
      createdAt: Date.now(),
    })

    handleSubmit(e)
  }

  // Handle Enter key
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleFormSubmit(e as any)
    }
  }

  const displayError = localError || chatError?.message

  return (
    <div className="chat-view">
      <style>{chatStyles}</style>

      {/* Chat header */}
      <div className="chat-header">
        <h3 className="chat-title">
          Chat: {feature.name}
        </h3>
        {isLoading && (
          <span className="chat-status streaming">Streaming...</span>
        )}
      </div>

      {/* Error display */}
      {displayError && (
        <div className="chat-error">{displayError}</div>
      )}

      {/* Messages */}
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>Start a conversation about this feature.</p>
            <p className="chat-hint">
              Ask questions, request analysis, or discuss implementation details.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`chat-message ${msg.role}`}
            >
              <div className="message-role">
                {msg.role === "user" ? "You" : "Claude"}
              </div>
              <div className="message-content">{msg.content}</div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleFormSubmit} className="chat-input-form">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Claude... (Shift+Enter for new line)"
          className="chat-input"
          disabled={isLoading || !sessionId}
          rows={3}
        />
        <button
          type="submit"
          className="chat-submit"
          disabled={!input.trim() || isLoading || !sessionId}
        >
          {isLoading ? "..." : "Send"}
        </button>
      </form>
    </div>
  )
})

const chatStyles = `
  .chat-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--studio-border);
    background: var(--studio-bg-elevated);
  }

  .chat-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--studio-text);
  }

  .chat-status {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
  }

  .chat-status.streaming {
    background: var(--studio-accent);
    color: white;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .chat-error {
    padding: 0.75rem 1rem;
    background: #ef444420;
    color: #f87171;
    font-size: 0.875rem;
  }

  .chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .chat-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    text-align: center;
    color: var(--studio-text-muted);
  }

  .chat-empty p {
    margin: 0;
  }

  .chat-hint {
    font-size: 0.75rem;
    margin-top: 0.5rem !important;
    opacity: 0.7;
  }

  .chat-message {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    max-width: 85%;
  }

  .chat-message.user {
    background: var(--studio-accent);
    color: white;
    align-self: flex-end;
  }

  .chat-message.assistant {
    background: var(--studio-bg-elevated);
    color: var(--studio-text);
    align-self: flex-start;
    border: 1px solid var(--studio-border);
  }

  .message-role {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
    opacity: 0.7;
  }

  .message-content {
    font-size: 0.875rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .chat-input-form {
    display: flex;
    gap: 0.5rem;
    padding: 1rem;
    border-top: 1px solid var(--studio-border);
    background: var(--studio-bg-elevated);
  }

  .chat-input {
    flex: 1;
    padding: 0.75rem;
    background: var(--studio-bg-card);
    border: 1px solid var(--studio-border);
    border-radius: 8px;
    color: var(--studio-text);
    font-size: 0.875rem;
    font-family: inherit;
    resize: none;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .chat-input:focus {
    border-color: var(--studio-accent);
  }

  .chat-input::placeholder {
    color: var(--studio-text-muted);
  }

  .chat-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .chat-submit {
    padding: 0.75rem 1.5rem;
    background: var(--studio-accent);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s ease;
    align-self: flex-end;
  }

  .chat-submit:hover:not(:disabled) {
    background: var(--studio-accent-hover);
  }

  .chat-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`
