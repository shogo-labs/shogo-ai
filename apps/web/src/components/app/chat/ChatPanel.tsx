/**
 * ChatPanel - Smart component that integrates useChat hook with studio-chat domain
 * Tasks: task-2-4-004, task-3-1-004
 *
 * Integrates AI SDK useChat hook for streaming chat, composes child components,
 * handles message persistence to studio-chat domain, and provides chat state to context.
 *
 * Features:
 * - useChat from @ai-sdk/react with /api/chat endpoint
 * - Persists user messages optimistically before sending
 * - Persists assistant messages in onFinish callback
 * - Records tool calls via studioChat.recordToolCall
 * - Auto-creates ChatSession if none exists for feature
 * - Collapse/expand with manual resize
 * - localStorage persistence for collapse state and width
 * - Error display with Retry button
 * - Smart query triggers: Detects tool calls in onFinish and triggers targeted data refreshes (task-3-1-004)
 */

import { useState, useEffect, useRef, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { useChat, type Message } from "@ai-sdk/react"
import { useDomains } from "@/contexts/DomainProvider"
import { cn } from "@/lib/utils"
import { ChatHeader } from "./ChatHeader"
import { MessageList } from "./MessageList"
import { ChatInput } from "./ChatInput"
import { ExpandTab } from "./ExpandTab"
import { ToolCallDisplay, type ToolCallState } from "./ToolCallDisplay"
import { ChatContextProvider, type ChatContextValue } from "./ChatContext"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { AlertCircle } from "lucide-react"

// ============================================================
// Types
// ============================================================

export interface ChatPanelProps {
  /** Feature session ID to link chat with */
  featureId: string | null
  /** Feature session name for display */
  featureName?: string
  /** Children to render inside ChatContextProvider */
  children?: React.ReactNode
  /** Optional class name */
  className?: string
  /** Callback to trigger schema data refetch (for schema.set/schema.load tool calls) */
  onSchemaRefresh?: () => void
  /** Callback to manually trigger a data refresh (from useFeaturePolling) - task-3-1-007 */
  onRefresh?: () => Promise<void>
  /** Callback to notify parent when streaming state changes - task-3-1-007 */
  onStreamingChange?: (isStreaming: boolean) => void
  /** Whether data is being refreshed via polling - task-3-1-008 */
  isPolling?: boolean
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_WIDTH = 400
const MIN_WIDTH = 280
const MAX_WIDTH = 800
const STORAGE_KEY_COLLAPSED = "chat-panel-collapsed"
const STORAGE_KEY_WIDTH = "chat-panel-width"

// ============================================================
// Local Storage Helpers
// ============================================================

function getStoredCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false
  const stored = localStorage.getItem(STORAGE_KEY_COLLAPSED)
  return stored === "true"
}

function setStoredCollapsed(collapsed: boolean): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed))
}

function getStoredWidth(): number {
  if (typeof localStorage === "undefined") return DEFAULT_WIDTH
  const stored = localStorage.getItem(STORAGE_KEY_WIDTH)
  if (!stored) return DEFAULT_WIDTH
  const parsed = parseInt(stored, 10)
  return isNaN(parsed) ? DEFAULT_WIDTH : Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parsed))
}

function setStoredWidth(width: number): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(STORAGE_KEY_WIDTH, String(width))
}

// ============================================================
// Tool Call Extraction Helper
// ============================================================

interface ExtractedToolCall {
  toolName: string
  state: ToolCallState
  args?: Record<string, unknown>
  result?: unknown
  error?: string
}

function extractToolCalls(message: Message): ExtractedToolCall[] {
  // AI SDK 4.2+ uses message.parts for tool invocations
  if (!("parts" in message) || !Array.isArray((message as any).parts)) {
    return []
  }

  return ((message as any).parts as any[])
    .filter((part) => part.type === "tool-invocation")
    .map((part) => {
      const invocation = part.toolInvocation
      return {
        toolName: invocation?.toolName || "unknown",
        state: mapToolCallState(invocation?.state),
        args: invocation?.args,
        result: invocation?.result,
        error: invocation?.error,
      }
    })
}

function mapToolCallState(state: string | undefined): ToolCallState {
  switch (state) {
    case "partial-call":
      return "input-streaming"
    case "call":
      return "input-available"
    case "result":
      return "output-available"
    case "error":
      return "output-error"
    default:
      return "input-streaming"
  }
}

// ============================================================
// Smart Query Trigger Mapping (task-3-1-004)
// ============================================================

/**
 * Maps model names from store.create tool calls to collection names for refresh.
 * Per design-3-1-003: store.create with specific models triggers that collection refresh.
 */
