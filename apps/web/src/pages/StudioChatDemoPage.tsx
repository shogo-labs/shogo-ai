/**
 * StudioChatDemoPage - Proof of work page for Studio Chat domain feature
 *
 * Demonstrates complete studio chat functionality:
 * - ChatSession CRUD with context type validation (feature/project/general)
 * - ChatMessage creation with session reference
 * - ToolCallLog recording with status tracking
 * - Computed views: messageCount, latestMessage, toolCallCount
 * - Collection queries: findByFeature, findByContextType, findBySession, findByStatus
 * - Context type polymorphism validation
 * - Data persistence across page refresh
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "../contexts/DomainProvider"

// Styles
const containerStyle = {
  maxWidth: "1200px",
  margin: "2rem auto",
  padding: "2rem",
  background: "#1e1e1e",
  borderRadius: "8px",
  color: "white",
}

const sectionStyle = {
  marginBottom: "2rem",
  padding: "1.5rem",
  background: "#2a2a2a",
  borderRadius: "8px",
}

const formStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1rem",
}

const inputGroupStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
}

const labelStyle = {
  fontSize: "0.9rem",
  fontWeight: "bold" as const,
}

const inputStyle = {
  padding: "0.75rem",
  borderRadius: "4px",
  border: "1px solid #444",
  background: "#333",
  color: "white",
  fontSize: "1rem",
}

const selectStyle = {
  ...inputStyle,
  cursor: "pointer",
}

const buttonStyle = {
  padding: "0.75rem 1.5rem",
  borderRadius: "4px",
  border: "none",
  background: "#2196f3",
  color: "white",
  fontSize: "1rem",
  fontWeight: "bold" as const,
  cursor: "pointer",
}

const secondaryButtonStyle = {
  ...buttonStyle,
  background: "#666",
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

const listItemStyle = {
  padding: "0.75rem",
  background: "#333",
  borderRadius: "4px",
  marginBottom: "0.5rem",
}

const twoColumnStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "1rem",
}

export const StudioChatDemoPage = observer(function StudioChatDemoPage() {
  const { studioChat } = useDomains()

  // Form state
  const [sessionName, setSessionName] = useState("")
  const [contextType, setContextType] = useState<string>("general")
  const [contextId, setContextId] = useState("")
  const [selectedSessionId, setSelectedSessionId] = useState<string>("")
  const [messageRole, setMessageRole] = useState<string>("user")
  const [messageContent, setMessageContent] = useState("")
  const [toolName, setToolName] = useState("")
  const [toolStatus, setToolStatus] = useState<string>("executing")
  const [toolArgs, setToolArgs] = useState("{}")
  const [queryContextType, setQueryContextType] = useState<string>("feature")
  const [queryFeatureId, setQueryFeatureId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Data from store
  const sessions = studioChat?.chatSessionCollection?.all() || []
  const messages = studioChat?.chatMessageCollection?.all() || []
  const toolCalls = studioChat?.toolCallLogCollection?.all() || []

  // Clear messages after a delay
  const showMessage = (type: "error" | "success", message: string) => {
    if (type === "error") {
      setError(message)
      setSuccess(null)
      setTimeout(() => setError(null), 5000)
    } else {
      setSuccess(message)
      setError(null)
      setTimeout(() => setSuccess(null), 5000)
    }
  }

  // Create chat session
  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const newSession = studioChat.createChatSession({
        inferredName: sessionName || `Chat ${Date.now()}`,
        name: sessionName || undefined,
        contextType: contextType as "feature" | "project" | "general",
        contextId: contextType !== "general" ? contextId : undefined,
      })
      showMessage("success", `Created session: ${newSession.inferredName}`)
      setSessionName("")
      setContextId("")
      setSelectedSessionId(newSession.id)
    } catch (err: any) {
      showMessage("error", err.message || "Failed to create session")
    }
  }

  // Add message
  const handleAddMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedSessionId) {
      showMessage("error", "Please select a session")
      return
    }
    try {
      const message = studioChat.addMessage({
        sessionId: selectedSessionId,
        role: messageRole as "user" | "assistant",
        content: messageContent,
      })
      showMessage("success", `Added message: ${message.content.slice(0, 30)}...`)
      setMessageContent("")
    } catch (err: any) {
      showMessage("error", err.message || "Failed to add message")
    }
  }

  // Record tool call
  const handleRecordToolCall = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedSessionId) {
      showMessage("error", "Please select a session")
      return
    }
    try {
      let parsedArgs = {}
      try {
        parsedArgs = JSON.parse(toolArgs)
      } catch {
        parsedArgs = {}
      }

      const toolCall = studioChat.recordToolCall({
        sessionId: selectedSessionId,
        toolName,
        status: toolStatus as "streaming" | "executing" | "complete" | "error",
        args: parsedArgs,
      })
      showMessage("success", `Recorded tool call: ${toolCall.toolName}`)
      setToolName("")
      setToolArgs("{}")
    } catch (err: any) {
      showMessage("error", err.message || "Failed to record tool call")
    }
  }

  // Test validation - feature without contextId
  const handleTestValidation = () => {
    try {
      studioChat.createChatSession({
        inferredName: "Test Session",
        contextType: "feature",
        // Missing contextId - should fail
      })
      showMessage("error", "Validation should have failed!")
    } catch (err: any) {
      showMessage("success", `Validation working: ${err.message}`)
    }
  }

  // Get selected session
  const selectedSession = selectedSessionId
    ? studioChat?.chatSessionCollection?.get(selectedSessionId)
    : null

  return (
    <div style={containerStyle}>
      <h1>Studio Chat Demo</h1>
      <p style={{ color: "#888", marginBottom: "2rem" }}>
        Demonstrates ChatSession, ChatMessage, and ToolCallLog with computed views,
        collection queries, and context type validation.
      </p>

      {error && <div style={errorStyle} data-testid="error-message">{error}</div>}
      {success && <div style={successStyle} data-testid="success-message">{success}</div>}

      {/* Chat Sessions */}
      <div style={sectionStyle} data-testid="sessions-section">
        <h2>Chat Sessions ({sessions.length})</h2>

        <form onSubmit={handleCreateSession} style={formStyle}>
          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="session-name" style={labelStyle}>Session Name (optional)</label>
              <input
                id="session-name"
                type="text"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                style={inputStyle}
                placeholder="My Chat Session"
              />
            </div>

            <div style={inputGroupStyle}>
              <label htmlFor="context-type" style={labelStyle}>Context Type</label>
              <select
                id="context-type"
                value={contextType}
                onChange={(e) => setContextType(e.target.value)}
                style={selectStyle}
              >
                <option value="general">General</option>
                <option value="feature">Feature</option>
                <option value="project">Project</option>
              </select>
            </div>
          </div>

          {contextType !== "general" && (
            <div style={inputGroupStyle}>
              <label htmlFor="context-id" style={labelStyle}>Context ID (required for {contextType})</label>
              <input
                id="context-id"
                type="text"
                value={contextId}
                onChange={(e) => setContextId(e.target.value)}
                style={inputStyle}
                placeholder={`Enter ${contextType} ID`}
                required
              />
            </div>
          )}

          <div style={{ display: "flex", gap: "1rem" }}>
            <button type="submit" style={buttonStyle}>Create Session</button>
            <button type="button" onClick={handleTestValidation} style={secondaryButtonStyle}>
              Test Validation
            </button>
          </div>
        </form>

        {sessions.length > 0 && (
          <div style={{ marginTop: "1.5rem" }}>
            <h3>Existing Sessions</h3>
            {sessions.map((session: any) => (
              <div
                key={session.id}
                style={{
                  ...listItemStyle,
                  border: selectedSessionId === session.id ? "2px solid #2196f3" : "none",
                  cursor: "pointer",
                }}
                onClick={() => setSelectedSessionId(session.id)}
              >
                <div>
                  <strong>{session.name || session.inferredName}</strong>
                  <div style={{ fontSize: "0.85rem", color: "#999" }}>
                    Type: {session.contextType}
                    {session.contextId && ` | Context: ${session.contextId.slice(0, 8)}...`}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "#4caf50" }}>
                    Messages: {session.messageCount} |
                    Tool Calls: {session.toolCallCount}
                    {session.latestMessage && ` | Latest: "${session.latestMessage.content.slice(0, 20)}..."`}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#666" }}>ID: {session.id.slice(0, 8)}...</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Messages (requires selected session) */}
      {selectedSession && (
        <div style={sectionStyle} data-testid="messages-section">
          <h2>Messages for: {selectedSession.name || selectedSession.inferredName}</h2>

          <form onSubmit={handleAddMessage} style={formStyle}>
            <div style={twoColumnStyle}>
              <div style={inputGroupStyle}>
                <label htmlFor="message-role" style={labelStyle}>Role</label>
                <select
                  id="message-role"
                  value={messageRole}
                  onChange={(e) => setMessageRole(e.target.value)}
                  style={selectStyle}
                >
                  <option value="user">User</option>
                  <option value="assistant">Assistant</option>
                </select>
              </div>

              <div style={inputGroupStyle}>
                <label htmlFor="message-content" style={labelStyle}>Content</label>
                <input
                  id="message-content"
                  type="text"
                  value={messageContent}
                  onChange={(e) => setMessageContent(e.target.value)}
                  style={inputStyle}
                  placeholder="Type a message..."
                  required
                />
              </div>
            </div>

            <button type="submit" style={buttonStyle}>Add Message</button>
          </form>

          <div style={{ marginTop: "1.5rem" }}>
            <h3>Session Messages ({studioChat.chatMessageCollection.findBySession(selectedSessionId).length})</h3>
            {studioChat.chatMessageCollection.findBySession(selectedSessionId).map((msg: any) => (
              <div key={msg.id} style={listItemStyle}>
                <strong style={{ color: msg.role === "user" ? "#64b5f6" : "#81c784" }}>
                  {msg.role}:
                </strong>{" "}
                {msg.content}
                <div style={{ fontSize: "0.75rem", color: "#666" }}>
                  {new Date(msg.createdAt).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool Calls (requires selected session) */}
      {selectedSession && (
        <div style={sectionStyle} data-testid="tool-calls-section">
          <h2>Tool Calls</h2>

          <form onSubmit={handleRecordToolCall} style={formStyle}>
            <div style={twoColumnStyle}>
              <div style={inputGroupStyle}>
                <label htmlFor="tool-name" style={labelStyle}>Tool Name</label>
                <input
                  id="tool-name"
                  type="text"
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  style={inputStyle}
                  placeholder="store.create"
                  required
                />
              </div>

              <div style={inputGroupStyle}>
                <label htmlFor="tool-status" style={labelStyle}>Status</label>
                <select
                  id="tool-status"
                  value={toolStatus}
                  onChange={(e) => setToolStatus(e.target.value)}
                  style={selectStyle}
                >
                  <option value="streaming">Streaming</option>
                  <option value="executing">Executing</option>
                  <option value="complete">Complete</option>
                  <option value="error">Error</option>
                </select>
              </div>
            </div>

            <div style={inputGroupStyle}>
              <label htmlFor="tool-args" style={labelStyle}>Args (JSON)</label>
              <input
                id="tool-args"
                type="text"
                value={toolArgs}
                onChange={(e) => setToolArgs(e.target.value)}
                style={inputStyle}
                placeholder='{"model": "User"}'
              />
            </div>

            <button type="submit" style={buttonStyle}>Record Tool Call</button>
          </form>

          <div style={{ marginTop: "1.5rem" }}>
            <h3>All Tool Calls ({toolCalls.length})</h3>
            {toolCalls.map((tc: any) => (
              <div key={tc.id} style={listItemStyle}>
                <strong>{tc.toolName}</strong>
                <span
                  style={{
                    marginLeft: "1rem",
                    padding: "0.25rem 0.5rem",
                    borderRadius: "4px",
                    background:
                      tc.status === "complete"
                        ? "#4caf50"
                        : tc.status === "error"
                        ? "#f44336"
                        : "#ff9800",
                    fontSize: "0.85rem",
                  }}
                >
                  {tc.status}
                </span>
                <div style={{ fontSize: "0.85rem", color: "#999" }}>
                  Session: {tc.chatSession?.inferredName || tc.chatSession?.id?.slice(0, 8)}...
                </div>
                <div style={{ fontSize: "0.75rem", color: "#666" }}>
                  Args: {JSON.stringify(tc.args)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Collection Queries */}
      <div style={sectionStyle} data-testid="queries-section">
        <h2>Collection Queries</h2>

        <div style={formStyle}>
          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="query-context-type" style={labelStyle}>Find by Context Type</label>
              <select
                id="query-context-type"
                value={queryContextType}
                onChange={(e) => setQueryContextType(e.target.value)}
                style={selectStyle}
              >
                <option value="feature">Feature</option>
                <option value="project">Project</option>
                <option value="general">General</option>
              </select>
            </div>

            <div style={inputGroupStyle}>
              <label style={labelStyle}>Results</label>
              <div style={{ padding: "0.75rem", background: "#333", borderRadius: "4px" }}>
                {studioChat?.chatSessionCollection?.findByContextType(queryContextType as any)?.length || 0} sessions
              </div>
            </div>
          </div>

          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="query-feature-id" style={labelStyle}>Find by Feature ID</label>
              <input
                id="query-feature-id"
                type="text"
                value={queryFeatureId}
                onChange={(e) => setQueryFeatureId(e.target.value)}
                style={inputStyle}
                placeholder="feature-123"
              />
            </div>

            <div style={inputGroupStyle}>
              <label style={labelStyle}>Results</label>
              <div style={{ padding: "0.75rem", background: "#333", borderRadius: "4px" }}>
                {queryFeatureId
                  ? `${studioChat?.chatSessionCollection?.findByFeature(queryFeatureId)?.length || 0} sessions`
                  : "Enter feature ID"}
              </div>
            </div>
          </div>

          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label style={labelStyle}>Tool Calls by Status: error</label>
              <div style={{ padding: "0.75rem", background: "#333", borderRadius: "4px" }}>
                {studioChat?.toolCallLogCollection?.findByStatus("error")?.length || 0} tool calls
              </div>
            </div>

            <div style={inputGroupStyle}>
              <label style={labelStyle}>Tool Calls by Status: complete</label>
              <div style={{ padding: "0.75rem", background: "#333", borderRadius: "4px" }}>
                {studioChat?.toolCallLogCollection?.findByStatus("complete")?.length || 0} tool calls
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})
