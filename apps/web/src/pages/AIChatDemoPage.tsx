/**
 * AIChatDemoPage - AI Chat Demo using Vercel AI SDK
 *
 * Demonstrates:
 * - Streaming chat responses using @ai-sdk/react useChat hook
 * - Creating new ChatSession via domain actions
 * - ChatMessage list with role indicators (user/assistant)
 * - Real-time streaming text display
 * - MCPPersistence for client-side persistence
 * - Data survives page refresh (proves persistence pipeline)
 */

import { useState, useEffect, useRef } from "react"
import { observer } from "mobx-react-lite"
import { useChat } from "@ai-sdk/react"
import { useDomains } from "../contexts/DomainProvider"

// Styles
const containerStyle = {
  maxWidth: "1200px",
  margin: "2rem auto",
  padding: "2rem",
  background: "#1e1e1e",
  borderRadius: "8px",
  color: "white",
  display: "flex",
  gap: "1rem",
  height: "calc(100vh - 200px)",
}

const panelStyle = {
  flex: 1,
  display: "flex",
  flexDirection: "column" as const,
  background: "#2a2a2a",
  borderRadius: "8px",
  overflow: "hidden",
}

const panelHeaderStyle = {
  padding: "1rem",
  background: "#3a3a3a",
  fontWeight: "bold" as const,
  borderBottom: "1px solid #444",
}

const buttonStyle = {
  padding: "0.5rem 1rem",
  borderRadius: "4px",
  border: "none",
  background: "#2196f3",
  color: "white",
  fontSize: "0.9rem",
  fontWeight: "bold" as const,
  cursor: "pointer",
}

const inputStyle = {
  padding: "0.75rem",
  borderRadius: "4px",
  border: "1px solid #444",
  background: "#333",
  color: "white",
  fontSize: "1rem",
  width: "100%",
  resize: "none" as const,
  minHeight: "80px",
  fontFamily: "inherit",
}

const messageStyle = {
  padding: "0.75rem",
  background: "#333",
  borderRadius: "4px",
  marginBottom: "0.5rem",
}

const listItemStyle = {
  padding: "0.75rem",
  background: "#333",
  borderRadius: "4px",
  marginBottom: "0.5rem",
  cursor: "pointer",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
}

const errorStyle = {
  padding: "0.75rem",
  borderRadius: "4px",
  background: "#ff5252",
  color: "white",
  marginBottom: "1rem",
}

const successStyle = {
  padding: "0.75rem",
  borderRadius: "4px",
  background: "#4caf50",
  color: "white",
  marginBottom: "1rem",
}