const MODEL_TO_COLLECTION_MAP: Record<string, string> = {
  // Core feature entities
  Requirement: "requirementCollection",
  AnalysisFinding: "analysisFindingCollection",
  DesignDecision: "designDecisionCollection",
  ImplementationTask: "implementationTaskCollection",
  TestSpecification: "testSpecificationCollection",
  // Implementation phase entities
  ImplementationRun: "implementationRunCollection",
  TaskExecution: "taskExecutionCollection",
  // Feature session
  FeatureSession: "featureSessionCollection",
}

/**
 * Determines which collections to refresh based on a tool call.
 * Returns collection names that should be refreshed via query().toArray().
 *
 * @param toolCall - Extracted tool call from AI message
 * @returns Array of collection names to refresh
 */
function getCollectionsToRefresh(toolCall: ExtractedToolCall): string[] {
  const { toolName, args } = toolCall
  const collections: string[] = []

  // Handle MCP tool naming: "mcp__wavesmith__store_create" -> "store_create"
  const normalizedToolName = toolName.includes("__")
    ? toolName.split("__").pop() || toolName
    : toolName

  switch (normalizedToolName) {
    case "store_create": {
      // store.create with model -> refresh that collection
      const model = args?.model as string | undefined
      if (model && MODEL_TO_COLLECTION_MAP[model]) {
        collections.push(MODEL_TO_COLLECTION_MAP[model])
      }
      break
    }

    case "store_update": {
      // store.update with model -> refresh that collection
      const model = args?.model as string | undefined
      if (model && MODEL_TO_COLLECTION_MAP[model]) {
        collections.push(MODEL_TO_COLLECTION_MAP[model])
      }
      break
    }

    case "store_delete": {
      // store.delete with model -> refresh that collection
      const model = args?.model as string | undefined
      if (model && MODEL_TO_COLLECTION_MAP[model]) {
        collections.push(MODEL_TO_COLLECTION_MAP[model])
      }
      break
    }

    // Note: schema_set and schema_load are handled separately via onSchemaRefresh callback
    default:
      break
  }

  return collections
}

/**
 * Checks if a tool call requires schema refresh.
 * Schema operations (schema.set, schema.load) need to trigger useSchemaData refetch.
 */
function requiresSchemaRefresh(toolCall: ExtractedToolCall): boolean {
  const { toolName } = toolCall

  // Handle MCP tool naming
  const normalizedToolName = toolName.includes("__")
    ? toolName.split("__").pop() || toolName
    : toolName

  return normalizedToolName === "schema_set" || normalizedToolName === "schema_load"
}

/**
 * Triggers collection refreshes for the given collection names.
 * Uses same query().toArray() pattern as useFeaturePolling for consistency.
 */
async function refreshCollections(
  platformFeatures: any,
  collectionNames: string[]
): Promise<void> {
  if (!platformFeatures || collectionNames.length === 0) {
    return
  }

  // Deduplicate collection names
  const uniqueCollections = [...new Set(collectionNames)]

  // Refresh all collections in parallel
  const refreshPromises = uniqueCollections.map(async (collectionName) => {
    const collection = platformFeatures[collectionName]
    if (collection?.query && typeof collection.query === "function") {
      try {
        await collection.query().toArray()
      } catch (err) {
        console.warn(`[ChatPanel] Failed to refresh ${collectionName}:`, err)
      }
    }
  })

  await Promise.all(refreshPromises)
}

// ============================================================
// Component
// ============================================================