export const AIChatDemoPage = observer(function AIChatDemoPage() {
  const { chat } = useDomains()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Local state
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [newSessionName, setNewSessionName] = useState("")
  const [localError, setLocalError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Data from store
  const sessions = chat.chatSessionCollection.all()
  const selectedSession = selectedSessionId
    ? chat.chatSessionCollection.get(selectedSessionId)
    : null
  const artifacts = selectedSessionId
    ? chat.createdArtifactCollection.findBySession(selectedSessionId)
    : []

  // AI SDK useChat hook - provides streaming chat functionality
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
    id: selectedSessionId || undefined,
    streamProtocol: "text", // Use text stream protocol to match server's toTextStreamResponse()
    onFinish: async (message) => {
      // Persist the assistant message to domain store
      if (selectedSessionId) {
        const assistantMessage = chat.addMessage({
          sessionId: selectedSessionId,
          role: "assistant",
          content: message.content,
        })
        await chat.chatMessageCollection.saveOne(assistantMessage.id)
      }
    },
    onError: (error) => {
      console.error("[AIChatDemoPage] Chat error:", error)
    },
  })

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Auto-select first session if none selected
  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0].id)
    }
  }, [sessions, selectedSessionId])

  // Load persisted messages when session changes
  useEffect(() => {
    if (selectedSessionId) {
      const persistedMessages = chat.chatMessageCollection.findBySession(selectedSessionId)
      if (persistedMessages.length > 0) {
        // Convert domain messages to AI SDK format
        const aiMessages = persistedMessages.map((msg: any) => ({
          id: msg.id,
          role: msg.role as "user" | "assistant",
          content: msg.content,
        }))
        setMessages(aiMessages)
      } else {
        setMessages([])
      }
    }
  }, [selectedSessionId, chat.chatMessageCollection, setMessages])

  // Create new chat session
  const handleCreateSession = async () => {
    setLocalError(null)
    setSuccess(null)

    if (!newSessionName.trim()) {
      setLocalError("Session name cannot be empty")
      return
    }

    try {
      const session = chat.createChatSession({ name: newSessionName.trim() })
      await chat.chatSessionCollection.saveOne(session.id)
      setNewSessionName("")
      setSelectedSessionId(session.id)
      setMessages([]) // Clear AI SDK messages for new session
      setSuccess(`Created session: ${session.name}`)
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: any) {
      setLocalError(err.message || "Failed to create session")
    }
  }

  // Handle form submission - persist user message then let AI SDK handle the rest
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedSessionId || !input.trim() || isLoading) return

    setLocalError(null)

    // Persist user message to domain store
    const userMessage = chat.addMessage({
      sessionId: selectedSessionId,
      role: "user",
      content: input.trim(),
    })
    await chat.chatMessageCollection.saveOne(userMessage.id)

    // Let AI SDK handle the submission (it will stream the response)
    handleSubmit(e)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleFormSubmit(e as any)
    }
  }

  const displayError = localError || chatError?.message

  return (
    <div style={containerStyle}>
      {/* Left Panel: Sessions */}
      <div style={{ ...panelStyle, flex: "0 0 300px" }}>
        <div style={panelHeaderStyle}>Chat Sessions</div>

        <div style={{ padding: "1rem", flex: 1, overflowY: "auto" }}>
          {displayError && <div style={errorStyle} data-testid="error-message">{displayError}</div>}
          {success && <div style={successStyle} data-testid="success-message">{success}</div>}

          {/* Create session form */}
          <div style={{ marginBottom: "1rem" }}>
            <input
              type="text"
              value={newSessionName}
              onChange={(e) => setNewSessionName(e.target.value)}
              placeholder="New session name..."
              style={{ ...inputStyle, minHeight: "auto" }}
              data-testid="session-name-input"
            />
            <button
              onClick={handleCreateSession}
              style={{ ...buttonStyle, marginTop: "0.5rem", width: "100%" }}
              data-testid="create-session-button"
            >
              Create Session
            </button>
          </div>

          {/* Session list */}
          <div data-testid="sessions-list">
            {sessions.length === 0 ? (
              <p style={{ color: "#888", fontSize: "0.9rem" }}>
                No sessions yet. Create one above.
              </p>
            ) : (
              sessions.map((session: any) => (
                <div
                  key={session.id}
                  style={{
                    ...listItemStyle,
                    background: selectedSessionId === session.id ? "#2196f3" : "#333",
                  }}
                  onClick={() => setSelectedSessionId(session.id)}
                  data-testid={`session-${session.id}`}
                >
                  <div>
                    <div style={{ fontWeight: "bold" }}>{session.name}</div>
                    <div style={{ fontSize: "0.8rem", color: "#888" }}>
                      {session.messageCount || 0} messages
                      {session.artifactCount > 0 && ` • ${session.artifactCount} artifacts`}
                    </div>
                  </div>
                  <span style={{
                    padding: "0.25rem 0.5rem",
                    borderRadius: "4px",
                    fontSize: "0.7rem",
                    background: session.status === "active" ? "#4caf50" : "#888",
                  }}>
                    {session.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Middle Panel: Chat */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          {selectedSession ? selectedSession.name : "Select a session"}
          {isLoading && (
            <span style={{ fontSize: "0.8rem", color: "#2196f3", marginLeft: "1rem" }}>
              ● Streaming...
            </span>
          )}
        </div>

        {!selectedSession ? (
          <div style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#888",
          }}>
            Select or create a session to start chatting
          </div>
        ) : (
          <>
            {/* Messages */}
            <div
              style={{ flex: 1, overflowY: "auto", padding: "1rem" }}
              data-testid="messages-list"
            >
              {messages.length === 0 ? (
                <p style={{ color: "#888" }}>No messages yet. Send one below!</p>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} style={messageStyle} data-testid={`message-${msg.role}`}>
                    <div style={{
                      fontSize: "0.8rem",
                      fontWeight: "bold",
                      color: msg.role === "user" ? "#2196f3" : "#4caf50",
                      marginBottom: "0.25rem",
                    }}>
                      {msg.role === "user" ? "You" : "Assistant"}
                    </div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleFormSubmit} style={{ padding: "1rem", borderTop: "1px solid #444" }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your message... (Shift+Enter for new line)"
                style={inputStyle}
                disabled={isLoading}
                data-testid="message-input"
              />
              <button
                type="submit"
                style={{
                  ...buttonStyle,
                  marginTop: "0.5rem",
                  opacity: !input.trim() || isLoading ? 0.5 : 1,
                }}
                disabled={!input.trim() || isLoading}
                data-testid="send-message-button"
              >
                {isLoading ? "Streaming..." : "Send Message"}
              </button>
            </form>
          </>
        )}
      </div>

      {/* Right Panel: Artifacts */}
      <div style={{ ...panelStyle, flex: "0 0 300px" }}>
        <div style={panelHeaderStyle}>Created Artifacts</div>

        <div style={{ padding: "1rem", flex: 1, overflowY: "auto" }} data-testid="artifacts-list">
          {!selectedSession ? (
            <p style={{ color: "#888", fontSize: "0.9rem" }}>
              Select a session to see artifacts
            </p>
          ) : artifacts.length === 0 ? (
            <p style={{ color: "#888", fontSize: "0.9rem" }}>
              No artifacts created yet. Chat with the assistant to generate schemas or entities.
            </p>
          ) : (
            artifacts.map((artifact: any) => (
              <div
                key={artifact.id}
                style={messageStyle}
                data-testid={`artifact-${artifact.artifactType}`}
              >
                <div style={{
                  fontSize: "0.8rem",
                  fontWeight: "bold",
                  color: artifact.artifactType === "schema" ? "#ff9800" : "#9c27b0",
                  marginBottom: "0.25rem",
                }}>
                  {artifact.artifactType.toUpperCase()}
                </div>
                <div style={{ fontWeight: "bold" }}>{artifact.artifactName}</div>
                <div style={{ fontSize: "0.8rem", color: "#aaa", marginTop: "0.25rem" }}>
                  Tool: {artifact.toolName}
                </div>
                <div style={{ fontSize: "0.7rem", color: "#666", marginTop: "0.25rem" }}>
                  {new Date(artifact.createdAt).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
})