export const ChatPanel = observer(function ChatPanel({
  featureId,
  featureName,
  children,
  className,
  onSchemaRefresh,
  onRefresh,
  onStreamingChange,
  isPolling,
}: ChatPanelProps) {
  // Access domains for chat persistence and smart refresh
  const { studioChat, platformFeatures } = useDomains<{
    studioChat: any
    platformFeatures: any
  }>()

  // Panel state
  const [isCollapsed, setIsCollapsed] = useState(() => getStoredCollapsed())
  const [width, setWidth] = useState(() => getStoredWidth())
  const [isResizing, setIsResizing] = useState(false)
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // Chat session state
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)

  // Find or create chat session for feature
  useEffect(() => {
    if (!featureId) {
      setCurrentSessionId(null)
      return
    }

    // Find existing session for this feature
    const sessions = studioChat.chatSessionCollection.findByFeature?.(featureId) ?? []
    if (sessions.length > 0) {
      setCurrentSessionId(sessions[0].id)
    } else {
      // Auto-create session
      const newSession = studioChat.createChatSession({
        inferredName: featureName || `Chat for ${featureId}`,
        contextType: "feature",
        contextId: featureId,
      })
      setCurrentSessionId(newSession.id)
    }
  }, [featureId, featureName, studioChat])

  // Get current session
  const currentSession = currentSessionId
    ? studioChat.chatSessionCollection.get(currentSessionId)
    : null

  // AI SDK useChat hook
  const {
    messages,
    input,
    setInput,
    handleSubmit: useChatHandleSubmit,
    isLoading,
    error,
    setMessages,
    reload,
  } = useChat({
    api: "/api/chat",
    id: currentSessionId || undefined,
    streamProtocol: "text",
    onFinish: async (message) => {
      // Persist assistant message in onFinish callback
      if (currentSessionId) {
        studioChat.addMessage({
          sessionId: currentSessionId,
          role: "assistant",
          content: message.content,
        })

        // Record tool calls from the message
        const toolCalls = extractToolCalls(message)
        for (const toolCall of toolCalls) {
          studioChat.recordToolCall({
            sessionId: currentSessionId,
            toolName: toolCall.toolName,
            status: toolCall.state === "output-available" ? "complete" :
                    toolCall.state === "output-error" ? "error" : "executing",
            args: toolCall.args || {},
            result: toolCall.result,
          })
        }

        // Smart Query Triggers (task-3-1-004)
        // After streaming completes, detect tool calls and trigger targeted data refreshes
        if (toolCalls.length > 0) {
          // Collect all collections that need refreshing
          const collectionsToRefresh: string[] = []
          let needsSchemaRefresh = false

          for (const toolCall of toolCalls) {
            // Only process successful tool calls
            if (toolCall.state !== "output-available") {
              continue
            }

            // Check for schema refresh needs
            if (requiresSchemaRefresh(toolCall)) {
              needsSchemaRefresh = true
            }

            // Collect collections to refresh
            const collections = getCollectionsToRefresh(toolCall)
            collectionsToRefresh.push(...collections)
          }

          // Trigger schema refresh if needed (via callback prop)
          if (needsSchemaRefresh && onSchemaRefresh) {
            onSchemaRefresh()
          }

          // Trigger collection refreshes in parallel
          if (collectionsToRefresh.length > 0) {
            refreshCollections(platformFeatures, collectionsToRefresh).catch((err) => {
              console.warn("[ChatPanel] Smart refresh failed:", err)
            })
          }

          // Also trigger full refresh via onRefresh callback (task-3-1-007)
          // This ensures all collections are refreshed after tool calls complete
          if (onRefresh) {
            // Small delay to let smart triggers complete first
            setTimeout(() => {
              onRefresh().catch((err) => {
                console.warn("[ChatPanel] onRefresh callback failed:", err)
              })
            }, 500)
          }
        }
      }
    },
  })

  // Load persisted messages when session changes
  useEffect(() => {
    if (currentSessionId) {
      const persistedMessages = studioChat.chatMessageCollection.findBySession?.(currentSessionId) ?? []
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
    } else {
      setMessages([])
    }
  }, [currentSessionId, studioChat.chatMessageCollection, setMessages])

  // Notify parent of streaming state changes (task-3-1-007)
  // This allows WorkspaceLayout to pause polling during active streaming
  useEffect(() => {
    onStreamingChange?.(isLoading)
  }, [isLoading, onStreamingChange])

  // Handle message submission
  const handleSendMessage = useCallback(
    (content: string) => {
      if (!currentSessionId || !content.trim()) return

      // Persist user message BEFORE calling handleSubmit (optimistic)
      studioChat.addMessage({
        sessionId: currentSessionId,
        role: "user",
        content: content.trim(),
      })

      // Set input and submit
      setInput(content)
      // Trigger submit via form event simulation
      const form = document.createElement("form")
      const event = new Event("submit", { bubbles: true, cancelable: true })
      Object.defineProperty(event, "preventDefault", { value: () => {} })
      useChatHandleSubmit(event as any)
    },
    [currentSessionId, studioChat, setInput, useChatHandleSubmit]
  )

  // Handle form submit from ChatInput
  const handleInputSubmit = useCallback(
    (content: string) => {
      handleSendMessage(content)
    },
    [handleSendMessage]
  )

  // Collapse toggle
  const handleToggleCollapse = useCallback(() => {
    const newCollapsed = !isCollapsed
    setIsCollapsed(newCollapsed)
    setStoredCollapsed(newCollapsed)
  }, [isCollapsed])

  // Resize handlers using mousedown/mousemove/mouseup pattern
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizing(true)
      resizeRef.current = {
        startX: e.clientX,
        startWidth: width,
      }

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!resizeRef.current) return
        const delta = resizeRef.current.startX - moveEvent.clientX
        const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resizeRef.current.startWidth + delta))
        setWidth(newWidth)
      }

      const handleMouseUp = () => {
        setIsResizing(false)
        if (resizeRef.current) {
          const delta = resizeRef.current.startX - (window as any).lastMouseX || 0
          const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resizeRef.current.startWidth + delta))
          setStoredWidth(finalWidth)
        }
        resizeRef.current = null
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
      }

      // Track last mouse X for final width calculation
      const trackMouseMove = (moveEvent: MouseEvent) => {
        ;(window as any).lastMouseX = moveEvent.clientX
        handleMouseMove(moveEvent)
      }

      document.addEventListener("mousemove", trackMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    },
    [width]
  )

  // Error retry handler
  const handleRetry = useCallback(() => {
    reload()
  }, [reload])

  // Convert messages for MessageList
  const messageListMessages = messages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }))

  // Context value for ChatContextProvider
  const contextValue: ChatContextValue = {
    currentSession: currentSession
      ? { id: currentSession.id, name: currentSession.name }
      : null,
    messages: messageListMessages,
    sendMessage: handleSendMessage,
    isLoading,
    isPolling, // task-3-1-008: Pass polling state to context for LoadingOverlay
    error: error?.message ?? null,
  }

  // Render collapsed state
  if (isCollapsed) {
    return (
      <div className={cn("flex h-full", className)}>
        {/* Children take remaining space when collapsed */}
        {children && (
          <ChatContextProvider value={contextValue}>
            <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
          </ChatContextProvider>
        )}
        <ExpandTab onExpand={handleToggleCollapse} />
      </div>
    )
  }

  // Extract tool calls from all messages for inline display
  const messagesWithToolCalls = messages.map((msg) => ({
    message: msg,
    toolCalls: extractToolCalls(msg),
  }))

  return (
    <div className={cn("flex h-full", className)}>
      {/* Main content with ChatContextProvider */}
      {children && (
        <ChatContextProvider value={contextValue}>
          <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
        </ChatContextProvider>
      )}

      {/* Chat Panel - shrink-0 prevents flexbox from shrinking below specified width */}
      <div
        className="flex flex-col border-l border-border bg-background relative shrink-0"
        style={{ width: `${width}px` }}
      >
        {/* Resize Handle */}
        <div
          className={cn(
            "absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-primary/50 transition-colors",
            isResizing && "bg-primary/50"
          )}
          onMouseDown={handleResizeMouseDown}
        />

        {/* Header */}
        <ChatHeader
          sessionName={currentSession?.name || featureName || "Chat"}
          isLoading={isLoading}
          isCollapsed={isCollapsed}
          onToggleCollapse={handleToggleCollapse}
        />

        {/* Messages with Tool Calls */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messagesWithToolCalls.map(({ message, toolCalls }) => (
            <div key={message.id} className="space-y-2">
              {/* Message content via MessageList item pattern */}
              <div
                className={cn(
                  "flex w-full",
                  message.role === "user" ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "max-w-[80%] rounded-lg px-4 py-2 text-sm",
                    message.role === "user"
                      ? "bg-primary text-primary-foreground ml-auto"
                      : "bg-muted text-foreground mr-auto"
                  )}
                >
                  <div className="whitespace-pre-wrap break-words">{message.content}</div>
                </div>
              </div>

              {/* Inline Tool Call Displays */}
              {toolCalls.map((toolCall, index) => (
                <ToolCallDisplay
                  key={`${message.id}-tool-${index}`}
                  toolName={toolCall.toolName}
                  state={toolCall.state}
                  args={toolCall.args}
                  result={toolCall.result}
                  error={toolCall.error}
                />
              ))}
            </div>
          ))}

          {/* Empty state */}
          {messages.length === 0 && !isLoading && (
            <div className="flex flex-1 flex-col items-center justify-center text-center text-muted-foreground py-8">
              <p className="text-sm">No messages yet</p>
              <p className="text-xs mt-1">Start a conversation</p>
            </div>
          )}

          {/* Loading indicator */}
          {isLoading && (
            <div
              data-testid="loading-indicator"
              aria-label="Loading response"
              aria-busy="true"
              className="flex items-center gap-1 p-2"
            >
              <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse" />
              <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse [animation-delay:0.2s]" />
              <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse [animation-delay:0.4s]" />
            </div>
          )}
        </div>

        {/* Error Alert */}
        {error && (
          <div className="px-4 pb-2">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between gap-2">
                <span className="text-sm">{error.message}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetry}
                  className="shrink-0"
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Input */}
        <ChatInput
          onSubmit={handleInputSubmit}
          disabled={isLoading || !currentSessionId}
          placeholder={!featureId ? "Select a feature to start chatting..." : "Type a message..."}
        />
      </div>
    </div>
  )
})
